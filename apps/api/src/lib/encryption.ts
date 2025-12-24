export interface EncryptionEnv {
  ENCRYPTION_KEY: string;
  ENCRYPTION_KEY_OLD?: string;
}

const PBKDF2_ITERATIONS = 600000;
const IV_LENGTH = 12;
const KEY_LENGTH = 256;

/**
 * Derives an AES-GCM key from a secret and salt using PBKDF2
 */
async function deriveKey(secret: string, salt: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode(salt),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: KEY_LENGTH },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Encrypts data using AES-GCM with a user-specific derived key.
 * The IV is prepended to the ciphertext.
 */
export async function encrypt(
  plaintext: string,
  userId: string,
  encryptionKey: string
): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await deriveKey(encryptionKey, userId);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext)
  );

  // Combine IV + ciphertext into a single buffer
  const result = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), IV_LENGTH);

  return result.buffer;
}

/**
 * Decrypts data using a specific key
 */
async function decryptWithKey(
  encrypted: ArrayBuffer,
  userId: string,
  key: string
): Promise<string> {
  const data = new Uint8Array(encrypted);
  const iv = data.slice(0, IV_LENGTH);
  const ciphertext = data.slice(IV_LENGTH);

  const derivedKey = await deriveKey(key, userId);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    derivedKey,
    ciphertext
  );

  return new TextDecoder().decode(decrypted);
}

/**
 * Decrypts data, trying the current key first, then falling back to the old key.
 * This supports key rotation without breaking existing encrypted data.
 */
export async function decrypt(
  encrypted: ArrayBuffer,
  userId: string,
  env: EncryptionEnv
): Promise<string> {
  // Try current key first
  try {
    return await decryptWithKey(encrypted, userId, env.ENCRYPTION_KEY);
  } catch {
    // Fall back to old key if available
    if (env.ENCRYPTION_KEY_OLD) {
      return decryptWithKey(encrypted, userId, env.ENCRYPTION_KEY_OLD);
    }
    throw new Error("Decryption failed");
  }
}

/**
 * Decrypts data and re-encrypts with the current key if the old key was used.
 * Returns the decrypted value and the rotated ciphertext (or null if no rotation needed).
 */
export async function decryptAndRotate(
  encrypted: ArrayBuffer,
  userId: string,
  env: EncryptionEnv
): Promise<{ value: string; rotated: ArrayBuffer | null }> {
  // Try current key first
  try {
    const value = await decryptWithKey(encrypted, userId, env.ENCRYPTION_KEY);
    return { value, rotated: null };
  } catch {
    // If current key fails, try old key and rotate
    if (!env.ENCRYPTION_KEY_OLD) {
      throw new Error("Decryption failed");
    }

    const value = await decryptWithKey(
      encrypted,
      userId,
      env.ENCRYPTION_KEY_OLD
    );
    const rotated = await encrypt(value, userId, env.ENCRYPTION_KEY);

    return { value, rotated };
  }
}

/**
 * Converts an ArrayBuffer to a URL-safe base64 string.
 * Uses - and _ instead of + and / to avoid JSON escaping issues.
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  // Convert to URL-safe base64
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * Converts a base64 string (standard or URL-safe) to an ArrayBuffer.
 * Handles both + and - as well as / and _ for backwards compatibility.
 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  // Convert URL-safe base64 back to standard base64
  const standardBase64 = base64.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(standardBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Constant-time string comparison to prevent timing attacks.
 * Returns true if strings are equal, false otherwise.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBuf = encoder.encode(a);
  const bBuf = encoder.encode(b);

  if (aBuf.length !== bBuf.length) {
    // Compare against self to maintain constant time even on length mismatch
    const dummy = new Uint8Array(aBuf.length);
    crypto.subtle.timingSafeEqual(aBuf, dummy);
    return false;
  }

  return crypto.subtle.timingSafeEqual(aBuf, bBuf);
}
