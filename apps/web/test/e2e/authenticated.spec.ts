/**
 * Authenticated E2E Tests
 *
 * These tests run as an authenticated user (session loaded from auth.setup.ts).
 * They test organization creation, member management, and settings.
 */

import { test, expect } from "@playwright/test";

// Test data for organization creation
const TEST_ORG = {
  name: `E2E Test Org ${Date.now()}`,
  type: "Law Firm",
  size: "Solo Practitioner",
  jurisdiction: "CA",
  practiceArea: "General Practice",
};

// Test data for member invitation
const INVITEE_EMAIL = `invitee-${Date.now()}@e2e.test`;

/* ==========================================================================
   Organization Creation Flow
   ========================================================================== */

test.describe("Organization Creation Flow", () => {
  test("user can access dashboard when authenticated", async ({ page }) => {
    await page.goto("/dashboard");

    await expect(page).toHaveURL("/dashboard");
    await expect(
      page.getByRole("heading", { name: /dashboard/i })
    ).toBeVisible();
  });

  test("user can navigate to org creation page", async ({ page }) => {
    await page.goto("/org/create");

    // User might already have an org, in which case they'll be redirected
    const isOnCreatePage = page.url().includes("/org/create");

    if (!isOnCreatePage) {
      test.skip(true, "User already has an organization");
      return;
    }

    await expect(
      page.getByRole("heading", { name: /organization type/i })
    ).toBeVisible();
  });

  test("user can complete org creation wizard", async ({ page }) => {
    await page.goto("/org/create");

    // Skip if user already has an org
    if (!page.url().includes("/org/create")) {
      test.skip(true, "User already has an organization");
      return;
    }

    // Step 1: Select organization type
    await page.getByRole("button", { name: TEST_ORG.type }).click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();

    // Step 2: Enter basic information
    await expect(
      page.getByRole("heading", { name: /basic information/i })
    ).toBeVisible();

    await page.getByLabel(/organization name/i).fill(TEST_ORG.name);
    await page.getByRole("button", { name: TEST_ORG.size }).click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();

    // Step 3: Select jurisdictions
    await expect(
      page.getByRole("heading", { name: /jurisdictions/i })
    ).toBeVisible();

    await page.getByText(TEST_ORG.jurisdiction, { exact: true }).click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();

    // Step 4: Select practice areas
    await expect(
      page.getByRole("heading", { name: /practice areas/i })
    ).toBeVisible();

    await page.getByText(TEST_ORG.practiceArea, { exact: true }).click();
    await page.getByRole("button", { name: /create organization/i }).click();

    // Should redirect to dashboard with new org
    await expect(page).toHaveURL("/dashboard");
    await expect(page.getByText(TEST_ORG.name)).toBeVisible();
  });
});

/* ==========================================================================
   Member Invitation Flow
   ========================================================================== */

test.describe("Member Invitation Flow", () => {
  test("admin can access members page", async ({ page }) => {
    await page.goto("/org/members");

    // Skip if user doesn't have access
    if (!page.url().includes("/org/members")) {
      test.skip(true, "User is not admin or has no organization");
      return;
    }

    await expect(
      page.getByRole("heading", { name: /current members/i })
    ).toBeVisible();
  });

  test("admin can open invite modal", async ({ page }) => {
    await page.goto("/org/members");

    // Skip if user doesn't have access
    if (!page.url().includes("/org/members")) {
      test.skip(true, "User is not admin or has no organization");
      return;
    }

    await page.getByRole("button", { name: /invite member/i }).click();

    await expect(
      page.getByRole("heading", { name: /invite a team member/i })
    ).toBeVisible();
  });

  test("admin can send invitation and revoke it", async ({ page }) => {
    await page.goto("/org/members");

    // Skip if user doesn't have access
    if (!page.url().includes("/org/members")) {
      test.skip(true, "User is not admin or has no organization");
      return;
    }

    // Open invite modal and fill form
    await page.getByRole("button", { name: /invite member/i }).click();
    await page.getByLabel(/email address/i).fill(INVITEE_EMAIL);
    await page.getByLabel(/role/i).selectOption("member");
    await page.getByRole("button", { name: /send invitation/i }).click();

    // Verify invitation was sent
    await expect(page.getByText(/invitation sent/i)).toBeVisible();
    await expect(page.getByText(INVITEE_EMAIL)).toBeVisible();

    // Revoke the invitation
    const invitationRow = page.locator("tr", { hasText: INVITEE_EMAIL });

    // Handle the confirmation dialog
    page.on("dialog", async (dialog) => {
      await dialog.accept();
    });

    await invitationRow.getByRole("button", { name: /revoke/i }).click();

    // Verify invitation was revoked
    await expect(page.getByText(INVITEE_EMAIL)).not.toBeVisible();
  });
});

/* ==========================================================================
   Organization Settings
   ========================================================================== */

test.describe("Organization Settings", () => {
  test("admin can access org settings", async ({ page }) => {
    await page.goto("/org/settings");

    // Skip if user doesn't have access
    if (!page.url().includes("/org/settings")) {
      test.skip(true, "User is not admin or has no organization");
      return;
    }

    await expect(
      page.getByRole("heading", { name: /settings/i })
    ).toBeVisible();
  });
});
