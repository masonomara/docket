/**
 * Shared HTTP request helpers for integration tests.
 * Consolidates duplicated request helpers from test files.
 */

import type { Env } from "../../src/index";

type WorkerFetch = {
  fetch: (request: Request, env: Env) => Promise<Response>;
};

/**
 * Makes a POST request to the worker.
 */
export async function post(
  worker: WorkerFetch,
  env: Env,
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
): Promise<Response> {
  const request = new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });

  return worker.fetch(request, env);
}

/**
 * Makes a GET request to the worker.
 */
export async function get(
  worker: WorkerFetch,
  env: Env,
  path: string,
  headers: Record<string, string> = {}
): Promise<Response> {
  const request = new Request(`http://localhost${path}`, { headers });
  return worker.fetch(request, env);
}

/**
 * Makes an authenticated POST request to the worker.
 */
export async function authenticatedPost(
  worker: WorkerFetch,
  env: Env,
  path: string,
  body: Record<string, unknown>,
  sessionCookie: string
): Promise<Response> {
  return post(worker, env, path, body, { Cookie: sessionCookie });
}

/**
 * Makes an authenticated GET request to the worker.
 */
export async function authenticatedGet(
  worker: WorkerFetch,
  env: Env,
  path: string,
  sessionCookie: string
): Promise<Response> {
  return get(worker, env, path, { Cookie: sessionCookie });
}

/**
 * Extracts the session cookie from a response's Set-Cookie header.
 * Returns the full cookie string for use in subsequent requests.
 */
export function getSessionCookie(response: Response): string | null {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) return null;

  // Return the first part before semicolon (the cookie itself)
  return setCookie.split(";")[0] ?? null;
}

/**
 * Extracts just the session token value from a Set-Cookie header.
 */
export function getSessionToken(response: Response): string | null {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) return null;

  const match = setCookie.match(/better-auth\.session_token=([^;]+)/);
  return match?.[1] ?? null;
}

/**
 * Parses SSE events from a Response stream.
 */
export async function collectSSEEvents(
  response: Response
): Promise<{ event?: string; data: string }[]> {
  const reader = response.body?.getReader();
  if (!reader) return [];

  const decoder = new TextDecoder();
  const events: { event?: string; data: string }[] = [];
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    let currentEvent: string | undefined;
    let currentData = "";

    for (const line of lines) {
      if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        currentData = line.slice(5).trim();
      } else if (line === "" && currentData) {
        events.push({ event: currentEvent, data: currentData });
        currentEvent = undefined;
        currentData = "";
      }
    }
  }

  return events;
}
