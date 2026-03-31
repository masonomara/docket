# Web Tests

## Quick Start

```bash
npm test                    # Vitest unit + integration
npm run test:e2e            # Playwright browser tests
```

## Environment Variables

| Variable             | Required For      | Example            |
| -------------------- | ----------------- | ------------------ |
| `TEST_USER_EMAIL`    | Authenticated E2E | `user@example.com` |
| `TEST_USER_PASSWORD` | Authenticated E2E | `password123`      |
| `E2E_AUTH_ENABLED`   | Enable auth tests | `true`             |

## Test Categories

```
test/
├── unit/          Component tests with jsdom
├── integration/   Hook tests with MSW
├── e2e/           Playwright browser tests
└── mocks/         MSW handlers and server setup
```

## E2E Tests

### Unauthenticated Tests

Run without any environment variables:

```bash
npm run test:e2e
```

### Authenticated Tests

Requires a real test account:

```bash
TEST_USER_EMAIL=your@email.com \
TEST_USER_PASSWORD=yourpassword \
E2E_AUTH_ENABLED=true \
npm run test:e2e
```

Auth state is saved to `test/e2e/.auth/user.json` between runs.

## MSW Mocking

API requests are mocked using MSW (Mock Service Worker):

```typescript
// test/mocks/handlers.ts - Default handlers
// test/mocks/server.ts   - Server setup

// In tests, reset handlers after each test:
afterEach(() => server.resetHandlers());
```

## Writing Tests

### Component Tests

```typescript
import { render, screen } from "@testing-library/react";
import { MyComponent } from "~/components/MyComponent";

it("renders correctly", () => {
  render(<MyComponent />);
  expect(screen.getByText("Hello")).toBeInTheDocument();
});
```

### E2E Tests

```typescript
import { test, expect } from "@playwright/test";

test("user can navigate", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading")).toBeVisible();
});
```

## Known Limitations

### Auth State Caching

Playwright caches auth state in `test/e2e/.auth/user.json`. If tests fail with auth errors, delete this file and re-run.

### Fixed Timeouts

Avoid `page.waitForTimeout()`. Use explicit waits:

```typescript
// Bad
await page.waitForTimeout(2000);

// Good
await page.waitForURL("**/dashboard");
await expect(page.getByRole("button")).toBeVisible();
```
