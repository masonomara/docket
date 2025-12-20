import { describe, it, expect } from "vitest";
import {
  encrypt,
  decrypt,
  decryptAndRotate,
  arrayBufferToBase64,
  base64ToArrayBuffer,
  type EncryptionEnv,
} from "../src/lib/encryption";

describe("Encryption", () => {
  const testKey = "test-encryption-key-32-chars-ok!";
  const testKeyOld = "old-encryption-key-32-chars-ok!!";
  const userId = "user-123";

  it("encrypts and decrypts data", async () => {
    const original = "sensitive-oauth-token-12345";
    const encrypted = await encrypt(original, userId, testKey);
    expect(await decrypt(encrypted, userId, { ENCRYPTION_KEY: testKey })).toBe(
      original
    );
  });

  it("produces different ciphertext for same plaintext (random IV)", async () => {
    const encrypted1 = await encrypt("same-data", userId, testKey);
    const encrypted2 = await encrypt("same-data", userId, testKey);
    expect(arrayBufferToBase64(encrypted1)).not.toBe(
      arrayBufferToBase64(encrypted2)
    );
  });

  it("produces different ciphertext for different users", async () => {
    const encrypted1 = await encrypt("same-data", "user-1", testKey);
    await expect(
      decrypt(encrypted1, "user-2", { ENCRYPTION_KEY: testKey })
    ).rejects.toThrow();
  });

  it("fails to decrypt with wrong key", async () => {
    const encrypted = await encrypt("secret-data", userId, testKey);
    await expect(
      decrypt(encrypted, userId, {
        ENCRYPTION_KEY: "wrong-key-that-wont-work!!",
      })
    ).rejects.toThrow();
  });

  it("decrypts with old key when current fails", async () => {
    const encrypted = await encrypt(
      "legacy-encrypted-data",
      userId,
      testKeyOld
    );
    expect(
      await decrypt(encrypted, userId, {
        ENCRYPTION_KEY: testKey,
        ENCRYPTION_KEY_OLD: testKeyOld,
      })
    ).toBe("legacy-encrypted-data");
  });

  it("decrypts and rotates to new key", async () => {
    const encrypted = await encrypt(
      "data-needing-rotation",
      userId,
      testKeyOld
    );
    const { value, rotated } = await decryptAndRotate(encrypted, userId, {
      ENCRYPTION_KEY: testKey,
      ENCRYPTION_KEY_OLD: testKeyOld,
    });
    expect(value).toBe("data-needing-rotation");
    expect(rotated).not.toBeNull();
    expect(await decrypt(rotated!, userId, { ENCRYPTION_KEY: testKey })).toBe(
      "data-needing-rotation"
    );
  });

  it("returns null for rotated when already using current key", async () => {
    const encrypted = await encrypt("already-current", userId, testKey);
    const { value, rotated } = await decryptAndRotate(encrypted, userId, {
      ENCRYPTION_KEY: testKey,
      ENCRYPTION_KEY_OLD: testKeyOld,
    });
    expect(value).toBe("already-current");
    expect(rotated).toBeNull();
  });

  it("fails when no old key and current key fails", async () => {
    const encrypted = await encrypt(
      "orphaned-data",
      userId,
      "unknown-key-12345678901234"
    );
    await expect(
      decrypt(encrypted, userId, { ENCRYPTION_KEY: testKey })
    ).rejects.toThrow("Decryption failed");
  });
});

describe("Base64 Helpers", () => {
  it("converts ArrayBuffer to base64 and back", () => {
    const original = new Uint8Array([1, 2, 3, 4, 5, 255, 0, 128]);
    expect(
      new Uint8Array(base64ToArrayBuffer(arrayBufferToBase64(original.buffer)))
    ).toEqual(original);
  });

  it("handles empty buffer", () => {
    const empty = new Uint8Array([]);
    expect(
      new Uint8Array(base64ToArrayBuffer(arrayBufferToBase64(empty.buffer)))
    ).toEqual(empty);
  });

  it("produces valid base64 string", () => {
    const base64 = arrayBufferToBase64(
      new Uint8Array([72, 101, 108, 108, 111]).buffer
    );
    expect(base64).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
    expect(base64).toBe("SGVsbG8=");
  });
});
