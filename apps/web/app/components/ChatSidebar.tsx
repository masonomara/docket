import { Link } from "react-router";
import { Plus, Trash2 } from "lucide-react";
import type { Conversation } from "~/lib/types";
import styles from "~/styles/chat.module.css";

interface ChatSidebarProps {
  conversations: Conversation[];
  currentConversationId: string | null;
  onNewChat: () => void;
  onDeleteConversation: (id: string) => void;
}

export function ChatSidebar({
  conversations,
  currentConversationId,
  onNewChat,
  onDeleteConversation,
}: ChatSidebarProps) {
  function formatDate(timestamp: number): string {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      return date.toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      });
    } else if (diffDays === 1) {
      return "Yesterday";
    } else if (diffDays < 7) {
      return date.toLocaleDateString([], { weekday: "short" });
    } else {
      return date.toLocaleDateString([], { month: "short", day: "numeric" });
    }
  }

  function handleDelete(e: React.MouseEvent, conversationId: string) {
    e.preventDefault();
    e.stopPropagation();
    onDeleteConversation(conversationId);
  }

  return (
    <aside className={styles.sidebar}>
      <div className={styles.sidebarHeader}>
        <h2 className="text-headline">Conversations</h2>
        <button
          type="button"
          onClick={onNewChat}
          className={`btn btn-sm ${styles.newChatButton}`}
          aria-label="New chat"
        >
          <Plus size={16} />
          <span>New</span>
        </button>
      </div>

      <nav className={styles.conversationList}>
        {conversations.length === 0 ? (
          <p className={styles.emptyState}>No conversations yet</p>
        ) : (
          conversations.map((conversation) => (
            <Link
              key={conversation.id}
              to={`/chat/${conversation.id}`}
              className={`${styles.conversationItem} ${
                conversation.id === currentConversationId
                  ? styles.conversationItemActive
                  : ""
              }`}
            >
              <div className={styles.conversationContent}>
                <span className={styles.conversationTitle}>
                  {conversation.title || "New conversation"}
                </span>
                <span className={styles.conversationMeta}>
                  {formatDate(conversation.updatedAt)}
                </span>
              </div>
              <button
                type="button"
                onClick={(e) => handleDelete(e, conversation.id)}
                className={styles.deleteButton}
                aria-label="Delete conversation"
              >
                <Trash2 size={14} />
              </button>
            </Link>
          ))
        )}
      </nav>
    </aside>
  );
}
