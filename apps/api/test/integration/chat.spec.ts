// =============================================================================
// Chat Integration Tests
// =============================================================================
//
// End-to-end tests for the chat API:
// - SSE streaming responses
// - Conversation persistence
//
// NOTE: These tests require the Durable Object to work, which uses SQLite.
// Due to a known limitation with vitest-pool-workers (SQLITE_AUTH error),
// these tests will be SKIPPED in the test environment.
//
// See: Known Issues in CLAUDE.md

import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import worker, { type Env } from "../../src/index";
import {
  createTestOrg,
  addOrgMember,
  uniqueEmail,
} from "../helpers";

// =============================================================================
// DO Support Detection
// =============================================================================

// Will be set by probe in beforeAll
let doTestsSupported = false;
let skipReason = "";

// Test user state
let testUserCookie = "";
let testUserId = "";
const testOrgId = `chat-test-org-${Date.now()}`;

/**
 * Probes whether Durable Object SQLite is available.
 * Returns true if DO works, false otherwise.
 */
async function probeDOSupport(): Promise<{ supported: boolean; reason: string }> {
  try {
    // Try to create a session - this exercises the auth flow
    const signUpResponse = await worker.fetch(
      new Request("http://localhost/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "DO Probe User",
          email: uniqueEmail("do-probe"),
          password: "SecurePassword123!",
        }),
      }),
      env as unknown as Env
    );

    if (!signUpResponse.ok) {
      return { supported: false, reason: "Auth signup failed" };
    }

    const data = (await signUpResponse.json()) as { user?: { id: string } };
    const setCookie = signUpResponse.headers.get("set-cookie");
    const cookie = setCookie?.split(";")[0] ?? "";

    if (!cookie || !data.user?.id) {
      return { supported: false, reason: "No session cookie returned" };
    }

    // Try a chat request to probe DO
    const chatResponse = await worker.fetch(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
        },
        body: JSON.stringify({
          conversationId: crypto.randomUUID(),
          message: "probe",
        }),
      }),
      env as unknown as Env
    );

    if (chatResponse.status === 500) {
      const body = await chatResponse.text();
      if (body.includes("SQLITE") || body.includes("SqlStorage")) {
        return { supported: false, reason: "DO SQLite not available (SQLITE_AUTH)" };
      }
    }

    if (chatResponse.status === 401 || chatResponse.status === 403) {
      return { supported: false, reason: "Session not working in test env" };
    }

    // Save for use in tests
    testUserCookie = cookie;
    testUserId = data.user.id;

    return { supported: true, reason: "" };
  } catch (error) {
    const msg = String(error);
    if (msg.includes("SQLITE_AUTH") || msg.includes("SqlStorage")) {
      return { supported: false, reason: "DO SQLite not available (SQLITE_AUTH)" };
    }
    return { supported: false, reason: `Probe error: ${msg}` };
  }
}

// =============================================================================
// Test Helpers
// =============================================================================

async function authenticatedPost(
  path: string,
  body: Record<string, unknown>,
  sessionCookie: string
): Promise<Response> {
  return worker.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: sessionCookie,
      },
      body: JSON.stringify(body),
    }),
    env as unknown as Env
  );
}

async function authenticatedGet(
  path: string,
  sessionCookie: string
): Promise<Response> {
  return worker.fetch(
    new Request(`http://localhost${path}`, {
      headers: { Cookie: sessionCookie },
    }),
    env as unknown as Env
  );
}

async function sendChatMessage(
  conversationId: string,
  message: string,
  sessionCookie: string
): Promise<Response> {
  return authenticatedPost("/api/chat", { conversationId, message }, sessionCookie);
}

async function collectSSEEvents(
  response: Response
): Promise<Array<{ event: string; data: unknown }>> {
  const events: Array<{ event: string; data: unknown }> = [];
  const reader = response.body?.getReader();
  if (!reader) return events;

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      let currentEvent = "";
      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7);
        } else if (line.startsWith("data: ") && currentEvent) {
          try {
            events.push({ event: currentEvent, data: JSON.parse(line.slice(6)) });
          } catch {
            // Skip malformed data
          }
          currentEvent = "";
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return events;
}

