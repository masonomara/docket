import { useState, useCallback, useRef } from "react";
import { ENDPOINTS } from "./api";
import { API_URL } from "./auth-client";
import type {
  ChatMessage,
  PendingConfirmation,
  ProcessEvent,
  Conversation,
  ConversationDetail,
} from "./types";

// ============================================================================
// Types
// ============================================================================

interface UseChatOptions {
  conversationId: string;
  onConversationCreated?: () => void;
}

interface UseChatReturn {
  messages: ChatMessage[];
  processEvents: ProcessEvent[];
  pendingConfirmation: PendingConfirmation | null;
  isLoading: boolean;
  error: string | null;
  sendMessage: (content: string) => Promise<void>;
  acceptConfirmation: () => Promise<void>;
  rejectConfirmation: () => Promise<void>;
  loadConversation: (conversationId: string) => Promise<void>;
  clearMessages: () => void;
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Custom hook for managing chat state and SSE streaming.
 *
 * This is the core of the chat interface. It handles:
 * 1. Sending messages via POST and receiving SSE responses
 * 2. Parsing SSE events and updating UI state
 * 3. Managing pending Clio confirmations
 * 4. Loading existing conversations
 */
export function useChat({
  conversationId,
  onConversationCreated,
}: UseChatOptions): UseChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [processEvents, setProcessEvents] = useState<ProcessEvent[]>([]);
  const [pendingConfirmation, setPendingConfirmation] =
    useState<PendingConfirmation | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track the current streaming message ID
  const streamingMessageIdRef = useRef<string | null>(null);

