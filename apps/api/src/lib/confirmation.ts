const VALID_INTENTS = ["approve", "reject", "modify", "unrelated"] as const;
export type ConfirmationIntent = (typeof VALID_INTENTS)[number] | "unclear";

export interface ClassificationResult {
  intent: ConfirmationIntent;
  modifiedRequest?: string;
}

/**
 * Parses LLM classification response, extracting JSON from potentially messy output.
 */
export function parseClassificationJSON(text: string): ClassificationResult {
  const startIndex = text.indexOf("{");
  if (startIndex === -1) {
    return { intent: "unclear" };
  }

  // Find matching closing brace
  let depth = 0;
  let endIndex = -1;

  for (let i = startIndex; i < text.length; i++) {
    if (text[i] === "{") depth++;
    if (text[i] === "}") depth--;
    if (depth === 0) {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    return { intent: "unclear" };
  }

  try {
    const jsonString = text.slice(startIndex, endIndex + 1);
    const parsed = JSON.parse(jsonString) as Record<string, unknown>;

    const intent =
      typeof parsed.intent === "string" &&
      (VALID_INTENTS as readonly string[]).includes(parsed.intent)
        ? (parsed.intent as ConfirmationIntent)
        : "unclear";

    const modifiedRequest =
      intent === "modify" && typeof parsed.modifiedRequest === "string"
        ? parsed.modifiedRequest
        : undefined;

    return { intent, modifiedRequest };
  } catch {
    return { intent: "unclear" };
  }
}

export function isConfirmationExpired(expiresAt: number, now = Date.now()): boolean {
  return expiresAt < now;
}
