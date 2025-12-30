import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate, useRevalidator } from "react-router";
import type { Route } from "./+types/chat";
import { ENDPOINTS } from "~/lib/api";
import { API_URL } from "~/lib/auth-client";
import { orgLoader } from "~/lib/loader-auth";
// Styles will be wired up in Part 5
import _styles from "~/styles/chat.module.css";

// =============================================================================
// Types (exported for use by chat.$conversationId.tsx)
// =============================================================================

export interface Conversation {
  id: string;
  title: string | null;
  updatedAt: number;
  messageCount: number;
}

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
  data?: Record<string, unknown>;
  timestamp: number;
}

export interface PendingConfirmation {
  id: string;
  action: string;
  objectType: string;
  params: Record<string, unknown>;
  expiresAt: number;
}

export interface ChatLoaderData {
  conversations: Conversation[];
  conversationId?: string;
  initialMessages?: Message[];
  initialPendingConfirmations?: PendingConfirmation[];
}

// =============================================================================
// Loader
// =============================================================================

export const loader = orgLoader(async ({ user, org, fetch }, _args) => {
  const response = await fetch(ENDPOINTS.chat.conversations);

  let conversations: Conversation[] = [];
  if (response.ok) {
    const data = (await response.json()) as { conversations: Conversation[] };
    conversations = data.conversations;
  }

  return { user, org, conversations };
});

// =============================================================================
// SSE Parser (exported for use by chat.$conversationId.tsx)
// =============================================================================

