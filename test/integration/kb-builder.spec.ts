import { describe, it, expect } from "vitest";
import { extractMetadataFromPath, chunkText } from "../../src/services/kb-builder";

// ============================================================================
// extractMetadataFromPath Tests
// ============================================================================

describe("extractMetadataFromPath", () => {
  describe("general category", () => {
    it("extracts category from general folder", () => {
      const result = extractMetadataFromPath("general/billing.md");

      expect(result).toEqual({
        category: "general",
        jurisdiction: null,
        practice_type: null,
        firm_size: null,
      });
    });
  });

  describe("jurisdictions", () => {
    it("extracts state jurisdiction", () => {
      const result = extractMetadataFromPath("jurisdictions/CA/deadlines.md");

      expect(result).toEqual({
        category: null,
        jurisdiction: "CA",
        practice_type: null,
        firm_size: null,
      });
    });

    it("extracts federal jurisdiction", () => {
      const result = extractMetadataFromPath("jurisdictions/federal/rules.md");

      expect(result.jurisdiction).toBe("federal");
    });
  });

  describe("practice types", () => {
    it("extracts practice type from folder structure", () => {
      const result = extractMetadataFromPath(
        "practice-types/personal-injury/intake.md"
      );

      expect(result).toEqual({
        category: null,
        jurisdiction: null,
        practice_type: "personal-injury",
        firm_size: null,
      });
    });

    it("handles deeply nested paths", () => {
      const result = extractMetadataFromPath(
        "practice-types/family-law/subdir/nested/doc.md"
      );

      expect(result.practice_type).toBe("family-law");
    });
  });

  describe("firm sizes", () => {
    it("extracts solo firm size", () => {
      const result = extractMetadataFromPath("firm-sizes/solo/handbook.md");

      expect(result).toEqual({
        category: null,
        jurisdiction: null,
        practice_type: null,
        firm_size: "solo",
      });
    });

    it("extracts mid-sized firm", () => {
      const result = extractMetadataFromPath("firm-sizes/mid/scaling.md");

      expect(result.firm_size).toBe("mid");
    });
  });

  describe("unknown structures", () => {
    it("returns all nulls for unknown folder structure", () => {
      const result = extractMetadataFromPath("random/folder/file.md");

      expect(result).toEqual({
        category: null,
        jurisdiction: null,
        practice_type: null,
        firm_size: null,
      });
    });
  });
});

// ============================================================================
// chunkText Tests
// ============================================================================

describe("chunkText", () => {
  describe("basic chunking", () => {
    it("returns single chunk for short text", () => {
      const result = chunkText("This is a short paragraph.", 500);

      expect(result).toEqual(["This is a short paragraph."]);
    });

    it("handles empty text", () => {
      const result = chunkText("", 500);

      expect(result).toEqual([]);
    });

    it("handles whitespace-only text", () => {
      const result = chunkText("   \n\n   ", 500);

      expect(result).toEqual([]);
    });

    it("trims whitespace from chunks", () => {
      const result = chunkText("  Some content  ", 500);

      expect(result[0]).toBe("Some content");
    });
  });

  describe("section-based splitting", () => {
    it("respects ## header boundaries", () => {
      const text = `## Section One
Content one.

## Section Two
Content two.`;

      const chunks = chunkText(text, 500);

      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toContain("## Section One");
      expect(chunks[1]).toContain("## Section Two");
    });

    it("respects # header boundaries", () => {
      const text = `# Main Title
Intro.

# Second Title
More.`;

      const chunks = chunkText(text, 500);

      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toContain("# Main Title");
      expect(chunks[1]).toContain("# Second Title");
    });
  });

  describe("paragraph-based splitting", () => {
    it("splits long sections by paragraph", () => {
      const longParagraphA = "A".repeat(300);
      const longParagraphB = "B".repeat(300);
      const text = `${longParagraphA}\n\n${longParagraphB}`;

      const chunks = chunkText(text, 500);

      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toBe(longParagraphA);
      expect(chunks[1]).toBe(longParagraphB);
    });

    it("combines short paragraphs into single chunk", () => {
      const text = "Para one.\n\nPara two.\n\nPara three.";

      const chunks = chunkText(text, 500);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toContain("Para one.");
      expect(chunks[0]).toContain("Para three.");
    });
  });

  describe("custom maxChars", () => {
    it("respects custom maxChars parameter", () => {
      const text = `${"A".repeat(100)}\n\n${"B".repeat(100)}`;

      const result = chunkText(text, 150);

      expect(result).toHaveLength(2);
    });
  });

  describe("real-world content", () => {
    it("handles typical markdown content", () => {
      const text = `## Client Intake

1. Collect info
2. Verify conflict

## Fees

Discuss upfront.`;

      const chunks = chunkText(text, 500);

      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(chunks.some((c) => c.includes("Client Intake"))).toBe(true);
    });
  });
});
