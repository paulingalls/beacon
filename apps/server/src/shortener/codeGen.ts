import { randomBytes } from 'node:crypto';

/** Base62 alphabet: A–Z, a–z, 0–9 (REQUIREMENTS.md §7.1). */
const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const CODE_LENGTH = 6;

// Largest multiple of 62 that fits in a byte (4 * 62 = 248). Bytes >= this are
// rejected so the modulo mapping stays unbiased: a raw `byte % 62` would
// over-weight the first 8 alphabet chars because 256 is not a multiple of 62.
const REJECT_THRESHOLD = Math.floor(256 / CHARSET.length) * CHARSET.length;

/**
 * Generate a random 6-character base62 short code (REQUIREMENTS.md §7.1).
 *
 * Crypto-sourced and unpredictable. Uses rejection sampling (discard bytes
 * >= 248) so each alphabet character is equally likely — naive `byte % 62`
 * would bias toward the start of the alphabet. Pure: no DB interaction, so
 * collision handling lives in the store (createShortLink).
 */
export function generateCode(): string {
  let code = '';
  while (code.length < CODE_LENGTH) {
    // Over-draw a small pool of random bytes to amortize syscalls; on the rare
    // run where rejections exhaust the pool, the loop simply draws another.
    const pool = randomBytes(CODE_LENGTH * 2);
    for (let i = 0; i < pool.length && code.length < CODE_LENGTH; i++) {
      const byte = pool[i] as number;
      if (byte >= REJECT_THRESHOLD) continue;
      code += CHARSET[byte % CHARSET.length];
    }
  }
  return code;
}
