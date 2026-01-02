import { useState, useEffect, useRef, useCallback, useContext } from "react";
import { useParams, useRevalidator } from "react-router";
import type { Route } from "./+types/_app.chat.$conversationId";
import { ENDPOINTS } from "~/lib/api";
import { childLoader } from "~/lib/loader-auth";
import {
  useChat,
  type Message,
  type ProcessEvent,
  type PendingConfirmation,
} from "~/lib/use-chat";
import { PageLayoutContext } from "~/components/AppLayout";
import { ChatSidebarContext } from "~/lib/chat-context";
import styles from "~/styles/chat.module.css";
import {
  ArrowUp,
  Menu,
  MessageSquare,
  ChevronRight,
  ArrowRightFromLine,
} from "lucide-react";

// =============================================================================
// Loader - fetches the specific conversation's messages
// =============================================================================

export const loader = childLoader(async ({ fetch, params }) => {
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
  const {
    conversationId,
    messages: initialMessages,
    pendingConfirmations: initialPendingConfirmations,
  } = loaderData;
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
  } = useChat({
    initialMessages,
    initialPendingConfirmations,
  });

  // Refs
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Process log panel state (for mobile/tablet)
  const [processLogOpen, setProcessLogOpen] = useState(false);

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
    [
      conversationId,
      params.conversationId,
      isStreaming,
      revalidator,
      sendMessage,
    ]
  );

  const isInputDisabled = isStreaming || pendingConfirmations.length > 0;

  return (
    <>
      {/* Mobile overlay for process log */}
      {processLogOpen && (
        <div
          className={styles.processLogOverlay}
          onClick={() => setProcessLogOpen(false)}
          aria-hidden="true"
        />
      )}

      <div className={styles.chatMain}>
        <ChatMessages
          messages={messages}
          isStreaming={isStreaming}
          pendingConfirmations={pendingConfirmations}
          onAccept={acceptConfirmation}
          onReject={rejectConfirmation}
          messagesEndRef={messagesEndRef}
          onOpenProcessLog={() => setProcessLogOpen(true)}
        />

        {error && <div className={styles.chatError}>{error}</div>}

        <ChatInput
          onSend={handleSendMessage}
          disabled={isInputDisabled}
          placeholder={"Type a message..."}
        />
      </div>

      <ProcessLog
        events={processEvents}
        isOpen={processLogOpen}
        onClose={() => setProcessLogOpen(false)}
      />
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
  onOpenProcessLog: () => void;
}

function ChatMessages({
  messages,
  pendingConfirmations,
  onAccept,
  onReject,
  messagesEndRef,
  onOpenProcessLog,
}: ChatMessagesProps) {
  const layoutContext = useContext(PageLayoutContext);
  const sidebarContext = useContext(ChatSidebarContext);

  function handleMenuClick() {
    if (layoutContext) {
      layoutContext.onMenuOpen();
    }
  }

  function handleConversationsClick() {
    if (sidebarContext) {
      sidebarContext.onSidebarOpen();
    }
  }

  return (
    <div className={styles.chatMessages}>
      <div className={styles.mobileChatHeader}>
        <button
          type="button"
          className={styles.menuButton}
          onClick={handleConversationsClick}
          aria-label="Open conversations"
        >
          <MessageSquare
            size={22}
            strokeWidth={1.67}
            color={"var(--text-primary)"}
          />
        </button>
        <button
          type="button"
          className={styles.menuButton}
          onClick={handleMenuClick}
          aria-label="Open menu"
        >
          <Menu size={22} strokeWidth={1.67} color={"var(--text-primary)"} />
        </button>
      </div>
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

      {/* Process log button - only visible on tablet/mobile */}
      {messages.length > 0 && (
        <button
          type="button"
          className={styles.viewProcessLogButton}
          onClick={onOpenProcessLog}
        >
          View Process Log
          <ChevronRight size={14} />
        </button>
      )}

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
    <div className={styles.chatInputAreaWrapper}>
      <div className={styles.chatInputArea}>
        <div className={styles.chatInputWrapper}>
          <textarea
            ref={textareaRef}
            className={`text-body ${styles.chatInput}`}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={disabled}
            rows={1}
          />
          <div className={styles.textAreaWrapperBottomRow}>
            <span
              className="text-subhead text-tertiary"
              style={{ marginTop: "3px" }}
            >
              Docketbot 1.0
            </span>

            <button
              className={`${styles.chatInputSubmit}`}
              onClick={handleSubmit}
              disabled={disabled || !value.trim()}
            >
              <ArrowUp strokeWidth={2.25} color="white" size={16} />
            </button>
          </div>
        </div>
      </div>
      <p className={`text-footnote text-tertiary ${styles.chatNote}`}>
        Docketbot is AI and can make mistakes. Check important information.
      </p>
    </div>
  );
}

// =============================================================================
// ProcessLog Component
// =============================================================================

interface ProcessLogProps {
  events: ProcessEvent[];
  isOpen: boolean;
  onClose: () => void;
}

// Event types to display in the process log
const VISIBLE_EVENT_TYPES = [
  "kb_search",
  "org_context_search",
  "clio_schema",
  "llm_thinking",
  "clio_call",
  "clio_result",
  "thinking",
  "validation",
  "auto_correct",
];

