import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import {
  findUserByChannelId,
  linkChannelUser,
  unlinkChannelUser,
  findUserByEmail,
  getUserChannelLinks,
} from "../src/services/channel-linking";

describe("Channel Linking", () => {
  const testUserId = crypto.randomUUID();
  const teamsUserId = "29:test-teams-user";
  const slackUserId = "U12345678";

  beforeAll(async () => {
    await env.DB.prepare(
      `INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(
        testUserId,
        "Test User",
        "test@lawfirm.com",
        1,
        Date.now(),
        Date.now()
      )
      .run();
  });

  it("returns null for unknown channel user", async () => {
    expect(
      await findUserByChannelId(env.DB, "teams", "unknown-user")
    ).toBeNull();
  });

  it("links a Teams user to Docket user", async () => {
    const { id } = await linkChannelUser(env.DB, {
      channelType: "teams",
      channelUserId: teamsUserId,
      userId: testUserId,
    });
    expect(id).toBeDefined();
    expect(await findUserByChannelId(env.DB, "teams", teamsUserId)).toBe(
      testUserId
    );
  });

  it("links a Slack user to Docket user", async () => {
    await linkChannelUser(env.DB, {
      channelType: "slack",
      channelUserId: slackUserId,
      userId: testUserId,
    });
    expect(await findUserByChannelId(env.DB, "slack", slackUserId)).toBe(
      testUserId
    );
  });

  it("isolates channel types", async () => {
    expect(await findUserByChannelId(env.DB, "slack", teamsUserId)).toBeNull();
    expect(await findUserByChannelId(env.DB, "teams", slackUserId)).toBeNull();
  });

  it("finds user by email", async () => {
    expect(await findUserByEmail(env.DB, "test@lawfirm.com")).toBe(testUserId);
  });

  it("returns null for unknown email", async () => {
    expect(await findUserByEmail(env.DB, "unknown@example.com")).toBeNull();
  });

  it("gets all channel links for a user", async () => {
    const userId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(
        userId,
        "Links User",
        `links-${Date.now()}@test.com`,
        1,
        Date.now(),
        Date.now()
      )
      .run();
    await linkChannelUser(env.DB, {
      channelType: "teams",
      channelUserId: `29:links-teams-${Date.now()}`,
      userId,
    });
    await linkChannelUser(env.DB, {
      channelType: "slack",
      channelUserId: `U-links-slack-${Date.now()}`,
      userId,
    });

    const links = await getUserChannelLinks(env.DB, userId);
    expect(links.length).toBe(2);
    expect(links.map((l) => l.channelType)).toContain("teams");
    expect(links.map((l) => l.channelType)).toContain("slack");
  });

  it("unlinks a channel user", async () => {
    const newTeamsUser = "29:unlinkable-user";
    await linkChannelUser(env.DB, {
      channelType: "teams",
      channelUserId: newTeamsUser,
      userId: testUserId,
    });
    expect(await findUserByChannelId(env.DB, "teams", newTeamsUser)).toBe(
      testUserId
    );
    expect(await unlinkChannelUser(env.DB, "teams", newTeamsUser)).toBe(true);
    expect(await findUserByChannelId(env.DB, "teams", newTeamsUser)).toBeNull();
  });

  it("returns false when unlinking non-existent link", async () => {
    expect(await unlinkChannelUser(env.DB, "teams", "non-existent")).toBe(
      false
    );
  });
});
