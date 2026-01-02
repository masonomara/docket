import { redirect } from "react-router";

// =============================================================================
// Index Route - redirects to a new conversation (/chat → /chat/:newId)
// =============================================================================

export function loader() {
  const newConversationId = crypto.randomUUID();
  throw redirect(`/chat/${newConversationId}`);
}

export default function ChatIndex() {
  // This won't render - loader always redirects
  return null;
}
