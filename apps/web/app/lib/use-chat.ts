import { useState, useCallback, useEffect } from "react";
import { ENDPOINTS } from "~/lib/api";
import { API_URL } from "~/lib/auth-client";

// =============================================================================
// Types
// =============================================================================

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "complete" | "streaming" | "error";
  createdAt: number;
}

export interface ProcessEvent {
  id: string;
  type: string;
  status?: string;
  timestamp: number;
  durationMs?: number;
  text?: string;

  // Embedding-specific
  query?: string;

  // KB Search-specific
  filters?: {
    jurisdictions?: string[];
    practiceTypes?: string[];
    firmSize?: string;
  };
  matchCount?: number;
  chunks?: Array<{
    source: string;
    preview: string;
    score?: number;
  }>;

  // Context retrieved summary
  kbCount?: number;
  orgCount?: number;
  totalTokens?: number;
  sources?: Array<{
    type: "kb" | "org";
    source: string;
    preview: string;
  }>;

  // Clio schema
  customFieldCount?: number;
  cached?: boolean;

  // History loaded
  messageCount?: number;

  // Prompt building
  components?: {
    ragContext: boolean;
    customFields: boolean;
    userRole: string;
    toolsEnabled: string[];
  };
  promptLength?: number;

  // LLM-specific
  model?: string;
  hasToolCalls?: boolean;
  toolCallCount?: number;

  // Clio-specific
  operation?: string;
  objectType?: string;
  count?: number;
  preview?: {
    items: Array<{ name: string; id?: string }>;
    totalCount: number;
  };
  success?: boolean;
}

export interface PendingConfirmation {
  id: string;
  action: string;
  objectType: string;
  params: Record<string, unknown>;
  expiresAt: number;
}

interface UseChatOptions {
  initialMessages?: Message[];
  initialPendingConfirmations?: PendingConfirmation[];
}

interface UseChatReturn {
  messages: Message[];
  processEvents: ProcessEvent[];
  pendingConfirmations: PendingConfirmation[];
  isStreaming: boolean;
  error: string | null;
  sendMessage: (conversationId: string, message: string) => Promise<void>;
  acceptConfirmation: (confirmationId: string) => Promise<void>;
  rejectConfirmation: (confirmationId: string) => Promise<void>;
  loadConversation: (conversationId: string) => Promise<void>;
  clearError: () => void;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
}

// =============================================================================
// SSE Parser
// =============================================================================

async function parseSSE(
  response: Response,
  onEvent: (event: string, data: unknown) => void
): Promise<void> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    let currentEvent = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7);
      } else if (line.startsWith("data: ") && currentEvent) {
        try {
          const data = JSON.parse(line.slice(6));
          onEvent(currentEvent, data);
        } catch {
          // Skip malformed JSON
        }
        currentEvent = "";
      }
    }
  }
}

// =============================================================================
// useChat Hook
// =============================================================================

