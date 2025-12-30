import { useEffect, useRef } from "react";
import type { ChatMessage, PendingConfirmation } from "~/lib/types";
import styles from "~/styles/chat.module.css";

interface ChatMessagesProps {
  messages: ChatMessage[];
  isLoading: boolean;
  pendingConfirmation: PendingConfirmation | null;
  onAcceptConfirmation: () => void;
  onRejectConfirmation: () => void;
}

export function ChatMessages({
  messages,
  isLoading,
  pendingConfirmation,
  onAcceptConfirmation,
  onRejectConfirmation,
}: ChatMessagesProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, pendingConfirmation]);

  function formatConfirmationParams(params: Record<string, unknown>): string {
    return Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => {
        const label = key
          .replace(/_/g, " ")
          .replace(/([A-Z])/g, " $1")
          .trim();
        const capitalizedLabel =
          label.charAt(0).toUpperCase() + label.slice(1);
        return `${capitalizedLabel}: ${value}`;
      })
      .join("\n");
  }

  return (
    <div ref={containerRef} className={styles.messagesContainer}>
      {messages.length === 0 && !isLoading && (
        <div className={styles.welcomeMessage}>
          <h2 className="text-title-2">How can I help you today?</h2>
          <p className="text-body text-secondary">
            Ask about your matters, contacts, tasks, or have me help with Clio
            operations.
          </p>
        </div>
      )}

      {messages.map((message) => (
        <MessageBubble key={message.id} message={message} />
      ))}

      {pendingConfirmation && (
        <ConfirmationCard
          confirmation={pendingConfirmation}
          onAccept={onAcceptConfirmation}
          onReject={onRejectConfirmation}
          isLoading={isLoading}
          formatParams={formatConfirmationParams}
        />
      )}

      {isLoading && !pendingConfirmation && messages.length > 0 && (
        <TypingIndicator />
      )}

      <div ref={messagesEndRef} />
    </div>
  );
}

// ============================================================================
// Helper Components
// ============================================================================

interface MessageBubbleProps {
  message: ChatMessage;
}

function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";
  const isError = message.status === "error";
  const isStreaming = message.status === "streaming";

  return (
    <div
      className={`${styles.messageBubble} ${
        isUser ? styles.userMessage : styles.assistantMessage
      } ${isError ? styles.errorMessage : ""}`}
    >
      <div className={styles.messageContent}>
        {message.content || (isStreaming && <span className={styles.cursor} />)}
        {isStreaming && message.content && (
          <span className={styles.cursor} />
        )}
      </div>
    </div>
  );
}

interface ConfirmationCardProps {
  confirmation: PendingConfirmation;
  onAccept: () => void;
  onReject: () => void;
  isLoading: boolean;
  formatParams: (params: Record<string, unknown>) => string;
}

function ConfirmationCard({
  confirmation,
  onAccept,
  onReject,
  isLoading,
  formatParams,
}: ConfirmationCardProps) {
  const actionLabel = {
    create: "Create",
    update: "Update",
    delete: "Delete",
  }[confirmation.action];

  return (
    <div className={styles.confirmationCard}>
      <div className={styles.confirmationHeader}>
        <span className="text-headline">
          {actionLabel} {confirmation.objectType}?
        </span>
      </div>
      <div className={styles.confirmationBody}>
        <pre className={styles.confirmationParams}>
          {formatParams(confirmation.params)}
        </pre>
      </div>
      <div className={styles.confirmationActions}>
        <button
          type="button"
          onClick={onReject}
          disabled={isLoading}
          className="btn btn-secondary btn-sm"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onAccept}
          disabled={isLoading}
          className="btn btn-primary btn-sm"
        >
          {isLoading ? "Processing..." : "Confirm"}
        </button>
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className={`${styles.messageBubble} ${styles.assistantMessage}`}>
      <div className={styles.typingIndicator}>
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}
