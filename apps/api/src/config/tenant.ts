// Time constants in milliseconds
const MINUTES = 60 * 1000;
const HOURS = 60 * MINUTES;
const DAYS = 24 * HOURS;

export const TENANT_CONFIG = {
  // Number of recent messages to include in conversation context
  RECENT_MESSAGES_LIMIT: 15,

  // How long a pending confirmation (e.g., "delete this contact?") stays valid
  CONFIRMATION_TTL_MS: 5 * MINUTES,

  // How often the Durable Object alarm runs for cleanup tasks
  ALARM_INTERVAL_MS: 1 * DAYS,

  // Conversations older than this are considered stale and may be cleaned up
  STALE_CONVERSATION_MS: 30 * DAYS,
} as const;
