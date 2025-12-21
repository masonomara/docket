import { describe, it, expect } from "vitest";
import {
  encrypt,
  decrypt,
  decryptAndRotate,
  arrayBufferToBase64,
  base64ToArrayBuffer,
} from "../../src/lib/encryption";

// ============================================================================
// Test Constants
// ============================================================================

const TEST_KEY = "test-encryption-key-32-chars-ok!";
const OLD_KEY = "old-encryption-key-32-chars-ok!!";
const TEST_USER_ID = "user-123";

// ============================================================================
// Encryption Tests
// ============================================================================

describe("Encryption", () => {
  it("encrypts and decrypts data", async () => {
    const originalData = "sensitive-oauth-token-12345";

    const encrypted = await encrypt(originalData, TEST_USER_ID, TEST_KEY);
    const decrypted = await decrypt(encrypted, TEST_USER_ID, {
      ENCRYPTION_KEY: TEST_KEY,
    });

    expect(decrypted).toBe(originalData);
  });

  it("produces different ciphertext for same plaintext (random IV)", async () => {
    const plaintext = "same-data";

    const encrypted1 = await encrypt(plaintext, TEST_USER_ID, TEST_KEY);
    const encrypted2 = await encrypt(plaintext, TEST_USER_ID, TEST_KEY);

    const ciphertext1 = arrayBufferToBase64(encrypted1);
    const ciphertext2 = arrayBufferToBase64(encrypted2);

    // Random IV should produce different ciphertext each time
    expect(ciphertext1).not.toBe(ciphertext2);
  });

  it("produces different ciphertext for different users", async () => {
    const plaintext = "same-data";

    const encryptedForUser1 = await encrypt(plaintext, "user-1", TEST_KEY);

    // Should fail to decrypt with different user's salt
    await expect(
      decrypt(encryptedForUser1, "user-2", { ENCRYPTION_KEY: TEST_KEY })
    ).rejects.toThrow();
  });

  it("fails to decrypt with wrong key", async () => {
    const encrypted = await encrypt("secret", TEST_USER_ID, TEST_KEY);

    await expect(
      decrypt(encrypted, TEST_USER_ID, {
        ENCRYPTION_KEY: "wrong-key-that-wont-work!!",
      })
    ).rejects.toThrow();
  });

  it("decrypts with old key when current fails", async () => {
    // Encrypt with old key
    const encrypted = await encrypt("legacy", TEST_USER_ID, OLD_KEY);

    // Decrypt should fall back to old key
    const decrypted = await decrypt(encrypted, TEST_USER_ID, {
      ENCRYPTION_KEY: TEST_KEY,
      ENCRYPTION_KEY_OLD: OLD_KEY,
    });

    expect(decrypted).toBe("legacy");
  });

  it("decrypts and rotates to new key", async () => {
    // Encrypt with old key
    const encrypted = await encrypt("rotate-me", TEST_USER_ID, OLD_KEY);

    // Decrypt and rotate
    const { value, rotated } = await decryptAndRotate(encrypted, TEST_USER_ID, {
      ENCRYPTION_KEY: TEST_KEY,
      ENCRYPTION_KEY_OLD: OLD_KEY,
    });

    expect(value).toBe("rotate-me");
    expect(rotated).not.toBeNull();

    // Rotated ciphertext should now decrypt with current key
    const decryptedRotated = await decrypt(rotated!, TEST_USER_ID, {
      ENCRYPTION_KEY: TEST_KEY,
    });
    expect(decryptedRotated).toBe("rotate-me");
  });

  it("returns null for rotated when already using current key", async () => {
    // Encrypt with current key
    const encrypted = await encrypt("current", TEST_USER_ID, TEST_KEY);

    const { rotated } = await decryptAndRotate(encrypted, TEST_USER_ID, {
      ENCRYPTION_KEY: TEST_KEY,
      ENCRYPTION_KEY_OLD: OLD_KEY,
    });

    // No rotation needed
    expect(rotated).toBeNull();
  });

  it("fails when no old key and current key fails", async () => {
    const unknownKey = "unknown-key-12345678901234";
    const encrypted = await encrypt("orphaned", TEST_USER_ID, unknownKey);

    await expect(
      decrypt(encrypted, TEST_USER_ID, { ENCRYPTION_KEY: TEST_KEY })
    ).rejects.toThrow("Decryption failed");
  });
});

// ============================================================================
// Base64 Helper Tests
// ============================================================================

describe("Base64 Helpers", () => {
  it("converts ArrayBuffer to base64 and back", () => {
    const originalBytes = new Uint8Array([1, 2, 3, 4, 5, 255, 0, 128]);

    const base64 = arrayBufferToBase64(originalBytes.buffer);
    const roundTripped = new Uint8Array(base64ToArrayBuffer(base64));

    expect(roundTripped).toEqual(originalBytes);
  });

  it("handles empty buffer", () => {
    const emptyBuffer = new Uint8Array([]).buffer;

    const base64 = arrayBufferToBase64(emptyBuffer);
    const roundTripped = new Uint8Array(base64ToArrayBuffer(base64));

    expect(roundTripped).toEqual(new Uint8Array([]));
  });

  it("produces valid base64 string", () => {
    // "Hello" in ASCII
    const helloBytes = new Uint8Array([72, 101, 108, 108, 111]);
    const base64 = arrayBufferToBase64(helloBytes.buffer);

    // Should match base64 pattern
    expect(base64).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);

    // "Hello" in base64 is "SGVsbG8="
    expect(base64).toBe("SGVsbG8=");
  });
});
