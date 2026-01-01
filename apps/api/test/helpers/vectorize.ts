/**
 * Shared Vectorize helpers for integration tests.
 * Consolidates embedding and vector operations from test files.
 */

type TestEnv = {
  AI: {
    run: (
      model: string,
      input: { text: string[] }
    ) => Promise<{ data: number[][] }>;
  };
  VECTORIZE: VectorizeIndex;
};

/**
 * Generates an embedding for a single text string.
 */
export async function generateEmbedding(
  env: TestEnv,
  text: string
): Promise<number[]> {
  const result = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
    text: [text],
  });
  return result.data[0];
}

/**
 * Generates embeddings for multiple text strings.
 */
export async function generateEmbeddings(
  env: TestEnv,
  texts: string[]
): Promise<number[][]> {
  const result = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
    text: texts,
  });
  return result.data;
}

/**
 * Upserts a single vector to Vectorize.
 */
export async function upsertVector(
  env: TestEnv,
  options: {
    id: string;
    content: string;
    metadata?: Record<string, string>;
  }
): Promise<void> {
  const embedding = await generateEmbedding(env, options.content);
  await env.VECTORIZE.upsert([
    {
      id: options.id,
      values: embedding,
      metadata: options.metadata ?? {},
    },
  ]);
}

/**
 * Upserts multiple vectors to Vectorize.
 */
export async function upsertVectors(
  env: TestEnv,
  chunks: Array<{
    id: string;
    content: string;
    metadata?: Record<string, string>;
  }>
): Promise<void> {
  const texts = chunks.map((c) => c.content);
  const embeddings = await generateEmbeddings(env, texts);

  const vectors = chunks.map((chunk, i) => ({
    id: chunk.id,
    values: embeddings[i],
    metadata: chunk.metadata ?? {},
  }));

  await env.VECTORIZE.upsert(vectors);
}

/**
 * Cleans up vectors from Vectorize by their IDs.
 */
export async function cleanupVectors(
  env: TestEnv,
  ids: string[]
): Promise<void> {
  if (ids.length > 0) {
    await env.VECTORIZE.deleteByIds(ids);
  }
}

/**
 * Helper class to track and clean up test vectors.
 * Use in tests with afterAll cleanup.
 *
 * @example
 * const tracker = new VectorTracker();
 * afterAll(() => tracker.cleanup(env));
 *
 * // In test:
 * tracker.track("vector-id");
 * await env.VECTORIZE.upsert([...]);
 */
export class VectorTracker {
  private ids: string[] = [];

  track(id: string): void {
    this.ids.push(id);
  }

  trackAll(ids: string[]): void {
    this.ids.push(...ids);
  }

  async cleanup(env: TestEnv): Promise<void> {
    await cleanupVectors(env, this.ids);
    this.ids = [];
  }
}
