import { useState, useEffect, useCallback } from "react";
import { useNavigate, useParams } from "react-router";
import type { Route } from "./+types/chat.$conversationId";
import { ENDPOINTS } from "~/lib/api";
import { API_URL } from "~/lib/auth-client";
import { orgLoader } from "~/lib/loader-auth";
import { useChat } from "~/lib/use-chat";
import type { Conversation, ChatMessage, PendingConfirmation } from "~/lib/types";
import { ChatSidebar } from "~/components/ChatSidebar";
import { ChatMessages } from "~/components/ChatMessages";
import { ChatInput } from "~/components/ChatInput";
import { ProcessLog } from "~/components/ProcessLog";
import styles from "~/styles/chat.module.css";

export const loader = orgLoader(async ({ user, org, fetch }, { params }) => {
  const conversationId = params.conversationId;

  // Fetch conversations list
  const conversationsRes = await fetch(ENDPOINTS.chat.conversations);
  const conversations = conversationsRes.ok
    ? ((await conversationsRes.json()) as { conversations: Conversation[] })
        .conversations
    : [];

  // Fetch current conversation messages
  let messages: ChatMessage[] = [];
  let pendingConfirmations: PendingConfirmation[] = [];

  if (conversationId) {
    const conversationRes = await fetch(
      ENDPOINTS.chat.conversation(conversationId)
    );
    if (conversationRes.ok) {
      const data = (await conversationRes.json()) as {
        messages: ChatMessage[];
        pendingConfirmations: PendingConfirmation[];
      };
      messages = data.messages || [];
      pendingConfirmations = data.pendingConfirmations || [];
    }
  }

  return {
    user,
    org,
    conversations,
    conversationId,
    initialMessages: messages,
    initialPendingConfirmation: pendingConfirmations[0] || null,
  };
});

export default function ChatConversationPage({
  loaderData,
}: Route.ComponentProps) {
  const {
    org,
    conversations: initialConversations,
    conversationId,
    initialMessages,
    initialPendingConfirmation,
  } = loaderData;
  const navigate = useNavigate();

  const [conversations, setConversations] =
    useState<Conversation[]>(initialConversations);

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
    clearMessages,
  } = useChat({
    conversationId: conversationId || "",
    onConversationCreated: refreshConversations,
  });

  // Initialize messages from loader data
  useEffect(() => {
    // Messages are already initialized by the hook, but we need to handle
    // the initial state from the loader
  }, []);

  function handleNewChat() {
    const newId = crypto.randomUUID();
    clearMessages();
    navigate(`/chat/${newId}`);
  }

  async function handleDeleteConversation(id: string) {
    const confirmed = confirm("Delete this conversation?");
    if (!confirmed) return;

    try {
      const res = await fetch(
        `${API_URL}${ENDPOINTS.chat.conversation(id)}`,
        {
          method: "DELETE",
          credentials: "include",
        }
      );

      if (res.ok) {
        setConversations((prev) => prev.filter((c) => c.id !== id));

        // If we deleted the current conversation, start a new one
        if (id === conversationId) {
          handleNewChat();
        }
      }
    } catch {
      alert("Failed to delete conversation");
    }
  }

  // Use loader data for initial messages if hook hasn't loaded yet
  const displayMessages = messages.length > 0 ? messages : initialMessages;
  const displayPendingConfirmation =
    pendingConfirmation || initialPendingConfirmation;

  const inputDisabled = isLoading || !!displayPendingConfirmation;

  return (
    <div className={styles.chatLayout}>
      <ChatSidebar
        conversations={conversations}
        currentConversationId={conversationId || null}
        onNewChat={handleNewChat}
        onDeleteConversation={handleDeleteConversation}
      />

      <main className={styles.chatMain}>
        {error && <div className={styles.error}>{error}</div>}

        <ChatMessages
          messages={displayMessages}
          isLoading={isLoading}
          pendingConfirmation={displayPendingConfirmation}
          onAcceptConfirmation={acceptConfirmation}
          onRejectConfirmation={rejectConfirmation}
        />

        <ChatInput
          onSend={sendMessage}
          disabled={inputDisabled}
          placeholder={
            displayPendingConfirmation
              ? "Please respond to the confirmation above"
              : "Ask about your matters, tasks, or Clio data..."
          }
        />
      </main>

      <ProcessLog events={processEvents} />
    </div>
  );
}