function ProcessLog({ events, isOpen, onClose }: ProcessLogProps) {
  // Filter to only visible event types and consolidate (complete replaces started)
  const consolidatedEvents = events
    .filter((e) => VISIBLE_EVENT_TYPES.includes(e.type))
    .reduce<ProcessEvent[]>((acc, event) => {
      const existingIndex = acc.findIndex((e) => e.type === event.type);
      if (existingIndex === -1) {
        acc.push(event);
      } else {
        acc[existingIndex] = event;
      }
      return acc;
    }, []);

  return (
    <aside
      className={`${styles.processLog} ${isOpen ? styles.processLogOpen : ""}`}
    >
      <div
        className={`${styles.processLogMobileHeader} ${styles.chatSideBarMobileHeader}`}
        style={{ padding: "12px 8px 0px 20px" }}
      >
        <span className="text-title-3">Process Log</span>
        <button
          type="button"
          className={`${styles.processLogCloseButton} ${styles.chatSidebarCloseButton}`}
          onClick={onClose}
          aria-label="Close conversations"
        >
          <ArrowRightFromLine
            size={22}
            strokeWidth={1.67}
            color="var(--text-secondary)"
          />
        </button>
      </div>
      <div className={styles.processLogHeaderRow}>
        <div className={styles.processLogHeader}>Process Log</div>
      </div>
      <div className={styles.processLogEvents}>
        {consolidatedEvents.length === 0 && (
          <div className={styles.processLogEmpty}>No activity yet</div>
        )}
        {consolidatedEvents.map((event) => (
          <ProcessLogEvent key={event.id} event={event} />
        ))}
      </div>
    </aside>
  );
}

// Extract friendly name from source path
function getFriendlyName(source: string): string {
  const parts = source.split("/");
  const filename = parts[parts.length - 1] || source;
  return filename
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function ProcessLogEvent({ event }: { event: ProcessEvent }) {
  // Show sources inline for search events
  const showInlineSources =
    (event.type === "kb_search" || event.type === "org_context_search") &&
    event.status === "complete" &&
    event.chunks &&
    event.chunks.length > 0;

  // Show Clio results inline
  const showClioResults =
    event.type === "clio_result" && event.preview?.items?.length;

  return (
    <div className={styles.processLogEvent}>
      <div className={styles.processLogEventHeader}>
        <span
          className={`${styles.processLogEventDot} ${
            event.status === "started" ? styles.processLogEventDotActive : ""
          }`}
        />
        <span className={`text-subhead ${styles.processLogEventLabel}`}>
          {getEventLabel(event)}
        </span>
        {event.durationMs !== undefined && (
          <span className={styles.processLogEventTiming}>
            {(event.durationMs / 1000).toFixed(1)}s
          </span>
        )}
      </div>

      {showInlineSources && (
        <div className={styles.inlineSources}>
          {event.chunks!.map((chunk, i) => (
            <div key={i} className={styles.sourceCard}>
              <div className={`text-footnote ${styles.sourceTitle}`}>
                {getFriendlyName(chunk.source)}
              </div>
              <div className={`text-footnote ${styles.sourceExcerpt}`}>
                "{chunk.preview}"
              </div>
            </div>
          ))}
        </div>
      )}

      {showClioResults && (
        <div className={styles.inlineSources}>
          {event.preview!.items.map((item, i) => (
            <div key={i} className={styles.sourceCard}>
              <div className={`text-footnote ${styles.sourceTitle}`}>
                {item.name}
              </div>
              {item.id && (
                <div className={`text-footnote ${styles.sourceExcerpt}`}>
                  #{item.id}
                </div>
              )}
            </div>
          ))}
          {event.count && event.count > 3 && (
            <div className={`text-footnote ${styles.sourceExcerpt}`}>
              +{event.count - 3} more
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function getEventLabel(event: ProcessEvent): string {
  switch (event.type) {
    case "started":
      return "Processing";

    case "kb_search":
      if (event.status === "started") return "Searching Knowledge Base...";
      const kbCount = event.matchCount || 0;
      return `Knowledge Base: ${kbCount} article${kbCount !== 1 ? "s" : ""}`;

    case "org_context_search":
      if (event.status === "started") return "Searching Firm Documents...";
      const orgCount = event.matchCount || 0;
      return `Firm Documents: ${orgCount} document${orgCount !== 1 ? "s" : ""}`;

    case "clio_schema":
      const fieldCount = event.customFieldCount || 0;
      return `Clio: ${fieldCount} custom field${fieldCount !== 1 ? "s" : ""}`;

    case "llm_thinking":
      if (event.status === "started") return "AI generating response...";
      if (event.hasToolCalls)
        return `AI preparing ${event.toolCallCount} Clio ${event.toolCallCount === 1 ? "query" : "queries"}`;
      return "AI response complete";

    case "clio_call":
      return event.text || `Clio: ${event.objectType}`;

    case "clio_result":
      if (event.text) return event.text;
      if (event.success !== undefined)
        return event.success ? "Clio updated" : "Clio update failed";
      const count = event.count || 0;
      return `Found ${count} record${count !== 1 ? "s" : ""}`;

    case "thinking":
      return event.text || "Processing...";

    case "validation":
      return event.text || "Checking parameters...";

    case "auto_correct":
      return event.text || "Adjusting query...";

    default:
      return event.text || event.type;
  }
}
