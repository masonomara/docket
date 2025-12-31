// =============================================================================
// Chat Handler Unit Tests
// =============================================================================
//
// Tests for the chat API handler functions:
// - handleChatMessage: POST /api/chat (SSE streaming)
// - handleGetConversations: GET /api/conversations
// - handleDeleteConversation: DELETE /api/conversations/:id
//
// Note: These tests mock the Durable Object since DO SQLite doesn't work with
// vitest-pool-workers (see Known Issues in CLAUDE.md).

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleChatMessage,
  handleGetConversations,
  handleDeleteConversation,
} from "../../src/handlers/chat";
import type { MemberContext } from "../../src/lib/session";
import type { Env } from "../../src/types/env";

// =============================================================================
// Mock Factories
// =============================================================================

function createMockMemberContext(overrides?: Partial<MemberContext>): MemberContext {
  return {
    user: {
      id: "user-123",
      email: "test@example.com",
      name: "Test User",
    },
    orgId: "org-456",
    ...overrides,
  };
}

function createMockRequest(
  method: string,
  body?: unknown,
  url = "https://api.docket.com/api/chat"
): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  return new Request(url, init);
}

function createMockDOStub(fetchResponse: Response) {
  return {
    fetch: vi.fn().mockResolvedValue(fetchResponse),
  };
}

function createMockEnv(options: {
  doResponse?: Response;
  membershipResult?: { role: string } | null;
  orgSettings?: { jurisdictions: string; practice_types: string; firm_size: string | null } | null;
}): Env {
  const doStub = createMockDOStub(
    options.doResponse ?? new Response("", { status: 200 })
  );

  return {
    TENANT: {
      idFromName: vi.fn().mockReturnValue("do-id-123"),
      get: vi.fn().mockReturnValue(doStub),
    },
    DB: {
      prepare: vi.fn().mockImplementation((query: string) => {
        // Mock org_members query (for membership check)
        if (query.includes("org_members")) {
          return {
            bind: vi.fn().mockReturnThis(),
            first: vi.fn().mockResolvedValue(
              "membershipResult" in options
                ? options.membershipResult
                : { role: "member" }
            ),
          };
        }
        // Mock org query (for org settings)
        if (query.includes("SELECT jurisdictions")) {
          return {
            bind: vi.fn().mockReturnThis(),
            first: vi.fn().mockResolvedValue(
              "orgSettings" in options
                ? options.orgSettings
                : {
                    jurisdictions: "[]",
                    practice_types: "[]",
                    firm_size: null,
                  }
            ),
          };
        }
        return {
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue(null),
        };
      }),
    },
  } as unknown as Env;
}

// =============================================================================
// handleChatMessage Tests
// =============================================================================

