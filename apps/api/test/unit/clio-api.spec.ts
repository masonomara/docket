// =============================================================================
// Clio API Client Unit Tests
// =============================================================================
//
// Tests for the Clio API client functions:
// - Query building (read, create, update, delete endpoints)
// - Response formatting for display

import { describe, it, expect } from "vitest";
import {
  buildReadQuery,
  buildCreateBody,
  buildUpdateBody,
  buildDeleteEndpoint,
  formatClioResponse,
} from "../../src/services/clio-api";

// =============================================================================
// Read Query Building Tests
// =============================================================================

describe("buildReadQuery", () => {
  describe("Basic Endpoint Building", () => {
    it("builds list endpoint for matter object type", () => {
      const query = buildReadQuery("matter");

      expect(query).toBe("/matters.json");
    });

    it("builds list endpoint for contact object type", () => {
      const query = buildReadQuery("contact");

      expect(query).toBe("/contacts.json");
    });

    it("handles uppercase object type", () => {
      const query = buildReadQuery("Matter");

      expect(query).toBe("/matters.json");
    });

    it("handles all-caps object type", () => {
      const query = buildReadQuery("CONTACT");

      expect(query).toBe("/contacts.json");
    });
  });

  describe("Single Record Queries", () => {
    it("builds endpoint with ID for fetching single record", () => {
      const query = buildReadQuery("matter", "123");

      expect(query).toBe("/matters/123.json");
    });
  });

  describe("Filter Parameters", () => {
    it("adds filter parameters to query string", () => {
      const query = buildReadQuery("task", undefined, {
        status: "pending",
        limit: 10,
      });

      expect(query).toContain("status=pending");
      expect(query).toContain("limit=10");
    });

    it("ignores null filter values", () => {
      const query = buildReadQuery("task", undefined, {
        status: "open",
        empty: null,
      });

      expect(query).toContain("status=open");
      expect(query).not.toContain("empty");
    });

    it("ignores undefined filter values", () => {
      const query = buildReadQuery("task", undefined, {
        status: "open",
        missing: undefined,
      });

      expect(query).toContain("status=open");
      expect(query).not.toContain("missing");
    });
  });

  describe("Field Selection", () => {
    it("adds fields parameter to query string", () => {
      const query = buildReadQuery("contact", undefined, undefined, [
        "id",
        "name",
      ]);

      // Fields are comma-separated and URL-encoded (%2C is comma)
      expect(query).toContain("fields=id%2Cname");
    });
  });

  describe("Object Type Validation", () => {
    it("throws error for unknown object type", () => {
      expect(() => buildReadQuery("unknown")).toThrow(
        "Unknown object type: unknown"
      );
    });

    it("supports all known object types", () => {
      const knownTypes = [
        "matter",
        "contact",
        "task",
        "calendar_entry",
        "time_entry",
        "document",
        "practice_area",
        "user",
      ];

      for (const objectType of knownTypes) {
        expect(() => buildReadQuery(objectType)).not.toThrow();
      }
    });
  });
});

// =============================================================================
// Create Body Building Tests
// =============================================================================

describe("buildCreateBody", () => {
  it("returns correct endpoint for object type", () => {
    const result = buildCreateBody("task", { name: "Review contract" });

    expect(result.endpoint).toBe("/tasks.json");
  });

  it("wraps data in Clio expected structure", () => {
    const result = buildCreateBody("task", { name: "Review contract" });

    // Clio expects: { data: { ...fields } }
    expect(result.body).toEqual({
      data: { name: "Review contract" },
    });
  });

  it("preserves nested objects in the data", () => {
    const result = buildCreateBody("task", {
      name: "Task with matter reference",
      matter: { id: 123 },
    });

    expect(result.body).toEqual({
      data: {
        name: "Task with matter reference",
        matter: { id: 123 },
      },
    });
  });

  it("throws error for unknown object type", () => {
    expect(() => buildCreateBody("unknown", {})).toThrow(
      "Unknown object type: unknown"
    );
  });
});

// =============================================================================
// Update Body Building Tests
// =============================================================================

describe("buildUpdateBody", () => {
  it("returns endpoint with record ID", () => {
    const result = buildUpdateBody("matter", "123", { status: "closed" });

    expect(result.endpoint).toBe("/matters/123.json");
  });

  it("wraps data in Clio expected structure", () => {
    const result = buildUpdateBody("matter", "123", { status: "closed" });

    // Clio expects: { data: { ...fields } }
    expect(result.body).toEqual({
      data: { status: "closed" },
    });
  });

  it("throws error for unknown object type", () => {
    expect(() => buildUpdateBody("unknown", "123", {})).toThrow(
      "Unknown object type: unknown"
    );
  });
});

// =============================================================================
// Delete Endpoint Building Tests
// =============================================================================

describe("buildDeleteEndpoint", () => {
  it("returns endpoint with record ID", () => {
    const endpoint = buildDeleteEndpoint("task", "123");

    expect(endpoint).toBe("/tasks/123.json");
  });

  it("throws error for unknown object type", () => {
    expect(() => buildDeleteEndpoint("unknown", "123")).toThrow(
      "Unknown object type: unknown"
    );
  });
});

// =============================================================================
// Response Formatting Tests
// =============================================================================

describe("formatClioResponse", () => {
  describe("Empty Results", () => {
    it("returns friendly message for empty array", () => {
      const formatted = formatClioResponse("matter", []);

      expect(formatted).toBe("No matter records found.");
    });
  });

  describe("Single Record", () => {
    it("formats single record with label", () => {
      const record = { id: 1, name: "John Doe" };

      const formatted = formatClioResponse("contact", record);

      expect(formatted).toContain("contact record:");
      expect(formatted).toContain('"id": 1');
      expect(formatted).toContain('"name": "John Doe"');
    });
  });

  describe("Multiple Records", () => {
    it("includes count in the header", () => {
      const records = [{ id: 1 }, { id: 2 }];

      const formatted = formatClioResponse("task", records);

      expect(formatted).toContain("Found 2 task record(s):");
    });
  });
});
