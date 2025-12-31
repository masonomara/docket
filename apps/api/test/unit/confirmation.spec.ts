import { describe, it, expect } from "vitest";
import {
  parseClassificationJSON,
  isConfirmationExpired,
} from "../../src/lib/confirmation";

describe("parseClassificationJSON", () => {
  describe("valid responses", () => {
    it("parses approve intent", () => {
      const result = parseClassificationJSON('{"intent": "approve"}');
      expect(result).toEqual({ intent: "approve" });
    });

    it("parses reject intent", () => {
      const result = parseClassificationJSON('{"intent": "reject"}');
      expect(result).toEqual({ intent: "reject" });
    });

    it("parses modify intent with modifiedRequest", () => {
      const result = parseClassificationJSON(
        '{"intent": "modify", "modifiedRequest": "change the date to tomorrow"}'
      );
      expect(result).toEqual({
        intent: "modify",
        modifiedRequest: "change the date to tomorrow",
      });
    });

    it("parses unrelated intent", () => {
      const result = parseClassificationJSON('{"intent": "unrelated"}');
      expect(result).toEqual({ intent: "unrelated" });
    });
  });

  describe("messy LLM output", () => {
    it("extracts JSON from surrounding text", () => {
      const result = parseClassificationJSON(
        'Based on the response, I classify this as: {"intent": "approve"} because the user said yes.'
      );
      expect(result.intent).toBe("approve");
    });

    it("handles JSON with extra whitespace", () => {
      const result = parseClassificationJSON('  {  "intent" :  "reject"  }  ');
      expect(result.intent).toBe("reject");
    });

    it("handles nested objects in LLM response", () => {
      const result = parseClassificationJSON(
        'Here is my analysis: {"intent": "modify", "modifiedRequest": "use {different} format"}'
      );
      expect(result.intent).toBe("modify");
    });
  });

  describe("invalid responses", () => {
    it("returns unclear for empty string", () => {
      const result = parseClassificationJSON("");
      expect(result.intent).toBe("unclear");
    });

    it("returns unclear for no JSON", () => {
      const result = parseClassificationJSON("The user wants to approve this.");
      expect(result.intent).toBe("unclear");
    });

    it("returns unclear for unclosed JSON", () => {
      const result = parseClassificationJSON('{"intent": "approve"');
      expect(result.intent).toBe("unclear");
    });

    it("returns unclear for invalid JSON", () => {
      const result = parseClassificationJSON('{intent: approve}');
      expect(result.intent).toBe("unclear");
    });

    it("returns unclear for invalid intent value", () => {
      const result = parseClassificationJSON('{"intent": "maybe"}');
      expect(result.intent).toBe("unclear");
    });

    it("returns unclear for missing intent field", () => {
      const result = parseClassificationJSON('{"action": "approve"}');
      expect(result.intent).toBe("unclear");
    });

    it("returns unclear for non-string intent", () => {
      const result = parseClassificationJSON('{"intent": 123}');
      expect(result.intent).toBe("unclear");
    });
  });

  describe("modify intent edge cases", () => {
    it("ignores modifiedRequest for non-modify intents", () => {
      const result = parseClassificationJSON(
        '{"intent": "approve", "modifiedRequest": "ignored"}'
      );
      expect(result).toEqual({ intent: "approve" });
      expect(result.modifiedRequest).toBeUndefined();
    });

    it("handles modify without modifiedRequest", () => {
      const result = parseClassificationJSON('{"intent": "modify"}');
      expect(result).toEqual({ intent: "modify" });
      expect(result.modifiedRequest).toBeUndefined();
    });

    it("ignores non-string modifiedRequest", () => {
      const result = parseClassificationJSON(
        '{"intent": "modify", "modifiedRequest": 123}'
      );
      expect(result).toEqual({ intent: "modify" });
      expect(result.modifiedRequest).toBeUndefined();
    });
  });
});

describe("isConfirmationExpired", () => {
  it("returns true when expiresAt is in the past", () => {
    const pastTime = Date.now() - 1000;
    expect(isConfirmationExpired(pastTime)).toBe(true);
  });

  it("returns false when expiresAt is in the future", () => {
    const futureTime = Date.now() + 60000;
    expect(isConfirmationExpired(futureTime)).toBe(false);
  });

  it("returns false when expiresAt equals now (not yet expired)", () => {
    const now = Date.now();
    expect(isConfirmationExpired(now, now)).toBe(false);
  });

  it("uses custom now parameter for testing", () => {
    const expiresAt = 1000;
    expect(isConfirmationExpired(expiresAt, 500)).toBe(false);
    expect(isConfirmationExpired(expiresAt, 1500)).toBe(true);
  });
});
