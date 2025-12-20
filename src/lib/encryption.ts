export interface EncryptionEnv {
  ENCRYPTION_KEY: string;
  ENCRYPTION_KEY_OLD?: string;
}

async function deriveKey(secret: string, salt: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: new TextEncoder().encode(salt),
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encrypt(
  data: string,
  userId: string,
  encryptionKey: string
): Promise<ArrayBuffer> {
  const key = await deriveKey(encryptionKey, userId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(data)
  );
  const result = new Uint8Array(iv.length + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), iv.length);
  return result.buffer;
}

async function decryptWithKey(
  encrypted: ArrayBuffer,
  userId: string,
  encryptionKey: string
): Promise<string> {
  const key = await deriveKey(encryptionKey, userId);
  const data = new Uint8Array(encrypted);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: data.slice(0, 12) },
    key,
    data.slice(12)
  );
  return new TextDecoder().decode(decrypted);
}

export async function decrypt(
  encrypted: ArrayBuffer,
  userId: string,
  env: EncryptionEnv
): Promise<string> {
  try {
    return await decryptWithKey(encrypted, userId, env.ENCRYPTION_KEY);
  } catch {
    if (env.ENCRYPTION_KEY_OLD)
      return await decryptWithKey(encrypted, userId, env.ENCRYPTION_KEY_OLD);
    throw new Error("Decryption failed");
  }
}

export async function decryptAndRotate(
  encrypted: ArrayBuffer,
  userId: string,
  env: EncryptionEnv
): Promise<{ value: string; rotated: ArrayBuffer | null }> {
  try {
    return {
      value: await decryptWithKey(encrypted, userId, env.ENCRYPTION_KEY),
      rotated: null,
    };
  } catch {
    if (!env.ENCRYPTION_KEY_OLD) throw new Error("Decryption failed");
    const value = await decryptWithKey(
      encrypted,
      userId,
      env.ENCRYPTION_KEY_OLD
    );
    return { value, rotated: await encrypt(value, userId, env.ENCRYPTION_KEY) };
  }
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++)
    binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