  /**
   * Parses SSE events from a buffer string.
   * Returns parsed events and any remaining incomplete data.
   */
  function parseSSEEvents(buffer: string): {
    events: Array<{ event: string; data: string }>;
    remaining: string;
  } {
    const events: Array<{ event: string; data: string }> = [];
    const lines = buffer.split("\n");
    let remaining = "";

    let currentEvent = "";
    let currentData = "";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Check if this is the last incomplete line
      if (i === lines.length - 1 && line !== "") {
        remaining = line;
        break;
      }

      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7);
      } else if (line.startsWith("data: ")) {
        currentData = line.slice(6);
      } else if (line === "") {
        // Empty line = end of event
        if (currentEvent && currentData) {
          events.push({ event: currentEvent, data: currentData });
        }
        currentEvent = "";
        currentData = "";
      }
    }

    return { events, remaining };
  }

  /**
   * Handles a single SSE event, updating appropriate state.
   */
  function handleSSEEvent(event: string, data: string) {
    try {
      const parsed = JSON.parse(data);

      switch (event) {
        case "content":
          // Append content to the streaming message
          if (streamingMessageIdRef.current) {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === streamingMessageIdRef.current
                  ? { ...msg, content: msg.content + (parsed.text || "") }
                  : msg
              )
            );
          }
          break;

        case "process":
          // Add to process log
          setProcessEvents((prev) => [
            ...prev,
            {
              type: parsed.type,
              status: parsed.status,
              timestamp: Date.now(),
              details: parsed,
            },
          ]);
          break;

        case "confirmation_required":
          // Store pending confirmation
          setPendingConfirmation({
            id: parsed.confirmationId,
            action: parsed.action,
            objectType: parsed.objectType,
            params: parsed.params,
          });
          break;

        case "done":
          // Stream complete - mark message as complete
          if (streamingMessageIdRef.current) {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === streamingMessageIdRef.current
                  ? { ...msg, status: "complete" }
                  : msg
              )
            );
            streamingMessageIdRef.current = null;
          }
          break;

        case "error":
          // Mark message as error
          if (streamingMessageIdRef.current) {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === streamingMessageIdRef.current
                  ? {
                      ...msg,
                      status: "error",
                      content:
                        msg.content || parsed.message || "An error occurred",
                    }
                  : msg
              )
            );
            streamingMessageIdRef.current = null;
          }
          setError(parsed.message || "An error occurred");
          break;
      }
    } catch {
      console.error("Failed to parse SSE event data:", data);
    }
  }

  /**
   * Sends a message and handles the SSE response stream.
   */
  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim() || isLoading) return;

      setError(null);
      setIsLoading(true);
      setProcessEvents([]);

      // Add user message immediately
      const userMessageId = crypto.randomUUID();
      const userMessage: ChatMessage = {
        id: userMessageId,
        role: "user",
        content: content.trim(),
        status: "complete",
        createdAt: Date.now(),
      };
      setMessages((prev) => [...prev, userMessage]);

      // Create placeholder for assistant response
      const assistantMessageId = crypto.randomUUID();
      const assistantMessage: ChatMessage = {
        id: assistantMessageId,
        role: "assistant",
        content: "",
        status: "streaming",
        createdAt: Date.now(),
      };
      setMessages((prev) => [...prev, assistantMessage]);
      streamingMessageIdRef.current = assistantMessageId;

      try {
        const response = await fetch(`${API_URL}${ENDPOINTS.chat.send}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            conversationId,
            message: content.trim(),
          }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            (errorData as { error?: string }).error || "Failed to send message"
          );
        }

        // Handle SSE stream
        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error("No response body");
        }

        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const { events, remaining } = parseSSEEvents(buffer);
          buffer = remaining;

          for (const { event, data } of events) {
            handleSSEEvent(event, data);
          }
        }

        // Notify that conversation was created (for sidebar refresh)
        onConversationCreated?.();
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Failed to send message";
        setError(errorMessage);

        // Mark message as error
        if (streamingMessageIdRef.current) {
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === streamingMessageIdRef.current
                ? { ...msg, status: "error", content: errorMessage }
                : msg
            )
          );
          streamingMessageIdRef.current = null;
        }
      } finally {
        setIsLoading(false);
      }
    },
    [conversationId, isLoading, onConversationCreated]
  );

  /**
   * Accepts a pending Clio confirmation.
   */
  const acceptConfirmation = useCallback(async () => {
    if (!pendingConfirmation) return;

    setError(null);
    setIsLoading(true);

    try {
      const response = await fetch(
        `${API_URL}${ENDPOINTS.chat.acceptConfirmation(pendingConfirmation.id)}`,
        {
          method: "POST",
          credentials: "include",
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          (errorData as { error?: string }).error ||
            "Failed to accept confirmation"
        );
      }

      const result = (await response.json()) as {
        success: boolean;
        message?: string;
      };

      // Add confirmation result as a message
      const resultMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content:
          result.message ||
          `${pendingConfirmation.action} ${pendingConfirmation.objectType} completed.`,
        status: "complete",
        createdAt: Date.now(),
      };
      setMessages((prev) => [...prev, resultMessage]);
      setPendingConfirmation(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to accept confirmation"
      );
    } finally {
      setIsLoading(false);
    }
  }, [pendingConfirmation]);

  /**
   * Rejects a pending Clio confirmation.
   */
  const rejectConfirmation = useCallback(async () => {
    if (!pendingConfirmation) return;

    setError(null);
    setIsLoading(true);

    try {
      const response = await fetch(
        `${API_URL}${ENDPOINTS.chat.rejectConfirmation(pendingConfirmation.id)}`,
        {
          method: "POST",
          credentials: "include",
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          (errorData as { error?: string }).error ||
            "Failed to reject confirmation"
        );
      }

      // Add cancellation message
      const cancelMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: `Cancelled ${pendingConfirmation.action} ${pendingConfirmation.objectType}.`,
        status: "complete",
        createdAt: Date.now(),
      };
      setMessages((prev) => [...prev, cancelMessage]);
      setPendingConfirmation(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to reject confirmation"
      );
    } finally {
      setIsLoading(false);
    }
  }, [pendingConfirmation]);

  /**
   * Loads an existing conversation's messages.
   */
  const loadConversation = useCallback(async (id: string) => {
    setError(null);
    setIsLoading(true);
    setMessages([]);
    setProcessEvents([]);
    setPendingConfirmation(null);

    try {
      const response = await fetch(
        `${API_URL}${ENDPOINTS.chat.conversation(id)}`,
        {
          credentials: "include",
        }
      );

      if (!response.ok) {
        if (response.status === 404) {
          // New conversation, no messages yet
          return;
        }
        throw new Error("Failed to load conversation");
      }

      const data = (await response.json()) as {
        conversation: ConversationDetail;
        messages: ChatMessage[];
        pendingConfirmations: PendingConfirmation[];
      };

      setMessages(data.messages || []);

      // Load any pending confirmations
      if (data.pendingConfirmations?.length > 0) {
        setPendingConfirmation(data.pendingConfirmations[0]);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load conversation"
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * Clears all messages and resets state.
   */
  const clearMessages = useCallback(() => {
    setMessages([]);
    setProcessEvents([]);
    setPendingConfirmation(null);
    setError(null);
  }, []);

  return {
    messages,
    processEvents,
    pendingConfirmation,
    isLoading,
    error,
    sendMessage,
    acceptConfirmation,
    rejectConfirmation,
    loadConversation,
    clearMessages,
  };
}
