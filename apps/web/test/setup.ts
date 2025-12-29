import { beforeAll, afterEach, afterAll } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { server } from "./mocks/server";

beforeAll(() => server.listen({ onUnhandledRequest: "warn" }));
afterEach(() => {
  server.resetHandlers();
  cleanup();
});
afterAll(() => server.close());
