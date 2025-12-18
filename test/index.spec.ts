import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker, { type Env } from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

/**
 * Helper to make a GET request to the worker and parse JSON response
 */
async function callWorker(path: string): Promise<Record<string, unknown>> {
  const request = new IncomingRequest(`http://localhost${path}`);
  const response = await worker.fetch(request, env as Env);
  return response.json() as Promise<Record<string, unknown>>;
}

/**
 * Helper to make a POST request with JSON body
 */
async function postToWorker(
  path: string,
  body: Record<string, unknown>
): Promise<Response> {
  const request = new IncomingRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return worker.fetch(request, env as Env);
}

describe("Bindings", () => {
  it("/ lists available routes", async () => {
    const data = await callWorker("/");

    expect(data.routes).toBeDefined();
    expect(data.routes).toContain("/api/messages");
    expect(data.routes).toContain("/callback");
    expect(data.routes).toContain("/test/d1");
    expect(data.routes).toContain("/test/do");
    expect(data.routes).toContain("/test/r2");
    expect(data.routes).toContain("/test/ai");
  });

  it("/test/d1 creates table and inserts record", async () => {
    const data = await callWorker("/test/d1");

    expect(data.success).toBe(true);
    expect(data.inserted).toBeDefined();
  });

  it("/test/do returns durable object state", async () => {
    const data = await callWorker("/test/do");

    expect(data.id).toBeDefined();
    expect(data.count).toBeDefined();
  });

  it("/test/r2 writes and reads from bucket", async () => {
    const data = await callWorker("/test/r2");

    expect(data.success).toBe(true);
    expect(data.content).toBe("{}");
  });

  it("/test/ai generates embedding with correct dimensions", async () => {
    const data = await callWorker("/test/ai");

    expect(data.success).toBe(true);
    expect(data.dimensions).toBe(768);
    expect(data.match).toBeDefined();
  });
});

describe("Bot Framework - /api/messages", () => {
  it("rejects non-POST requests", async () => {
    const request = new IncomingRequest("http://localhost/api/messages");
    const response = await worker.fetch(request, env as Env);

    expect(response.status).toBe(405);
  });

  it("accepts message activity and returns 200", async () => {
    const activity = {
      type: "message",
      id: "test-activity-id",
      text: "Hello bot",
      from: { id: "user-123", name: "Test User" },
      recipient: { id: "bot-456", name: "Docket Bot" },
      conversation: { id: "conv-789" },
      serviceUrl: "https://smba.trafficmanager.net/teams/",
    };

    const response = await postToWorker("/api/messages", activity);

    expect(response.status).toBe(200);
  });

  it("accepts conversationUpdate activity", async () => {
    const activity = {
      type: "conversationUpdate",
      id: "update-id",
      from: { id: "user-123" },
      recipient: { id: "bot-456" },
      conversation: { id: "conv-789" },
      serviceUrl: "https://smba.trafficmanager.net/teams/",
    };

    const response = await postToWorker("/api/messages", activity);

    expect(response.status).toBe(200);
  });

  it("returns 200 when serviceUrl is missing", async () => {
    const activity = {
      type: "message",
      text: "Hello",
      conversation: { id: "conv-789" },
      // No serviceUrl - should bail early
    };

    const response = await postToWorker("/api/messages", activity);

    expect(response.status).toBe(200);
  });

  it("returns 200 when conversation is missing", async () => {
    const activity = {
      type: "message",
      text: "Hello",
      serviceUrl: "https://smba.trafficmanager.net/teams/",
      // No conversation - should bail early
    };

    const response = await postToWorker("/api/messages", activity);

    expect(response.status).toBe(200);
  });
});

describe("Clio OAuth - /callback", () => {
  it("rejects requests without code parameter", async () => {
    const data = await callWorker("/callback?state=test123");

    expect(data.error).toBe("Missing authorization code");
  });

  it("rejects requests without state parameter", async () => {
    const data = await callWorker("/callback?code=abc123");

    expect(data.error).toBe("Missing state parameter");
  });

  it("rejects requests with no parameters", async () => {
    const data = await callWorker("/callback");

    expect(data.error).toBe("Missing authorization code");
  });

  // Token exchange requires mocking Clio API - test manually or with integration tests
  it.todo("exchanges valid auth code for tokens (requires Clio API mock)");
});