export function useChat(options: UseChatOptions = {}): UseChatReturn {
  // Initialize with initialMessages if provided, otherwise empty array
  // Note: We DON'T reset to [] when initialMessages is undefined on re-renders
  const [messages, setMessages] = useState<Message[]>(() =>
    options.initialMessages && options.initialMessages.length > 0
      ? options.initialMessages
      : []
  );
  const [processEvents, setProcessEvents] = useState<ProcessEvent[]>([]);
  const [pendingConfirmations, setPendingConfirmations] = useState<
    PendingConfirmation[]
  >(options.initialPendingConfirmations || []);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync messages when initialMessages prop has content
  // This handles page refresh where useState initialized empty but loader has data
  // IMPORTANT: We only sync when initialMessages is defined AND has content
  // If initialMessages is undefined (base /chat route), we preserve existing messages
  useEffect(() => {
    // Only sync if we actually have messages from the loader
    // Don't clear messages just because initialMessages is undefined
    if (options.initialMessages !== undefined) {
      if (options.initialMessages.length > 0) {
        setMessages(options.initialMessages);
      }
      // If initialMessages is an empty array (new conversation), clear messages
      else {
        setMessages([]);
      }
    }
    // If initialMessages is undefined, preserve current messages (don't clear)
  }, [options.initialMessages]);

  const clearError = useCallback(() => setError(null), []);

  const sendMessage = useCallback(
    async (conversationId: string, message: string) => {
      if (!message.trim() || isStreaming) return;

      // Add user message optimistically
      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: message,
        status: "complete",
        createdAt: Date.now(),
      };

      // Add placeholder assistant message
      const assistantMessage: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "",
        status: "streaming",
        createdAt: Date.now(),
      };

      setMessages((prev) => [...prev, userMessage, assistantMessage]);
      setProcessEvents([]);
      setIsStreaming(true);
      setError(null);

      try {
        const response = await fetch(`${API_URL}${ENDPOINTS.chat.send}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ conversationId, message }),
        });

        if (!response.ok) {
          throw new Error("Failed to send message");
        }

        await parseSSE(response, (event, data) => {
          const eventData = data as Record<string, unknown>;

          switch (event) {
            case "content":
              setMessages((prev) => {
                const updated = [...prev];
                const lastIdx = updated.length - 1;
                if (updated[lastIdx]?.status === "streaming") {
                  updated[lastIdx] = {
                    ...updated[lastIdx],
                    content:
                      updated[lastIdx].content + (eventData.text as string),
                  };
                }
                return updated;
              });
              break;

            case "process":
              setProcessEvents((prev) => [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  timestamp: Date.now(),
                  ...(eventData as Omit<ProcessEvent, "id" | "timestamp">),
                },
              ]);
              break;

            case "confirmation_required":
              setPendingConfirmations((prev) => [
                ...prev,
                {
                  id: eventData.confirmationId as string,
                  action: eventData.action as string,
                  objectType: eventData.objectType as string,
                  params: eventData.params as Record<string, unknown>,
                  expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
                },
              ]);
              break;

            case "error":
              setError(eventData.message as string);
              setMessages((prev) => {
                const updated = [...prev];
                const lastIdx = updated.length - 1;
                if (updated[lastIdx]?.status === "streaming") {
                  updated[lastIdx] = {
                    ...updated[lastIdx],
                    status: "error",
                    content:
                      updated[lastIdx].content || (eventData.message as string),
                  };
                }
                return updated;
              });
              break;

            case "done":
              setMessages((prev) => {
                const updated = [...prev];
                const lastIdx = updated.length - 1;
                if (updated[lastIdx]?.status === "streaming") {
                  updated[lastIdx] = {
                    ...updated[lastIdx],
                    status: "complete",
                  };
                }
                return updated;
              });
              break;
          }
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to send");
        setMessages((prev) => {
          const updated = [...prev];
          const lastIdx = updated.length - 1;
          if (updated[lastIdx]?.status === "streaming") {
            updated[lastIdx] = { ...updated[lastIdx], status: "error" };
          }
          return updated;
        });
      } finally {
        setIsStreaming(false);
      }
    },
    [isStreaming]
  );

  const acceptConfirmation = useCallback(async (confirmationId: string) => {
    setIsStreaming(true);

    try {
      const response = await fetch(
        `${API_URL}${ENDPOINTS.chat.acceptConfirmation(confirmationId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
        }
      );

      if (!response.ok) {
        throw new Error("Failed to accept confirmation");
      }

      // Add placeholder for result
      const resultMessage: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "",
        status: "streaming",
        createdAt: Date.now(),
      };
      setMessages((prev) => [...prev, resultMessage]);

      await parseSSE(response, (event, data) => {
        const eventData = data as Record<string, unknown>;

        if (event === "content") {
          setMessages((prev) => {
            const updated = [...prev];
            const lastIdx = updated.length - 1;
            if (updated[lastIdx]?.status === "streaming") {
              updated[lastIdx] = {
                ...updated[lastIdx],
                content: updated[lastIdx].content + (eventData.text as string),
              };
            }
            return updated;
          });
        } else if (event === "done") {
          setMessages((prev) => {
            const updated = [...prev];
            const lastIdx = updated.length - 1;
            if (updated[lastIdx]?.status === "streaming") {
              updated[lastIdx] = { ...updated[lastIdx], status: "complete" };
            }
            return updated;
          });
        }
      });

      // Remove the confirmation
      setPendingConfirmations((prev) =>
        prev.filter((c) => c.id !== confirmationId)
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to confirm");
    } finally {
      setIsStreaming(false);
    }
  }, []);

  const rejectConfirmation = useCallback(async (confirmationId: string) => {
    try {
      const response = await fetch(
        `${API_URL}${ENDPOINTS.chat.rejectConfirmation(confirmationId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
        }
      );

      if (!response.ok) {
        throw new Error("Failed to reject confirmation");
      }

      // Remove the confirmation
      setPendingConfirmations((prev) =>
        prev.filter((c) => c.id !== confirmationId)
      );

      // Add cancellation message
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: "Operation cancelled.",
          status: "complete",
          createdAt: Date.now(),
        },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel");
    }
  }, []);

  const loadConversation = useCallback(async (conversationId: string) => {
    setProcessEvents([]);
    setError(null);

    try {
      const response = await fetch(
        `${API_URL}${ENDPOINTS.chat.conversation(conversationId)}`,
        { credentials: "include" }
      );

      if (!response.ok) {
        throw new Error("Failed to load conversation");
      }

      const data = (await response.json()) as {
        messages: Message[];
        pendingConfirmations: PendingConfirmation[];
      };

      setMessages(data.messages || []);
      setPendingConfirmations(data.pendingConfirmations || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    }
  }, []);

  return {
    messages,
    processEvents,
    pendingConfirmations,
    isStreaming,
    error,
    sendMessage,
    acceptConfirmation,
    rejectConfirmation,
    loadConversation,
    clearError,
    setMessages,
  };
}
