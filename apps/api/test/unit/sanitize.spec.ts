import { describe, it, expect } from "vitest";
import { sanitizeAuditParams } from "../../src/lib/sanitize";

describe("sanitizeAuditParams", () => {
  describe("PII redaction", () => {
    it("redacts common PII fields", () => {
      const input = {
        name: "John Doe",
        email: "john@example.com",
        phone_number: "555-1234",
        address: "123 Main St",
        description: "Some private notes",
      };

      const result = sanitizeAuditParams(input);

      expect(result.name).toBe("[REDACTED]");
      expect(result.email).toBe("[REDACTED]");
      expect(result.phone_number).toBe("[REDACTED]");
      expect(result.address).toBe("[REDACTED]");
      expect(result.description).toBe("[REDACTED]");
    });

    it("redacts Clio-specific PII fields", () => {
      const input = {
        primary_email_address: "primary@example.com",
        billing_address: "456 Business Ave",
        first_name: "Bob",
        last_name: "Smith",
      };

      const result = sanitizeAuditParams(input);

      expect(result.primary_email_address).toBe("[REDACTED]");
      expect(result.billing_address).toBe("[REDACTED]");
      expect(result.first_name).toBe("[REDACTED]");
    });
  });

  describe("safe field preservation", () => {
    it("preserves ID fields", () => {
      const input = {
        id: "m-123",
        object_id: "c-456",
        client_id: "cli-789",
      };

      const result = sanitizeAuditParams(input);

      expect(result.id).toBe("m-123");
      expect(result.object_id).toBe("c-456");
      expect(result.client_id).toBe("cli-789");
    });

    it("preserves type and status fields", () => {
      const input = {
        objectType: "Matter",
        status: "open",
        count: 5,
      };

      const result = sanitizeAuditParams(input);

      expect(result.objectType).toBe("Matter");
      expect(result.status).toBe("open");
      expect(result.count).toBe(5);
    });

    it("preserves numbers and booleans", () => {
      const input = {
        amount: 1500.5,
        is_billable: true,
      };

      const result = sanitizeAuditParams(input);

      expect(result.amount).toBe(1500.5);
      expect(result.is_billable).toBe(true);
    });
  });

  describe("unknown field handling", () => {
    it("redacts unknown string fields", () => {
      const input = {
        custom: "potentially sensitive",
      };

      const result = sanitizeAuditParams(input);

      expect(result.custom).toBe("[REDACTED]");
    });
  });

  describe("nested structures", () => {
    it("recursively sanitizes nested objects", () => {
      const input = {
        client: { name: "Jane", id: "c-1" },
      };

      const result = sanitizeAuditParams(input);

      expect(result.client).toEqual({
        name: "[REDACTED]",
        id: "c-1",
      });
    });

    it("recursively sanitizes arrays of objects", () => {
      const input = {
        contacts: [{ name: "C1", email: "a@b.com" }],
      };

      const result = sanitizeAuditParams(input);

      expect(result.contacts).toEqual([
        { name: "[REDACTED]", email: "[REDACTED]" },
      ]);
    });
  });

  describe("edge cases", () => {
    it("handles null and undefined", () => {
      const input = { a: null, b: undefined };

      const result = sanitizeAuditParams(input);

      expect(result).toEqual({ a: null, b: undefined });
    });

    it("handles empty objects", () => {
      expect(sanitizeAuditParams({})).toEqual({});
    });
  });
});
