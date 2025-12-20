import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker, { type Env } from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

async function callWorker(path: string): Promise<Record<string, unknown>> {
  const response = await worker.fetch(
    new IncomingRequest(`http://localhost${path}`),
    env as Env
  );
  return response.json() as Promise<Record<string, unknown>>;
}

describe("Routes", () => {
  it("/ returns auth demo page", async () => {
    const response = await worker.fetch(
      new IncomingRequest("http://localhost/"),
      env as Env
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html");
  });

  it("unknown routes return available routes", async () => {
    const data = await callWorker("/unknown");
    expect(data.routes).toContain("/api/messages");
    expect(data.routes).toContain("/callback");
    expect(data.routes).toContain("/");
  });
});
