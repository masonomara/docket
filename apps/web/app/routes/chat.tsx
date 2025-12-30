import { useState, useEffect, useCallback } from "react";
import { useNavigate, useRevalidator } from "react-router";
import type { Route } from "./+types/chat";
import { ENDPOINTS } from "~/lib/api";
import { API_URL } from "~/lib/auth-client";
import { orgLoader } from "~/lib/loader-auth";
import { useChat } from "~/lib/use-chat";
import type { Conversation } from "~/lib/types";
import { ChatSidebar } from "~/components/ChatSidebar";
import { ChatMessages } from "~/components/ChatMessages";
import { ChatInput } from "~/components/ChatInput";
import { ProcessLog } from "~/components/ProcessLog";
import styles from "~/styles/chat.module.css";
import { AppLayout } from "~/components/AppLayout";

export const loader = orgLoader(async ({ user, org, fetch }, {}) => {
  const res = await fetch(ENDPOINTS.chat.conversations);

  const conversations = res.ok
    ? ((await res.json()) as { conversations: Conversation[] }).conversations
    : [];

  return { user, org, conversations };
});

export default function ChatPage({ loaderData }: Route.ComponentProps) {
  const { org, conversations: initialConversations } = loaderData;
  const navigate = useNavigate();
  const revalidator = useRevalidator();

  const [conversations, setConversations] =
    useState<Conversation[]>(initialConversations);
  const [currentConversationId, setCurrentConversationId] = useState<
    string | null
  >(null);

  // Generate a new conversation ID for new chats
  const generateNewConversation = useCallback(() => {
    const newId = crypto.randomUUID();
    setCurrentConversationId(newId);
    return newId;
  }, []);

  // Initialize with a new conversation if none exists
  useEffect(() => {
    if (!currentConversationId) {
      generateNewConversation();
    }
  }, [currentConversationId, generateNewConversation]);

  const refreshConversations = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}${ENDPOINTS.chat.conversations}`, {
        credentials: "include",
      });
      if (res.ok) {
        const data = (await res.json()) as { conversations: Conversation[] };
        setConversations(data.conversations);
      }
    } catch {
      // Silently fail - not critical
    }
  }, []);

  const {
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
  } = useChat({
    conversationId: currentConversationId || "",
    onConversationCreated: refreshConversations,
  });

  function handleNewChat() {
    const newId = generateNewConversation();
    clearMessages();
    navigate(`/chat/${newId}`);
  }

  function handleSelectConversation(conversationId: string) {
    setCurrentConversationId(conversationId);
    loadConversation(conversationId);
    navigate(`/chat/${conversationId}`);
  }

  async function handleDeleteConversation(conversationId: string) {
    const confirmed = confirm("Delete this conversation?");
    if (!confirmed) return;

    try {
      const res = await fetch(
        `${API_URL}${ENDPOINTS.chat.conversation(conversationId)}`,
        {
          method: "DELETE",
          credentials: "include",
        }
      );

      if (res.ok) {
        setConversations((prev) => prev.filter((c) => c.id !== conversationId));

        // If we deleted the current conversation, start a new one
        if (conversationId === currentConversationId) {
          handleNewChat();
        }
      }
    } catch {
      alert("Failed to delete conversation");
    }
  }

  const inputDisabled = isLoading || !!pendingConfirmation;

  return (
    <AppLayout org={org} currentPath="/chat">
      <div className={styles.chatLayout}>
        <ChatSidebar
          conversations={conversations}
          currentConversationId={currentConversationId}
          onNewChat={handleNewChat}
          onDeleteConversation={handleDeleteConversation}
        />

        <main className={styles.chatMain}>
          {error && <div className={styles.error}>{error}</div>}

          <ChatMessages
            messages={messages}
            isLoading={isLoading}
            pendingConfirmation={pendingConfirmation}
            onAcceptConfirmation={acceptConfirmation}
            onRejectConfirmation={rejectConfirmation}
          />

          <ChatInput
            onSend={sendMessage}
            disabled={inputDisabled}
            placeholder={
              pendingConfirmation
                ? "Please respond to the confirmation above"
                : "Ask about your matters, tasks, or Clio data..."
            }
          />
        </main>

        <ProcessLog events={processEvents} />
      </div>
    </AppLayout>
  );
}
