import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import {
  findUserByChannelId,
  linkChannelUser,
  unlinkChannelUser,
  findUserByEmail,
  getUserChannelLinks,
} from "../../src/services/channel-linking";

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates a test user in the database
 */
async function createTestUser(
  id: string,
  email: string,
  name = "Test User"
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(id, name, email, 1, now, now)
    .run();
}

// ============================================================================
// Channel Linking Tests
// ============================================================================

describe("Channel Linking", () => {
  const testUserId = crypto.randomUUID();
  const teamsChannelId = "29:test-teams";
  const slackChannelId = "U12345678";

  beforeAll(async () => {
    await createTestUser(testUserId, "test@lawfirm.com");
  });

  it("returns null for unknown channel user", async () => {
    const result = await findUserByChannelId(env.DB, "teams", "unknown-id");
    expect(result).toBeNull();
  });

  it("links a Teams user", async () => {
    const linkResult = await linkChannelUser(env.DB, {
      channelType: "teams",
      channelUserId: teamsChannelId,
      userId: testUserId,
    });

    expect(linkResult.id).toBeDefined();

    const foundUserId = await findUserByChannelId(
      env.DB,
      "teams",
      teamsChannelId
    );
    expect(foundUserId).toBe(testUserId);
  });

  it("links a Slack user", async () => {
    await linkChannelUser(env.DB, {
      channelType: "slack",
      channelUserId: slackChannelId,
      userId: testUserId,
    });

    const foundUserId = await findUserByChannelId(
      env.DB,
      "slack",
      slackChannelId
    );
    expect(foundUserId).toBe(testUserId);
  });

  it("isolates channel types", async () => {
    // Teams ID shouldn't be found in Slack namespace
    const teamsInSlack = await findUserByChannelId(
      env.DB,
      "slack",
      teamsChannelId
    );
    expect(teamsInSlack).toBeNull();

    // Slack ID shouldn't be found in Teams namespace
    const slackInTeams = await findUserByChannelId(
      env.DB,
      "teams",
      slackChannelId
    );
    expect(slackInTeams).toBeNull();
  });

  it("finds user by email", async () => {
    const foundUserId = await findUserByEmail(env.DB, "test@lawfirm.com");
    expect(foundUserId).toBe(testUserId);
  });

  it("returns null for unknown email", async () => {
    const result = await findUserByEmail(env.DB, "unknown@example.com");
    expect(result).toBeNull();
  });

  it("gets all channel links for a user", async () => {
    const userId = crypto.randomUUID();
    const email = `links-${Date.now()}@test.com`;

    await createTestUser(userId, email, "Links User");

    // Create links for both Teams and Slack
    const teamsId = `29:links-${Date.now()}`;
    const slackId = `U-links-${Date.now()}`;

    await linkChannelUser(env.DB, {
      channelType: "teams",
      channelUserId: teamsId,
      userId,
    });

    await linkChannelUser(env.DB, {
      channelType: "slack",
      channelUserId: slackId,
      userId,
    });

    const links = await getUserChannelLinks(env.DB, userId);

    expect(links.length).toBe(2);

    const channelTypes = links.map((link) => link.channelType);
    expect(channelTypes).toContain("teams");
    expect(channelTypes).toContain("slack");
  });

  it("unlinks a channel user", async () => {
    const teamsIdToUnlink = "29:unlinkable";

    // Create the link
    await linkChannelUser(env.DB, {
      channelType: "teams",
      channelUserId: teamsIdToUnlink,
      userId: testUserId,
    });

    // Verify it exists
    const beforeUnlink = await findUserByChannelId(
      env.DB,
      "teams",
      teamsIdToUnlink
    );
    expect(beforeUnlink).toBe(testUserId);

    // Unlink it
    const unlinkResult = await unlinkChannelUser(
      env.DB,
      "teams",
      teamsIdToUnlink
    );
    expect(unlinkResult).toBe(true);

    // Verify it's gone
    const afterUnlink = await findUserByChannelId(
      env.DB,
      "teams",
      teamsIdToUnlink
    );
    expect(afterUnlink).toBeNull();
  });

  it("returns false when unlinking non-existent link", async () => {
    const result = await unlinkChannelUser(env.DB, "teams", "non-existent-id");
    expect(result).toBe(false);
  });
});
