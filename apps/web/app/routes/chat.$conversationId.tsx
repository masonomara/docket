/**
 * Chat route with conversation ID
 * Loads a specific conversation on mount
 */
import type { Route } from "./+types/chat.$conversationId";
import { ENDPOINTS } from "~/lib/api";
import { orgLoader } from "~/lib/loader-auth";
import Chat, {
  type Conversation,
  type Message,
  type PendingConfirmation,
} from "./chat";

// =============================================================================
// Loader - fetches conversations AND the specific conversation
// =============================================================================

export const loader = orgLoader(async ({ user, org, fetch }, { params }) => {
  const conversationId = params.conversationId;

  // Fetch conversations list
  const listResponse = await fetch(ENDPOINTS.chat.conversations);
  let conversations: Conversation[] = [];
  if (listResponse.ok) {
    const data = (await listResponse.json()) as { conversations: Conversation[] };
    conversations = data.conversations;
  }

  // Fetch the specific conversation
  let initialMessages: Message[] = [];
  let initialPendingConfirmations: PendingConfirmation[] = [];

  if (conversationId) {
    const convResponse = await fetch(ENDPOINTS.chat.conversation(conversationId));
    if (convResponse.ok) {
      const data = (await convResponse.json()) as {
        messages: Message[];
        pendingConfirmations: PendingConfirmation[];
      };
      initialMessages = data.messages || [];
      initialPendingConfirmations = data.pendingConfirmations || [];
    }
  }

  return {
    user,
    org,
    conversations,
    conversationId,
    initialMessages,
    initialPendingConfirmations,
  };
});

// =============================================================================
// Component - reuse the Chat component from chat.tsx
// =============================================================================

export default function ChatWithConversation({
  loaderData,
}: Route.ComponentProps) {
  // Pass through to Chat component - it handles initial data from loader
  return <Chat loaderData={loaderData} />;
}