describe("handleChatMessage", () => {
  describe("Request Validation", () => {
    it("rejects missing conversationId", async () => {
      const request = createMockRequest("POST", { message: "Hello" });
      const env = createMockEnv({});
      const ctx = createMockMemberContext();

      const response = await handleChatMessage(request, env, ctx);
      const body = await response.json() as { error: string };

      expect(response.status).toBe(400);
      expect(body.error).toBe("Invalid request");
    });

    it("rejects missing message", async () => {
      const request = createMockRequest("POST", {
        conversationId: "550e8400-e29b-41d4-a716-446655440000",
      });
      const env = createMockEnv({});
      const ctx = createMockMemberContext();

      const response = await handleChatMessage(request, env, ctx);
      const body = await response.json() as { error: string };

      expect(response.status).toBe(400);
      expect(body.error).toBe("Invalid request");
    });

    it("rejects invalid conversationId format", async () => {
      const request = createMockRequest("POST", {
        conversationId: "not-a-uuid",
        message: "Hello",
      });
      const env = createMockEnv({});
      const ctx = createMockMemberContext();

      const response = await handleChatMessage(request, env, ctx);
      const body = await response.json() as { error: string };

      expect(response.status).toBe(400);
      expect(body.error).toBe("Invalid request");
    });

    it("rejects message over 10000 characters", async () => {
      const longMessage = "a".repeat(10001);
      const request = createMockRequest("POST", {
        conversationId: "550e8400-e29b-41d4-a716-446655440000",
        message: longMessage,
      });
      const env = createMockEnv({});
      const ctx = createMockMemberContext();

      const response = await handleChatMessage(request, env, ctx);
      const body = await response.json() as { error: string };

      expect(response.status).toBe(400);
      expect(body.error).toBe("Invalid request");
    });

    it("rejects empty message", async () => {
      const request = createMockRequest("POST", {
        conversationId: "550e8400-e29b-41d4-a716-446655440000",
        message: "",
      });
      const env = createMockEnv({});
      const ctx = createMockMemberContext();

      const response = await handleChatMessage(request, env, ctx);
      const body = await response.json() as { error: string };

      expect(response.status).toBe(400);
      expect(body.error).toBe("Invalid request");
    });

    it("rejects invalid JSON body", async () => {
      const request = new Request("https://api.docket.com/api/chat", {
        method: "POST",
        body: "not valid json",
        headers: { "Content-Type": "application/json" },
      });
      const env = createMockEnv({});
      const ctx = createMockMemberContext();

      const response = await handleChatMessage(request, env, ctx);
      const body = await response.json() as { error: string };

      expect(response.status).toBe(400);
      expect(body.error).toBe("Invalid JSON body");
    });
  });

  describe("Authorization", () => {
    it("returns 403 when user is not a member of org", async () => {
      const request = createMockRequest("POST", {
        conversationId: "550e8400-e29b-41d4-a716-446655440000",
        message: "Hello",
      });
      const env = createMockEnv({ membershipResult: null });
      const ctx = createMockMemberContext();

      const response = await handleChatMessage(request, env, ctx);
      const body = await response.json() as { error: string };

      expect(response.status).toBe(403);
      expect(body.error).toBe("Not a member of organization");
    });

    it("returns 404 when organization not found", async () => {
      const request = createMockRequest("POST", {
        conversationId: "550e8400-e29b-41d4-a716-446655440000",
        message: "Hello",
      });
      const env = createMockEnv({
        membershipResult: { role: "member" },
        orgSettings: null,
      });
      const ctx = createMockMemberContext();

      const response = await handleChatMessage(request, env, ctx);
      const body = await response.json() as { error: string };

      expect(response.status).toBe(404);
      expect(body.error).toBe("Organization not found");
    });
  });

  describe("SSE Response", () => {
    it("returns SSE content-type header on success", async () => {
      const sseStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: done\ndata: {}\n\n'));
          controller.close();
        },
      });
      const doResponse = new Response(sseStream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });

      const request = createMockRequest("POST", {
        conversationId: "550e8400-e29b-41d4-a716-446655440000",
        message: "Hello",
      });
      const env = createMockEnv({ doResponse });
      const ctx = createMockMemberContext();

      const response = await handleChatMessage(request, env, ctx);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");
      expect(response.headers.get("Cache-Control")).toBe("no-cache");
      expect(response.headers.get("Connection")).toBe("keep-alive");
    });

    it("forwards DO stream to client", async () => {
      const events = 'event: content\ndata: {"text":"Hello"}\n\nevent: done\ndata: {}\n\n';
      const sseStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(events));
          controller.close();
        },
      });
      const doResponse = new Response(sseStream, { status: 200 });

      const request = createMockRequest("POST", {
        conversationId: "550e8400-e29b-41d4-a716-446655440000",
        message: "Hello",
      });
      const env = createMockEnv({ doResponse });
      const ctx = createMockMemberContext();

      const response = await handleChatMessage(request, env, ctx);
      const responseText = await response.text();

      expect(responseText).toContain('event: content');
      expect(responseText).toContain('"text":"Hello"');
    });

    it("handles DO error responses", async () => {
      const doResponse = Response.json({ error: "Processing failed" }, { status: 500 });

      const request = createMockRequest("POST", {
        conversationId: "550e8400-e29b-41d4-a716-446655440000",
        message: "Hello",
      });
      const env = createMockEnv({ doResponse });
      const ctx = createMockMemberContext();

      const response = await handleChatMessage(request, env, ctx);
      const body = await response.json() as { error: string };

      expect(response.status).toBe(500);
      expect(body.error).toBe("Processing failed");
    });
  });

  describe("Channel Message Construction", () => {
    it("constructs correct channel message for DO", async () => {
      let capturedRequest: Request | null = null;
      const doStub = {
        fetch: vi.fn().mockImplementation((req: Request) => {
          capturedRequest = req;
          return Promise.resolve(new Response("", { status: 200 }));
        }),
      };

      const env = {
        TENANT: {
          idFromName: vi.fn().mockReturnValue("do-id-123"),
          get: vi.fn().mockReturnValue(doStub),
        },
        DB: {
          prepare: vi.fn().mockImplementation((query: string) => {
            if (query.includes("org_members")) {
              return {
                bind: vi.fn().mockReturnThis(),
                first: vi.fn().mockResolvedValue({ role: "admin" }),
              };
            }
            if (query.includes("SELECT jurisdictions")) {
              return {
                bind: vi.fn().mockReturnThis(),
                first: vi.fn().mockResolvedValue({
                  jurisdictions: '["California"]',
                  practice_types: '["Corporate"]',
                  firm_size: "small",
                }),
              };
            }
            return {
              bind: vi.fn().mockReturnThis(),
              first: vi.fn().mockResolvedValue(null),
            };
          }),
        },
      } as unknown as Env;

      const request = createMockRequest("POST", {
        conversationId: "550e8400-e29b-41d4-a716-446655440000",
        message: "What matters do I have?",
      });
      const ctx = createMockMemberContext();

      await handleChatMessage(request, env, ctx);

      expect(capturedRequest).not.toBeNull();
      const body = await capturedRequest!.json() as {
        channel: string;
        orgId: string;
        userId: string;
        userRole: string;
        conversationId: string;
        message: string;
        jurisdictions: string[];
        practiceTypes: string[];
        firmSize: string;
      };

      expect(body.channel).toBe("web");
      expect(body.orgId).toBe("org-456");
      expect(body.userId).toBe("user-123");
      expect(body.userRole).toBe("admin");
      expect(body.conversationId).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(body.message).toBe("What matters do I have?");
      expect(body.jurisdictions).toEqual(["California"]);
      expect(body.practiceTypes).toEqual(["Corporate"]);
      expect(body.firmSize).toBe("small");
    });
  });
});

