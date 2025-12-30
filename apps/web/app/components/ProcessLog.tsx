import { Database, Brain, Plug, CheckCircle, AlertCircle } from "lucide-react";
import type { ProcessEvent } from "~/lib/types";
import styles from "~/styles/chat.module.css";

interface ProcessLogProps {
  events: ProcessEvent[];
}

export function ProcessLog({ events }: ProcessLogProps) {
  function getEventIcon(type: string) {
    switch (type) {
      case "rag_lookup":
        return <Database size={14} />;
      case "llm_thinking":
        return <Brain size={14} />;
      case "clio_call":
      case "clio_result":
        return <Plug size={14} />;
      case "confirmation_required":
        return <AlertCircle size={14} />;
      default:
        return <CheckCircle size={14} />;
    }
  }

  function getEventLabel(type: string): string {
    switch (type) {
      case "rag_lookup":
        return "Knowledge lookup";
      case "llm_thinking":
        return "Processing";
      case "clio_call":
        return "Clio API call";
      case "clio_result":
        return "Clio response";
      case "confirmation_required":
        return "Confirmation needed";
      default:
        return type;
    }
  }

  function getStatusClass(status: string): string {
    switch (status) {
      case "completed":
        return styles.eventCompleted;
      case "error":
        return styles.eventError;
      default:
        return styles.eventStarted;
    }
  }

  return (
    <aside className={styles.processLog}>
      <h3 className="text-headline">Process Log</h3>

      {events.length === 0 ? (
        <p className={styles.emptyLog}>
          Processing steps will appear here as your message is handled.
        </p>
      ) : (
        <ul className={styles.eventList}>
          {events.map((event, index) => (
            <li
              key={`${event.type}-${event.timestamp}-${index}`}
              className={`${styles.eventItem} ${getStatusClass(event.status)}`}
            >
              <span className={styles.eventIcon}>
                {getEventIcon(event.type)}
              </span>
              <span className={styles.eventLabel}>
                {getEventLabel(event.type)}
              </span>
              <span className={styles.eventStatus}>
                {event.status === "started" && "..."}
                {event.status === "completed" && (
                  <CheckCircle size={12} className={styles.checkIcon} />
                )}
                {event.status === "error" && (
                  <AlertCircle size={12} className={styles.errorIcon} />
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
