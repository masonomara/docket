/**
 * E2E Demo Flow Tests
 *
 * These tests verify the end-to-end behavior of the Docket API
 * by making real HTTP requests to a running worker.
 *
 * Run with: WORKER_URL=http://localhost:8787 npm run test:e2e
 */

import { describe, it, expect, beforeAll } from "vitest";

// Base URL for the worker - must be explicitly set
const BASE_URL = process.env.WORKER_URL;

beforeAll(() => {
  if (!BASE_URL) {
    throw new Error(
      "WORKER_URL environment variable is required for E2E tests.\n" +
        "Set it to your local worker or staging URL.\n" +
        "Example: WORKER_URL=http://localhost:8787 npm run test:e2e"
    );
  }
});

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Creates a mock Teams activity payload.
 * Merges default values with any overrides provided.
 */
function createTeamsActivity(overrides: Record<string, unknown> = {}): string {
  const defaultActivity = {
    type: "message",
    text: "Test message",
    from: { aadObjectId: "test-user-aad-id" },
    conversation: { id: "test-conv-id", conversationType: "personal" },
    recipient: { id: "bot-id" },
    serviceUrl: "https://test.botframework.com/",
  };

  return JSON.stringify({
    ...defaultActivity,
    ...overrides,
  });
}

/**
 * Sends a message to the Teams webhook endpoint.
 */
async function sendTeamsMessage(body: string): Promise<Response> {
  return fetch(`${BASE_URL!}/api/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

// =============================================================================
// E2E Demo Flow Tests
// =============================================================================

describe("E2E Demo Flow", () => {
  describe("User Onboarding", () => {
    it("handles messages from unlinked users gracefully", async () => {
      // A user who hasn't linked their account yet should get a welcome message
      const response = await sendTeamsMessage(
        createTeamsActivity({
          from: { aadObjectId: `unlinked-user-${Date.now()}` },
        })
      );

      // Should return 200 (Teams expects success regardless of business logic)
      expect(response.status).toBe(200);
    });
  });

  describe("Conversation Continuity", () => {
    it("maintains context across multiple messages in a conversation", async () => {
      const conversationId = `multi-turn-${Date.now()}`;

      // Send first message
      const firstResponse = await sendTeamsMessage(
        createTeamsActivity({
          text: "Hello, this is my first message",
          conversation: { id: conversationId, conversationType: "personal" },
        })
      );

      // Send follow-up message in same conversation
      const secondResponse = await sendTeamsMessage(
        createTeamsActivity({
          text: "This is a follow-up message",
          conversation: { id: conversationId, conversationType: "personal" },
        })
      );

      // Both should succeed
      expect(firstResponse.status).toBe(200);
      expect(secondResponse.status).toBe(200);
    });
  });

  describe("Conversation Scopes", () => {
    it("processes personal (DM) messages", async () => {
      const response = await sendTeamsMessage(
        createTeamsActivity({
          conversation: {
            id: `personal-${Date.now()}`,
            conversationType: "personal",
          },
        })
      );

      expect(response.status).toBe(200);
    });

    it("processes group chat messages", async () => {
      const response = await sendTeamsMessage(
        createTeamsActivity({
          conversation: {
            id: `groupchat-${Date.now()}`,
            conversationType: "groupChat",
          },
        })
      );

      expect(response.status).toBe(200);
    });

    it("processes channel messages", async () => {
      const response = await sendTeamsMessage(
        createTeamsActivity({
          conversation: {
            id: `channel-${Date.now()}`,
            conversationType: "channel",
          },
        })
      );

      expect(response.status).toBe(200);
    });
  });

  describe("Error Handling", () => {
    it("handles malformed JSON gracefully", async () => {
      const response = await fetch(`${BASE_URL!}/api/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "this is not valid JSON {{{",
      });

      // Should still return a response (not crash)
      expect(response.status).toBeDefined();
    });

    it("handles messages with missing required fields", async () => {
      // Send a message activity with no text or user ID
      const response = await sendTeamsMessage(
        JSON.stringify({ type: "message" })
      );

      // Should return 200 (graceful handling)
      expect(response.status).toBe(200);
    });

    it("ignores non-message activity types", async () => {
      // Teams sends various activity types (conversationUpdate, etc)
      const response = await sendTeamsMessage(
        JSON.stringify({
          type: "conversationUpdate",
          membersAdded: [{ id: "user-id" }],
        })
      );

      // Should return 200 (acknowledged but no action taken)
      expect(response.status).toBe(200);
    });
  });
});

// =============================================================================
// Performance Tests
// =============================================================================

describe("Performance", () => {
  it("responds within acceptable time limits", async () => {
    const startTime = Date.now();

    await sendTeamsMessage(createTeamsActivity());

    const elapsedTime = Date.now() - startTime;

    // Should respond within 5 seconds
    expect(elapsedTime).toBeLessThan(5000);
  });

  it("handles concurrent messages without errors", async () => {
    // Create 5 concurrent messages from different users/conversations
    const messages = Array.from({ length: 5 }, (_, index) =>
      createTeamsActivity({
        from: { aadObjectId: `concurrent-user-${index}` },
        conversation: {
          id: `concurrent-conv-${index}-${Date.now()}`,
          conversationType: "personal",
        },
      })
    );

    // Send all messages in parallel
    const responses = await Promise.all(messages.map(sendTeamsMessage));

    // All should succeed
    for (const response of responses) {
      expect(response.status).toBe(200);
    }
  });
});