// =============================================================================
// handleGetConversations Tests
// =============================================================================

describe("handleGetConversations", () => {
  it("returns empty array for user with no conversations", async () => {
    const doResponse = Response.json({ conversations: [] });

    const request = createMockRequest("GET", undefined, "https://api.docket.com/api/conversations");
    const env = createMockEnv({ doResponse });
    const ctx = createMockMemberContext();

    const response = await handleGetConversations(request, env, ctx);
    const body = await response.json() as { conversations: unknown[] };

    expect(response.status).toBe(200);
    expect(body.conversations).toEqual([]);
  });

  it("returns conversations sorted by updatedAt DESC", async () => {
    const conversations = [
      { id: "conv-1", title: "Newest", updatedAt: 1704067200000, messageCount: 5 },
      { id: "conv-2", title: "Middle", updatedAt: 1703980800000, messageCount: 3 },
      { id: "conv-3", title: "Oldest", updatedAt: 1703894400000, messageCount: 1 },
    ];
    const doResponse = Response.json({ conversations });

    const request = createMockRequest("GET", undefined, "https://api.docket.com/api/conversations");
    const env = createMockEnv({ doResponse });
    const ctx = createMockMemberContext();

    const response = await handleGetConversations(request, env, ctx);
    const body = await response.json() as { conversations: typeof conversations };

    expect(response.status).toBe(200);
    expect(body.conversations).toHaveLength(3);
    expect(body.conversations[0].title).toBe("Newest");
    expect(body.conversations[2].title).toBe("Oldest");
  });

  it("only returns user's own conversations", async () => {
    // Verify the DO is called with correct userId
    let capturedUrl = "";
    const doStub = {
      fetch: vi.fn().mockImplementation((req: Request) => {
        capturedUrl = req.url;
        return Promise.resolve(Response.json({ conversations: [] }));
      }),
    };

    const env = {
      TENANT: {
        idFromName: vi.fn().mockReturnValue("do-id-123"),
        get: vi.fn().mockReturnValue(doStub),
      },
    } as unknown as Env;

    const request = createMockRequest("GET", undefined, "https://api.docket.com/api/conversations");
    const ctx = createMockMemberContext({ user: { id: "user-specific-123", email: "a@b.com", name: "A" } });

    await handleGetConversations(request, env, ctx);

    expect(capturedUrl).toContain("userId=user-specific-123");
  });

  it("handles DO error responses", async () => {
    const doResponse = new Response(null, { status: 500 });

    const request = createMockRequest("GET", undefined, "https://api.docket.com/api/conversations");
    const env = createMockEnv({ doResponse });
    const ctx = createMockMemberContext();

    const response = await handleGetConversations(request, env, ctx);
    const body = await response.json() as { error: string };

    expect(response.status).toBe(500);
    expect(body.error).toBe("Failed to fetch conversations");
  });
});

