import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const SCRYPT_N = 2 ** 14;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/**
 * Derives a scrypt key, resolving to a Buffer of `keyLength` bytes.
 * @param {string} password
 * @param {Buffer} salt
 * @param {number} n
 * @param {number} r
 * @param {number} p
 * @param {number} keyLength
 * @returns {Promise<Buffer>}
 */
function deriveKey(password, salt, n, r, p, keyLength) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, { N: n, r, p }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

/**
 * Parses a `scrypt$N$r$p$saltBase64$hashBase64` string.
 * @param {string} stored
 * @returns {{ n: number, r: number, p: number, salt: Buffer, hash: Buffer } | null}
 */
function parseHash(stored) {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const n = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  const paramsValid =
    Number.isInteger(n) && n > 1 && Number.isInteger(r) && r > 0 && Number.isInteger(p) && p > 0;
  if (!paramsValid) return null;
  const salt = Buffer.from(saltB64, 'base64');
  const hash = Buffer.from(hashB64, 'base64');
  if (salt.length === 0 || hash.length === 0) return null;
  return { n, r, p, salt, hash };
}

/**
 * Hashes a plaintext password with scrypt (N=2^14, r=8, p=1, 64-byte
 * derived key, 16-byte random salt).
 * @param {string} password
 * @returns {Promise<string>} `scrypt$N$r$p$saltBase64$hashBase64`
 */
export async function hashPassword(password) {
  const salt = randomBytes(SALT_LENGTH);
  const derivedKey = await deriveKey(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P, KEY_LENGTH);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${derivedKey.toString('base64')}`;
}

/**
 * Verifies a plaintext password against a stored scrypt hash string. Never
 * throws: a malformed or tampered `stored` value resolves to `false`.
 * @param {string} password
 * @param {string} stored
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, stored) {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  const { n, r, p, salt, hash } = parsed;
  try {
    const derivedKey = await deriveKey(password, salt, n, r, p, hash.length);
    return derivedKey.length === hash.length && timingSafeEqual(derivedKey, hash);
  } catch {
    return false;
  }
}

/**
 * A valid-format scrypt hash of no real password (fixed salt, precomputed).
 * Used to run `verifyPassword` against unknown usernames or over-long
 * passwords so a failed lookup costs the same time as a real verification.
 * @type {string}
 */
export const DUMMY_HASH =
  'scrypt$16384$8$1$dmlkZW90aGVrLWR1bW15LQ==$mRHQXIMLWJb5etZLs/HblWltkU1PAfFCNKcEmFQpVsPN6w4LpzP53n0dvAeRb5OKmTOqzNZemHg+dYE8UekTwQ==';
