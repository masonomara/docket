import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useRevalidator } from "react-router";
import type { Route } from "./+types/chat.$conversationId";
import { ENDPOINTS } from "~/lib/api";
import { orgLoader } from "~/lib/loader-auth";
import {
  useChat,
  type Message,
  type ProcessEvent,
  type PendingConfirmation,
} from "~/lib/use-chat";
import styles from "~/styles/chat.module.css";

// =============================================================================
// Loader - fetches the specific conversation's messages
// =============================================================================

export const loader = orgLoader(async ({ fetch }, { params }) => {
  const conversationId = params.conversationId;

  let messages: Message[] = [];
  let pendingConfirmations: PendingConfirmation[] = [];

  if (conversationId) {
    const response = await fetch(ENDPOINTS.chat.conversation(conversationId));
    if (response.ok) {
      const data = (await response.json()) as {
        messages: Message[];
        pendingConfirmations: PendingConfirmation[];
      };
      messages = data.messages || [];
      pendingConfirmations = data.pendingConfirmations || [];
    }
  }

  return { conversationId, messages, pendingConfirmations };
});

// =============================================================================
// Component - renders messages, input, and process log
// =============================================================================

export default function ChatConversation({ loaderData }: Route.ComponentProps) {
  const { conversationId, messages: initialMessages, pendingConfirmations: initialPendingConfirmations } = loaderData;
  const params = useParams();
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
    clearError,
  } = useChat({
    initialMessages,
    initialPendingConfirmations,
  });

  // Refs
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSendMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || isStreaming) return;

      const convId = conversationId || params.conversationId;
      if (!convId) return;

      await sendMessage(convId, text);
      revalidator.revalidate();
    },
    [conversationId, params.conversationId, isStreaming, revalidator, sendMessage]
  );

  const isInputDisabled = isStreaming || pendingConfirmations.length > 0;

  return (
    <>
      <div className={styles.chatMain}>
        <ChatMessages
          messages={messages}
          isStreaming={isStreaming}
          pendingConfirmations={pendingConfirmations}
          onAccept={acceptConfirmation}
          onReject={rejectConfirmation}
          messagesEndRef={messagesEndRef}
        />

        {error && <div className={styles.chatError}>{error}</div>}

        <ChatInput
          onSend={handleSendMessage}
          disabled={isInputDisabled}
          placeholder={
            isInputDisabled ? "Waiting for response..." : "Type a message..."
          }
        />
      </div>

      <ProcessLog events={processEvents} />
    </>
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
    <div className={styles.chatMessages}>
      {messages.length === 0 && (
        <div className={styles.chatMessagesEmpty}>
          <p>Start a conversation with Docket</p>
        </div>
      )}

      {messages.map((msg) => (
        <div
          key={msg.id}
          className={`${styles.chatMessage} ${
            msg.role === "user"
              ? styles.chatMessageUser
              : styles.chatMessageAssistant
          } ${msg.status === "error" ? styles.chatMessageError : ""}`}
        >
          <div className={styles.chatMessageContent}>
            {msg.content}
            {msg.status === "streaming" && (
              <span className={styles.chatMessageTyping}>▊</span>
            )}
          </div>
        </div>
      ))}

      {pendingConfirmations.map((conf) => (
        <div key={conf.id} className={styles.chatConfirmation}>
          <div className={styles.chatConfirmationHeader}>
            Docket wants to {conf.action} a {conf.objectType}
          </div>
          <div className={styles.chatConfirmationParams}>
            {Object.entries(conf.params).map(([key, value]) => (
              <div key={key} className={styles.chatConfirmationParam}>
                <span className={styles.chatConfirmationParamKey}>{key}:</span>
                <span className={styles.chatConfirmationParamValue}>
                  {String(value)}
                </span>
              </div>
            ))}
          </div>
          <div className={styles.chatConfirmationActions}>
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
    <div className={styles.chatInputArea}>
      <textarea
        ref={textareaRef}
        className={styles.chatInput}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
      />
      <button
        className={`btn btn-primary ${styles.chatInputSubmit}`}
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
  return (
    <aside className={styles.processLog}>
      <div className={styles.processLogHeader}>Process Log</div>
      <div className={styles.processLogEvents}>
        {events.length === 0 && (
          <div className={styles.processLogEmpty}>No activity yet</div>
        )}
        {events.map((event) => (
          <ProcessLogEvent key={event.id} event={event} />
        ))}
      </div>
    </aside>
  );
}

function ProcessLogEvent({ event }: { event: ProcessEvent }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = hasExpandableContent(event);

  return (
    <div className={styles.processLogEvent}>
      <div
        className={`${styles.processLogEventHeader} ${hasDetails ? styles.processLogEventHeaderClickable : ""}`}
        onClick={() => hasDetails && setExpanded(!expanded)}
      >
        <span
          className={`${styles.processLogEventDot} ${
            event.status === "started" ? styles.processLogEventDotActive : ""
          }`}
        />
        <span className={styles.processLogEventLabel}>
          {getEventLabel(event)}
        </span>
        {event.durationMs !== undefined && (
          <span className={styles.processLogEventTiming}>
            {event.durationMs}ms
          </span>
        )}
        {hasDetails && (
          <span className={styles.processLogEventExpand}>
            {expanded ? "−" : "+"}
          </span>
        )}
      </div>

      {expanded && <EventDetails event={event} />}
    </div>
  );
}

function EventDetails({ event }: { event: ProcessEvent }) {
  if (event.type === "rag_lookup" && event.chunks && event.chunks.length > 0) {
    return (
      <div className={styles.processLogEventDetails}>
        {event.chunks.map((chunk, i) => (
          <div key={i} className={styles.chunkPreview}>
            <div className={styles.chunkSource}>{chunk.source}</div>
            <div className={styles.chunkText}>{chunk.preview || chunk.text}</div>
          </div>
        ))}
      </div>
    );
  }

  if (event.type === "clio_result" && event.preview?.items && event.preview.items.length > 0) {
    return (
      <div className={styles.processLogEventDetails}>
        {event.preview.items.map((item, i) => (
          <div key={i} className={styles.clioItem}>
            {item.name}
            {item.id && <span className={styles.clioItemId}>#{item.id}</span>}
          </div>
        ))}
        {event.count && event.count > 3 && (
          <div className={styles.clioMoreItems}>+{event.count - 3} more</div>
        )}
      </div>
    );
  }

  return null;
}

function getEventLabel(event: ProcessEvent): string {
  switch (event.type) {
    case "started":
      return "Processing";
    case "rag_lookup":
      if (event.status === "started") return "Searching knowledge base";
      const total = (event.kbCount || 0) + (event.orgCount || 0);
      return `Found ${total} relevant chunks`;
    case "llm_thinking":
      if (event.status === "started") return "Thinking";
      if (event.hasToolCalls) return `Planning ${event.toolCallCount} tool call${event.toolCallCount === 1 ? "" : "s"}`;
      return "Response ready";
    case "clio_call":
      return `Querying ${event.objectType}`;
    case "clio_result":
      if (event.success !== undefined) return event.success ? "Success" : "Failed";
      return `Found ${event.count || 0} results`;
    default:
      return event.type;
  }
}

function hasExpandableContent(event: ProcessEvent): boolean {
  return (
    (event.type === "rag_lookup" && !!event.chunks?.length) ||
    (event.type === "clio_result" && !!event.preview?.items?.length)
  );
}
