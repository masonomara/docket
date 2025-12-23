import { describe, it, expect } from "vitest";

describe("ChannelMessage Schema", () => {
  // Base valid message for testing
  const validMessage = {
    channel: "teams",
    orgId: "org-123",
    userId: "user-456",
    userRole: "member",
    conversationId: "conv-789",
    conversationScope: "personal",
    message: "Hello",
    jurisdictions: [],
    practiceTypes: [],
    firmSize: null,
  };

  describe("valid messages", () => {
    it("accepts a minimal valid message", async () => {
      const { ChannelMessageSchema } = await import("../../src/types");

      const result = ChannelMessageSchema.safeParse(validMessage);

      expect(result.success).toBe(true);
    });

    it("accepts message with jurisdictions and firm size", async () => {
      const { ChannelMessageSchema } = await import("../../src/types");

      const message = {
        ...validMessage,
        jurisdictions: ["CA"],
        firmSize: "small",
      };

      const result = ChannelMessageSchema.safeParse(message);

      expect(result.success).toBe(true);
    });

    it("accepts admin role with api scope", async () => {
      const { ChannelMessageSchema } = await import("../../src/types");

      const message = {
        ...validMessage,
        userRole: "admin",
        conversationScope: "api",
      };

      const result = ChannelMessageSchema.safeParse(message);

      expect(result.success).toBe(true);
    });
  });

  describe("invalid messages", () => {
    it("rejects invalid channel", async () => {
      const { ChannelMessageSchema } = await import("../../src/types");

      const message = { ...validMessage, channel: "invalid" };

      const result = ChannelMessageSchema.safeParse(message);

      expect(result.success).toBe(false);
    });

    it("rejects empty message", async () => {
      const { ChannelMessageSchema } = await import("../../src/types");

      const message = { ...validMessage, message: "" };

      const result = ChannelMessageSchema.safeParse(message);

      expect(result.success).toBe(false);
    });

    it("rejects message exceeding 10,000 characters", async () => {
      const { ChannelMessageSchema } = await import("../../src/types");

      const message = { ...validMessage, message: "x".repeat(10001) };

      const result = ChannelMessageSchema.safeParse(message);

      expect(result.success).toBe(false);
    });
  });

  describe("message length limits", () => {
    it("accepts exactly 10,000 characters", async () => {
      const { ChannelMessageSchema } = await import("../../src/types");

      const message = { ...validMessage, message: "x".repeat(10000) };

      const result = ChannelMessageSchema.safeParse(message);

      expect(result.success).toBe(true);
    });
  });
});