// =============================================================================
// handleDeleteConversation Tests
// =============================================================================

describe("handleDeleteConversation", () => {
  it("returns 404 for non-existent conversation", async () => {
    const doResponse = Response.json({ error: "Conversation not found" }, { status: 404 });

    const request = createMockRequest(
      "DELETE",
      undefined,
      "https://api.docket.com/api/conversations/nonexistent-id"
    );
    const env = createMockEnv({ doResponse });
    const ctx = createMockMemberContext();

    const response = await handleDeleteConversation(request, env, ctx, "nonexistent-id");
    const body = await response.json() as { error: string };

    expect(response.status).toBe(404);
    expect(body.error).toBe("Conversation not found");
  });

  it("returns 404 for conversation owned by different user", async () => {
    // DO returns 404 when user_id doesn't match
    const doResponse = Response.json({ error: "Conversation not found" }, { status: 404 });

    const request = createMockRequest(
      "DELETE",
      undefined,
      "https://api.docket.com/api/conversations/other-user-conv"
    );
    const env = createMockEnv({ doResponse });
    const ctx = createMockMemberContext();

    const response = await handleDeleteConversation(request, env, ctx, "other-user-conv");
    const body = await response.json() as { error: string };

    expect(response.status).toBe(404);
    expect(body.error).toBe("Conversation not found");
  });

  it("successfully deletes conversation and messages", async () => {
    const doResponse = Response.json({ success: true });

    const request = createMockRequest(
      "DELETE",
      undefined,
      "https://api.docket.com/api/conversations/valid-conv-id"
    );
    const env = createMockEnv({ doResponse });
    const ctx = createMockMemberContext();

    const response = await handleDeleteConversation(request, env, ctx, "valid-conv-id");
    const body = await response.json() as { success: boolean };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("passes userId to DO for ownership verification", async () => {
    let capturedUrl = "";
    const doStub = {
      fetch: vi.fn().mockImplementation((req: Request) => {
        capturedUrl = req.url;
        return Promise.resolve(Response.json({ success: true }));
      }),
    };

    const env = {
      TENANT: {
        idFromName: vi.fn().mockReturnValue("do-id-123"),
        get: vi.fn().mockReturnValue(doStub),
      },
    } as unknown as Env;

    const request = createMockRequest(
      "DELETE",
      undefined,
      "https://api.docket.com/api/conversations/conv-123"
    );
    const ctx = createMockMemberContext({ user: { id: "owner-user", email: "a@b.com", name: "A" } });

    await handleDeleteConversation(request, env, ctx, "conv-123");

    expect(capturedUrl).toContain("userId=owner-user");
    expect(capturedUrl).toContain("/conversation/conv-123");
  });

  it("uses DELETE method when calling DO", async () => {
    let capturedMethod = "";
    const doStub = {
      fetch: vi.fn().mockImplementation((req: Request) => {
        capturedMethod = req.method;
        return Promise.resolve(Response.json({ success: true }));
      }),
    };

    const env = {
      TENANT: {
        idFromName: vi.fn().mockReturnValue("do-id-123"),
        get: vi.fn().mockReturnValue(doStub),
      },
    } as unknown as Env;

    const request = createMockRequest(
      "DELETE",
      undefined,
      "https://api.docket.com/api/conversations/conv-123"
    );
    const ctx = createMockMemberContext();

    await handleDeleteConversation(request, env, ctx, "conv-123");

    expect(capturedMethod).toBe("DELETE");
  });
});
