import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate, useRevalidator } from "react-router";
import type { Route } from "./+types/chat";
import { ENDPOINTS } from "~/lib/api";
import { API_URL } from "~/lib/auth-client";
import { orgLoader } from "~/lib/loader-auth";
import {
  useChat,
  type Message,
  type ProcessEvent,
  type PendingConfirmation,
} from "~/lib/use-chat";
import _styles from "~/styles/chat.module.css";

// =============================================================================
// Types (exported for use by chat.$conversationId.tsx)
// =============================================================================

export type {
  Message,
  ProcessEvent,
  PendingConfirmation,
} from "~/lib/use-chat";

export interface Conversation {
  id: string;
  title: string | null;
  updatedAt: number;
  messageCount: number;
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
// Component
// =============================================================================

interface ChatProps {
  loaderData: Route.ComponentProps["loaderData"] & ChatLoaderData;
}

export default function Chat({ loaderData }: ChatProps) {
  const {
    conversations: initialConversations,
    conversationId: initialConversationId,
    initialMessages,
    initialPendingConfirmations,
  } = loaderData;

  const navigate = useNavigate();
  const revalidator = useRevalidator();

  // Chat state via hook
  const {
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
  } = useChat({
    initialMessages,
    initialPendingConfirmations,
  });

  // Local UI state
  const [conversations, setConversations] =
    useState<Conversation[]>(initialConversations);
  const [currentConversationId, setCurrentConversationId] = useState<
    string | null
  >(initialConversationId || null);

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
    clearError();
    navigate(`/chat/${newId}`);
  }, [navigate, setMessages, clearError]);

  const handleSelectConversation = useCallback(
    async (conversationId: string) => {
      setCurrentConversationId(conversationId);
      await loadConversation(conversationId);
      navigate(`/chat/${conversationId}`);
    },
    [navigate, loadConversation]
  );

  const handleSendMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || isStreaming) return;

      const conversationId = currentConversationId || crypto.randomUUID();

      if (!currentConversationId) {
        setCurrentConversationId(conversationId);
        navigate(`/chat/${conversationId}`, { replace: true });
      }

      await sendMessage(conversationId, text);
      revalidator.revalidate();
    },
    [currentConversationId, isStreaming, navigate, revalidator, sendMessage]
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

        setConversations((prev) => prev.filter((c) => c.id !== conversationId));

        if (currentConversationId === conversationId) {
          setCurrentConversationId(null);
          setMessages([]);
          navigate("/chat");
        }

        revalidator.revalidate();
      } catch {
        // Error handling could be improved
      }
    },
    [currentConversationId, navigate, revalidator, setMessages]
  );

  // =============================================================================
  // Render
  // =============================================================================

  const isInputDisabled = isStreaming || pendingConfirmations.length > 0;

  return (
    <div className="chat-layout">
      <ChatSidebar
        conversations={conversations}
        currentId={currentConversationId}
        onSelect={handleSelectConversation}
        onNew={handleNewChat}
        onDelete={handleDeleteConversation}
      />

      <div className="chat-main">
        <ChatMessages
          messages={messages}
          isStreaming={isStreaming}
          pendingConfirmations={pendingConfirmations}
          onAccept={acceptConfirmation}
          onReject={rejectConfirmation}
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
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
}

function ChatMessages({
  messages,
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
