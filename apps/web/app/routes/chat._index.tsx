import { useNavigate } from "react-router";
import styles from "~/styles/chat.module.css";
import { MessageCirclePlus } from "lucide-react";

// =============================================================================
// Index Route - shows when no conversation is selected (/chat)
// =============================================================================

export default function ChatIndex() {
  const navigate = useNavigate();

  const handleStartChat = () => {
    const newId = crypto.randomUUID();
    navigate(`/chat/${newId}`);
  };

  return (
    <>
      <div className={styles.chatMain}>
        <div className={styles.chatMessages}>
          <div className={styles.chatMessagesEmpty}>
            <MessageCirclePlus size={48} strokeWidth={1} />
            <h2>Welcome to Docket</h2>
            <p>Select a conversation or start a new one</p>
            <button className="btn btn-primary" onClick={handleStartChat}>
              Start New Chat
            </button>
          </div>
        </div>
      </div>

      <aside className={styles.processLog}>
        <div className={styles.processLogHeader}>Process Log</div>
        <div className={styles.processLogEvents}>
          <div className={styles.processLogEmpty}>No activity yet</div>
        </div>
      </aside>
    </>
  );
}
