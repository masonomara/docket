// Time constants in milliseconds
const MINUTES = 60 * 1000;
const HOURS = 60 * MINUTES;
const DAYS = 24 * HOURS;

export const TENANT_CONFIG = {
  // Number of recent messages to include in conversation context
  RECENT_MESSAGES_LIMIT: 15,

  // How long a pending confirmation (e.g., "delete this contact?") stays valid
  CONFIRMATION_TTL_MS: 24 * HOURS,

  // How often the Durable Object alarm runs for cleanup tasks
  ALARM_INTERVAL_MS: 1 * DAYS,

  // Conversations older than this are considered stale and may be cleaned up
  STALE_CONVERSATION_MS: 30 * DAYS,

  // Max characters to show in RAG chunk previews (ProcessLog)
  CHUNK_PREVIEW_LENGTH: 100,

  // Max conversations returned in list endpoint
  CONVERSATIONS_LIMIT: 50,

  // LLM token limits
  LLM: {
    CHAT_MAX_TOKENS: 2000,
    CLASSIFICATION_MAX_TOKENS: 100,
  },
} as const;
