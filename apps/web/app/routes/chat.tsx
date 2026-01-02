import { useState, useEffect, useCallback, useMemo } from "react";
import { Outlet, useNavigate, useRevalidator, useParams } from "react-router";
import type { Route } from "./+types/chat";
import { ENDPOINTS } from "~/lib/api";
import { API_URL } from "~/lib/auth-client";
import { orgLoader } from "~/lib/loader-auth";
import styles from "~/styles/chat.module.css";
import { AppLayout } from "~/components/AppLayout";
import { ChatSidebarContext } from "~/lib/chat-context";
import { ArrowLeftFromLine, SquarePen, X } from "lucide-react";

// =============================================================================
// Types (exported for use by child routes)
// =============================================================================

export interface Conversation {
  id: string;
  title: string | null;
  updatedAt: number;
  messageCount: number;
}

// =============================================================================
// Loader - fetches conversations list (shared by all child routes)
// =============================================================================

export const loader = orgLoader(async ({ user, org, fetch }) => {
  const response = await fetch(ENDPOINTS.chat.conversations);

  let conversations: Conversation[] = [];
  if (response.ok) {
    const data = (await response.json()) as { conversations: Conversation[] };
    conversations = data.conversations;
  }

  return { user, org, conversations };
});

// =============================================================================
// Layout Component - renders sidebar + Outlet for child routes
// =============================================================================

export default function ChatLayout({ loaderData }: Route.ComponentProps) {
  const { conversations: initialConversations, org } = loaderData;

  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const params = useParams();

  // Conversations state (can be updated by children via revalidation)
  const [conversations, setConversations] =
    useState<Conversation[]>(initialConversations);

  // Mobile sidebar state
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const openSidebar = useCallback(() => setSidebarOpen(true), []);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  // Memoize context value to prevent unnecessary re-renders
  const sidebarContextValue = useMemo(
    () => ({ onSidebarOpen: openSidebar }),
    [openSidebar]
  );

  // Sync when loader data changes
  useEffect(() => {
    setConversations(initialConversations);
  }, [initialConversations]);

  // Get current conversation ID from route params
  const currentConversationId = params.conversationId || null;

  const handleNewChat = useCallback(() => {
    const newId = crypto.randomUUID();
    navigate(`/chat/${newId}`);
  }, [navigate]);

  const handleSelectConversation = useCallback(
    (conversationId: string) => {
      navigate(`/chat/${conversationId}`);
    },
    [navigate]
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

        // If we deleted the current conversation, go to chat index
        if (currentConversationId === conversationId) {
          navigate("/chat");
        }

        revalidator.revalidate();
      } catch {
        // Error handling could be improved
      }
    },
    [currentConversationId, navigate, revalidator]
  );

  return (
    <AppLayout org={org} currentPath="/chat">
      <div className={styles.chatLayout}>
        {/* Mobile overlay - click to close sidebar */}
        {sidebarOpen && (
          <div
            className={styles.chatSidebarOverlay}
            onClick={closeSidebar}
            aria-hidden="true"
          />
        )}

        <ChatSidebar
          conversations={conversations}
          currentId={currentConversationId}
          onSelect={(id) => {
            handleSelectConversation(id);
            closeSidebar();
          }}
          onNew={() => {
            handleNewChat();
            closeSidebar();
          }}
          onDelete={handleDeleteConversation}
          isOpen={sidebarOpen}
          onClose={closeSidebar}
        />

        <ChatSidebarContext.Provider value={sidebarContextValue}>
          <Outlet />
        </ChatSidebarContext.Provider>
      </div>
    </AppLayout>
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
  isOpen: boolean;
  onClose: () => void;
}

function ChatSidebar({
  conversations,
  currentId,
  onSelect,
  onNew,
  onDelete,
  isOpen,
  onClose,
}: ChatSidebarProps) {
  return (
    <aside
      className={`${styles.chatSidebar} ${isOpen ? styles.chatSidebarOpen : ""}`}
    >
      <div className={styles.chatSideBarMobileHeader}>
        <span className="text-title-3">Conversations List</span>
        <button
          type="button"
          className={styles.chatSidebarCloseButton}
          onClick={onClose}
          aria-label="Close conversations"
        >
          <ArrowLeftFromLine
            size={22}
            strokeWidth={1.67}
            color="var(--text-secondary)"
          />
        </button>
      </div>
      <div className={styles.chatSidebarHeader}>
        <button className={styles.newChatButton} onClick={onNew}>
          <SquarePen
            size={16}
            strokeWidth={1.75}
            className={styles.newChatButtonIcon}
          />
          New Conversation
        </button>
      </div>
      <div className={styles.sectionLabel}>
        {conversations.length === 0
          ? "No conversations yet"
          : "Your Conversations"}
      </div>
      <div className={styles.chatSidebarList}>
        {conversations.map((conv) => (
          <div
            key={conv.id}
            className={`${styles.chatSidebarItem} ${
              currentId === conv.id ? styles.chatSidebarItemActive : ""
            }`}
            onClick={() => onSelect(conv.id)}
          >
            <div className={styles.chatSidebarItemContent}>
              <span className={styles.chatSidebarItemTitle}>
                {conv.title || "New conversation"}
              </span>
            </div>
            <button
              className={styles.chatSidebarItemDelete}
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
      </div>
    </aside>
  );
}
