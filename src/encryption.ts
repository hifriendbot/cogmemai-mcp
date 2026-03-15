/**
 * CogmemAi Local Encryption — AES-256-GCM with quantum-resistant symmetric key.
 *
 * AES-256 is quantum-resistant: Grover's algorithm halves effective key strength
 * to ~AES-128, which remains computationally secure against quantum attack.
 *
 * Format: QE1:<base64(iv + authTag + ciphertext)>
 * - QE1 prefix = Quantum Encryption v1 (format identifier)
 * - IV: 12 bytes (96-bit, GCM standard)
 * - Auth tag: 16 bytes (128-bit, integrity verification)
 * - Ciphertext: variable length
 */

import { randomBytes, createCipheriv, createDecipheriv, pbkdf2Sync } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { FLAG_DIR } from './config.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;     // 96-bit IV for GCM
const TAG_LENGTH = 16;    // 128-bit auth tag
const KEY_LENGTH = 32;    // 256-bit key
const PREFIX = 'QE1:';    // Quantum Encryption v1 format marker
const KEY_FILE = join(FLAG_DIR, 'encryption.key');
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_SALT = 'cogmemai-quantum-safe-v1'; // Static salt is fine — key file is user-unique

let cachedKey: Buffer | null = null;

/**
 * Check if local encryption is enabled.
 */
export function isEncryptionEnabled(): boolean {
  return process.env.COGMEMAI_LOCAL_ENCRYPTION !== 'off';
}

/**
 * Get or create the encryption key.
 * Key is derived from either:
 * 1. COGMEMAI_ENCRYPTION_KEY env var (user-provided passphrase → PBKDF2 → 256-bit key)
 * 2. Auto-generated 256-bit random key stored in ~/.cogmemai/encryption.key
 */
function getKey(): Buffer {
  if (cachedKey) return cachedKey;

  // Option 1: User-provided passphrase via env var
  const passphrase = process.env.COGMEMAI_ENCRYPTION_KEY;
  if (passphrase) {
    cachedKey = pbkdf2Sync(passphrase, PBKDF2_SALT, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha512');
    return cachedKey;
  }

  // Option 2: Auto-generated key file
  if (existsSync(KEY_FILE)) {
    const hex = readFileSync(KEY_FILE, 'utf-8').trim();
    cachedKey = Buffer.from(hex, 'hex');
    if (cachedKey.length !== KEY_LENGTH) {
      throw new Error('Corrupted encryption key file. Delete ~/.cogmemai/encryption.key to regenerate.');
    }
    return cachedKey;
  }

  // Generate new key
  mkdirSync(dirname(KEY_FILE), { recursive: true });
  const newKey = randomBytes(KEY_LENGTH);
  writeFileSync(KEY_FILE, newKey.toString('hex'), { mode: 0o600 });
  try { chmodSync(KEY_FILE, 0o600); } catch { /* Windows may not support chmod */ }
  cachedKey = newKey;
  return cachedKey;
}

/**
 * Encrypt plaintext with AES-256-GCM.
 * Returns: QE1:<base64(iv + authTag + ciphertext)>
 */
export function encrypt(plaintext: string): string {
  if (!plaintext || !isEncryptionEnabled()) return plaintext;

  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Pack: iv (12) + authTag (16) + ciphertext (variable)
  const packed = Buffer.concat([iv, authTag, encrypted]);
  return PREFIX + packed.toString('base64');
}

/**
 * Decrypt a QE1-prefixed ciphertext.
 * Returns plaintext, or the original string if not encrypted or decryption fails.
 */
export function decrypt(data: string): string {
  if (!data || !data.startsWith(PREFIX)) return data; // Not encrypted — return as-is

  try {
    const key = getKey();
    const packed = Buffer.from(data.slice(PREFIX.length), 'base64');

    if (packed.length < IV_LENGTH + TAG_LENGTH + 1) {
      return data; // Too short to be valid — return as-is
    }

    const iv = packed.subarray(0, IV_LENGTH);
    const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = packed.subarray(IV_LENGTH + TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  } catch {
    // Decryption failed — return original (may be legacy plaintext or corrupted)
    return data;
  }
}

/**
 * Check if a string is encrypted (has QE1: prefix).
 */
export function isEncrypted(data: string): boolean {
  return typeof data === 'string' && data.startsWith(PREFIX);
}

/**
 * Get encryption status info (for diagnostics, never expose the key).
 */
export function getEncryptionInfo(): { enabled: boolean; algorithm: string; keySource: string; quantumSafe: boolean } {
  return {
    enabled: isEncryptionEnabled(),
    algorithm: 'AES-256-GCM',
    keySource: process.env.COGMEMAI_ENCRYPTION_KEY ? 'passphrase (PBKDF2-SHA512)' : 'auto-generated key file',
    quantumSafe: true,
  };
}