export async function parseSSE(
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
// Component
// =============================================================================

export default function Chat({ loaderData }: Route.ComponentProps) {
  const {
    user,
    org,
    conversations: initialConversations,
    conversationId: initialConversationId,
    initialMessages,
    initialPendingConfirmations,
  } = loaderData as Route.ComponentProps["loaderData"] & ChatLoaderData;
  const navigate = useNavigate();
  const revalidator = useRevalidator();

  // State - initialize with any data from loader
  const [conversations, setConversations] =
    useState<Conversation[]>(initialConversations);
  const [currentConversationId, setCurrentConversationId] = useState<
    string | null
  >(initialConversationId || null);
  const [messages, setMessages] = useState<Message[]>(initialMessages || []);
  const [processEvents, setProcessEvents] = useState<ProcessEvent[]>([]);
  const [pendingConfirmations, setPendingConfirmations] = useState<
    PendingConfirmation[]
  >(initialPendingConfirmations || []);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // =============================================================================
  // Handlers
  // =============================================================================

  const handleNewChat = useCallback(() => {
    const newId = crypto.randomUUID();
    setCurrentConversationId(newId);
    setMessages([]);
    setProcessEvents([]);
    setPendingConfirmations([]);
    setError(null);
    navigate(`/chat/${newId}`);
  }, [navigate]);

  const handleSelectConversation = useCallback(
    async (conversationId: string) => {
      setCurrentConversationId(conversationId);
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

        setMessages(data.messages);
        setPendingConfirmations(data.pendingConfirmations || []);
        navigate(`/chat/${conversationId}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load");
      }
    },
    [navigate]
  );

  const handleSendMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || isStreaming) return;

      const conversationId = currentConversationId || crypto.randomUUID();

      if (!currentConversationId) {
        setCurrentConversationId(conversationId);
        navigate(`/chat/${conversationId}`, { replace: true });
      }

      // Add user message optimistically
      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: text,
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
          body: JSON.stringify({ conversationId, message: text }),
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
                  type: eventData.type as string,
                  status: eventData.status as string | undefined,
                  data: eventData,
                  timestamp: Date.now(),
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
                  expiresAt: Date.now() + 5 * 60 * 1000,
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

        // Refresh conversation list
        revalidator.revalidate();
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
    [currentConversationId, isStreaming, navigate, revalidator]
  );

  const handleAcceptConfirmation = useCallback(
    async (confirmationId: string) => {
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
                  content:
                    updated[lastIdx].content + (eventData.text as string),
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
    },
    []
  );

  const handleRejectConfirmation = useCallback(
    async (confirmationId: string) => {
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
    },
    []
  );

  const handleDeleteConversation = useCallback(
    async (conversationId: string) => {
      if (!confirm("Delete this conversation?")) return;

      try {
        const response = await fetch(
          `${API_URL}${ENDPOINTS.chat.conversation(conversationId)}`,
          {
            method: "DELETE",
            credentials: "include",
          }
        );

        if (!response.ok) {
          throw new Error("Failed to delete conversation");
        }

        // Update local state
        setConversations((prev) => prev.filter((c) => c.id !== conversationId));

        // Clear current conversation if deleted
        if (currentConversationId === conversationId) {
          setCurrentConversationId(null);
          setMessages([]);
          navigate("/chat");
        }

        revalidator.revalidate();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to delete");
      }
    },
    [currentConversationId, navigate, revalidator]
  );

  // =============================================================================
  // Render
  // =============================================================================

  const isInputDisabled = isStreaming || pendingConfirmations.length > 0;

  return (
    <div className="chat-layout">
      {/* Sidebar */}
      <ChatSidebar
        conversations={conversations}
        currentId={currentConversationId}
        onSelect={handleSelectConversation}
        onNew={handleNewChat}
        onDelete={handleDeleteConversation}
      />

      {/* Main chat area */}
      <div className="chat-main">
        <ChatMessages
          messages={messages}
          isStreaming={isStreaming}
          pendingConfirmations={pendingConfirmations}
          onAccept={handleAcceptConfirmation}
          onReject={handleRejectConfirmation}
          messagesEndRef={messagesEndRef}
        />

        {error && <div className="chat-error">{error}</div>}

        <ChatInput
          onSend={handleSendMessage}
          disabled={isInputDisabled}
          placeholder={
            isInputDisabled ? "Waiting for response..." : "Type a message..."
          }
        />
      </div>

      {/* Process log */}
      <ProcessLog events={processEvents} />
    </div>
  );
}

// =============================================================================
// ChatSidebar Component
// =============================================================================

interface ChatSidebarProps {
  conversations: Conversation[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}

function ChatSidebar({
  conversations,
  currentId,
  onSelect,
  onNew,
  onDelete,
}: ChatSidebarProps) {
  function formatRelativeTime(timestamp: number): string {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  }

  return (
    <aside className="chat-sidebar">
      <div className="chat-sidebar-header">
        <button className="btn btn-primary btn-sm" onClick={onNew}>
          New Chat
        </button>
      </div>

      <div className="chat-sidebar-list">
        {conversations.map((conv) => (
          <div
            key={conv.id}
            className={`chat-sidebar-item ${
              currentId === conv.id ? "active" : ""
            }`}
            onClick={() => onSelect(conv.id)}
          >
            <div className="chat-sidebar-item-content">
              <span className="chat-sidebar-item-title">
                {conv.title || "New conversation"}
              </span>
              <span className="chat-sidebar-item-meta">
                {formatRelativeTime(conv.updatedAt)} · {conv.messageCount} msgs
              </span>
            </div>
            <button
              className="chat-sidebar-item-delete"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(conv.id);
              }}
              aria-label="Delete conversation"
            >
              ×
            </button>
          </div>
        ))}

        {conversations.length === 0 && (
          <div className="chat-sidebar-empty">No conversations yet</div>
        )}
      </div>
    </aside>
  );
}

// =============================================================================
// ChatMessages Component
// =============================================================================

interface ChatMessagesProps {
  messages: Message[];
  isStreaming: boolean;
  pendingConfirmations: PendingConfirmation[];
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  messagesEndRef: React.RefObject<HTMLDivElement>;
}

function ChatMessages({
  messages,
  isStreaming,
  pendingConfirmations,
  onAccept,
  onReject,
  messagesEndRef,
}: ChatMessagesProps) {
  return (
    <div className="chat-messages">
      {messages.length === 0 && (
        <div className="chat-messages-empty">
          <p>Start a conversation with Docket</p>
        </div>
      )}

      {messages.map((msg) => (
        <div
          key={msg.id}
          className={`chat-message chat-message-${msg.role} ${
            msg.status === "error" ? "chat-message-error" : ""
          }`}
        >
          <div className="chat-message-content">
            {msg.content}
            {msg.status === "streaming" && (
              <span className="chat-message-typing">▊</span>
            )}
          </div>
        </div>
      ))}

      {pendingConfirmations.map((conf) => (
        <div key={conf.id} className="chat-confirmation">
          <div className="chat-confirmation-header">
            Docket wants to {conf.action} a {conf.objectType}
          </div>
          <div className="chat-confirmation-params">
            {Object.entries(conf.params).map(([key, value]) => (
              <div key={key} className="chat-confirmation-param">
                <span className="chat-confirmation-param-key">{key}:</span>
                <span className="chat-confirmation-param-value">
                  {String(value)}
                </span>
              </div>
            ))}
          </div>
          <div className="chat-confirmation-actions">
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => onReject(conf.id)}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => onAccept(conf.id)}
            >
              Confirm
            </button>
          </div>
        </div>
      ))}

      <div ref={messagesEndRef} />
    </div>
  );
}

// =============================================================================
// ChatInput Component
// =============================================================================

interface ChatInputProps {
  onSend: (message: string) => void;
  disabled: boolean;
  placeholder: string;
}

function ChatInput({ onSend, disabled, placeholder }: ChatInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function handleSubmit() {
    if (value.trim() && !disabled) {
      onSend(value.trim());
      setValue("");
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  }, [value]);

  return (
    <div className="chat-input-area">
      <textarea
        ref={textareaRef}
        className="chat-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
      />
      <button
        className="btn btn-primary chat-input-submit"
        onClick={handleSubmit}
        disabled={disabled || !value.trim()}
      >
        Send
      </button>
    </div>
  );
}

// =============================================================================
// ProcessLog Component
// =============================================================================

interface ProcessLogProps {
  events: ProcessEvent[];
}

function ProcessLog({ events }: ProcessLogProps) {
  function getEventLabel(event: ProcessEvent): string {
    switch (event.type) {
      case "started":
        return "Processing...";
      case "rag_lookup":
        return event.status === "started"
          ? "Searching knowledge base..."
          : "Knowledge base search complete";
      case "llm_thinking":
        return "Thinking...";
      case "clio_call":
        return `Querying Clio: ${event.data?.objectType || "data"}...`;
      case "clio_result":
        return `Found ${event.data?.count || 0} results`;
      default:
        return event.type;
    }
  }

  return (
    <aside className="process-log">
      <div className="process-log-header">Process Log</div>
      <div className="process-log-events">
        {events.length === 0 && (
          <div className="process-log-empty">No activity yet</div>
        )}
        {events.map((event) => (
          <div key={event.id} className="process-log-event">
            <span className="process-log-event-dot" />
            <span className="process-log-event-label">
              {getEventLabel(event)}
            </span>
          </div>
        ))}
      </div>
    </aside>
  );
}
