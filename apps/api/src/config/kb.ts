/**
 * Knowledge Base Configuration
 *
 * Central config for chunking, embedding, and retrieval settings.
 * Adjust these values to tune RAG quality vs. performance.
 */

export const KB_CONFIG = {
  // Text chunking
  CHUNK_SIZE: 500, // Characters per chunk (~125 tokens)

  // Cloudflare API batch limits
  VECTORIZE_BATCH_SIZE: 100, // Max vectors per upsert/delete call
  EMBEDDING_BATCH_SIZE: 100, // Max texts per embedding call

  // Context window management (reduced since LLM can actively search)
  TOKEN_BUDGET: 1000, // Max tokens for passive auto-injection
  CHARS_PER_TOKEN: 4, // Rough estimate for budget calculations

  // Retrieval settings
  KB_TOP_K: 5, // Number of KB chunks to retrieve per filter
  ORG_TOP_K: 5, // Number of org context chunks to retrieve

  // Upload limits
  MAX_FILE_SIZE: 25 * 1024 * 1024, // 25MB max upload
} as const;