// =============================================================================
// Test Setup - Probe DO Support
// =============================================================================

beforeAll(async () => {
  // Probe DO support first
  const probe = await probeDOSupport();
  doTestsSupported = probe.supported;
  skipReason = probe.reason;

  if (!doTestsSupported) {
    console.warn(`\n⚠️  Chat E2E tests will be SKIPPED: ${skipReason}`);
    console.warn("   See CLAUDE.md Known Issues for details.\n");
    return;
  }

  // Setup test org and membership
  await createTestOrg(env.DB, { id: testOrgId, name: "Chat Test Firm" });
  if (testUserId) {
    await addOrgMember(env.DB, { orgId: testOrgId, userId: testUserId, role: "admin" });
  }
});

// =============================================================================
// Chat E2E Tests
// =============================================================================

describe("Chat E2E", () => {
  /**
   * Helper to skip test if DO is not supported.
   * Throws with clear message so test shows as failed, not silently passed.
   */
  function requireDOSupport(): void {
    if (!doTestsSupported) {
      throw new Error(`SKIPPED: ${skipReason} - see CLAUDE.md Known Issues`);
    }
  }

  it("should stream a response", async () => {
    requireDOSupport();
    const conversationId = crypto.randomUUID();
    const response = await sendChatMessage(
      conversationId,
      "What matters do I have?",
      testUserCookie
    );

    expect(response.ok).toBe(true);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");

    const events = await collectSSEEvents(response);
    expect(events).toContainEqual(expect.objectContaining({ event: "process" }));
    expect(events).toContainEqual(expect.objectContaining({ event: "done" }));
  });

  it("should persist conversation", async () => {
    requireDOSupport();
    const conversationId = crypto.randomUUID();

    // Send message
    const sendResponse = await sendChatMessage(conversationId, "Hello", testUserCookie);
    await sendResponse.text(); // Consume stream

    // Check conversation exists
    const listResponse = await authenticatedGet("/api/conversations", testUserCookie);
    expect(listResponse.ok).toBe(true);

    const { conversations } = (await listResponse.json()) as {
      conversations: Array<{ id: string }>;
    };
    expect(conversations).toContainEqual(expect.objectContaining({ id: conversationId }));
  });

  it("should return conversation messages", async () => {
    requireDOSupport();
    const conversationId = crypto.randomUUID();

    // Send message
    const sendResponse = await sendChatMessage(
      conversationId,
      "Test message for retrieval",
      testUserCookie
    );
    await sendResponse.text();

    // Fetch conversation
    const getResponse = await authenticatedGet(
      `/api/conversations/${conversationId}`,
      testUserCookie
    );
    expect(getResponse.ok).toBe(true);

    const { messages } = (await getResponse.json()) as {
      messages: Array<{ role: string; content: string }>;
    };

    const userMessages = messages.filter((m) => m.role === "user");
    expect(userMessages.length).toBeGreaterThanOrEqual(1);
    expect(userMessages[0].content).toBe("Test message for retrieval");
  });

  it("should delete a conversation", async () => {
    requireDOSupport();
    const conversationId = crypto.randomUUID();

    // Create conversation
    const sendResponse = await sendChatMessage(
      conversationId,
      "Message to delete",
      testUserCookie
    );
    await sendResponse.text();

    // Delete
    const deleteResponse = await worker.fetch(
      new Request(`http://localhost/api/conversations/${conversationId}`, {
        method: "DELETE",
        headers: { Cookie: testUserCookie },
      }),
      env as unknown as Env
    );

    expect(deleteResponse.ok).toBe(true);
    const deleteBody = (await deleteResponse.json()) as { success: boolean };
    expect(deleteBody.success).toBe(true);

    // Verify gone
    const listResponse = await authenticatedGet("/api/conversations", testUserCookie);
    const { conversations } = (await listResponse.json()) as {
      conversations: Array<{ id: string }>;
    };
    expect(conversations.find((c) => c.id === conversationId)).toBeUndefined();
  });
});
