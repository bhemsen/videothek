import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Absolute path to the app's static frontend directory (`<repo>/public`),
 * derived lexically from this module's own location (`<src>/../public`), the
 * same pattern `src/app.js`'s `DEFAULT_PUBLIC_DIR` uses. Config validation
 * and the conversion queue's `start()` both reject a `CONVERT_DIR` that lies
 * inside it, because static files are served without a session.
 */
export const APP_PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const CONVERTER_CMD_MAX_TOKENS = 32;
const WIN32_DRIVE_OR_UNC_RE = /^(?:[a-zA-Z]:[\\/]|\\\\)/;
const CONVERTER_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'SystemRoot'];

/**
 * Containment via `path.relative` rather than a string-prefix test, so it
 * cannot be fooled by an unnormalized path (trailing `.`/`..` segments) or,
 * on win32, by a differently-cased path (`path.relative` is case-insensitive
 * there) — see `resolveMediaPath`'s decision in the video-streaming spec.
 * @param {string} parent - Resolved absolute path.
 * @param {string} child - Resolved absolute path.
 * @returns {boolean} whether `child` is `parent` itself or lies inside it.
 */
export function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * Whether `token` is an absolute path on `platform`. On `win32` this is
 * intentionally stricter than plain absoluteness: a rooted path such as
 * `\node.exe` is absolute but depends on the current drive, so only a
 * drive-letter (`X:\`, `X:/`) or UNC (`\\server\...`) prefix counts.
 * @param {string} token
 * @param {NodeJS.Platform} platform
 * @returns {boolean}
 */
function isAbsoluteConverterToken(token, platform) {
  return platform === 'win32' ? WIN32_DRIVE_OR_UNC_RE.test(token) : token.startsWith('/');
}

/**
 * Parses `CONVERTER_CMD` into argv tokens for the converter child process.
 * An unset or blank (whitespace-only) value means the feature is off — not a
 * config error. Otherwise the value is trimmed and split on runs of
 * whitespace, with no quote or escape handling.
 * @param {string|undefined} value - Raw `CONVERTER_CMD` env value.
 * @param {{ platform?: NodeJS.Platform }} [options]
 * @returns {{ cmd: readonly string[] | null, problem: string | null }}
 *   `problem`, when non-null, is formatted `"CONVERTER_CMD: <rule>"` and
 *   never contains `value`.
 */
export function parseConverterCmd(value, { platform = process.platform } = {}) {
  if (value === undefined || value.trim() === '') {
    return { cmd: null, problem: null };
  }
  const tokens = value.trim().split(/\s+/);
  if (tokens.length > CONVERTER_CMD_MAX_TOKENS) {
    return {
      cmd: null,
      problem: `CONVERTER_CMD: must have at most ${CONVERTER_CMD_MAX_TOKENS} tokens`,
    };
  }
  if (!isAbsoluteConverterToken(tokens[0], platform)) {
    const rule =
      platform === 'win32'
        ? 'first token must be an absolute path with a drive letter or UNC prefix'
        : 'first token must be an absolute path';
    return { cmd: null, problem: `CONVERTER_CMD: ${rule}` };
  }
  return { cmd: Object.freeze(tokens), problem: null };
}

/**
 * Builds the allowlisted environment for the converter child process: only
 * `PATH`, `HOME`, `LANG`, `LC_ALL` and `SystemRoot` are copied from `env`
 * (those actually set), so no other variable of the videothek process —
 * notably `ADMIN_PASSWORD` — ever reaches it. `TMPDIR`/`TEMP`/`TMP` are
 * deliberately not copied: the queue points them at the per-job temp dir
 * instead. The lookup is case-insensitive on `win32`, where a plain-object
 * `env` spells `PATH` as `Path`; the copy keeps the key exactly as found.
 * @param {NodeJS.ProcessEnv} env
 * @param {{ platform?: NodeJS.Platform }} [options]
 * @returns {Readonly<Record<string, string>>}
 */
export function pickConverterEnv(env, { platform = process.platform } = {}) {
  /** @type {Record<string, string>} */
  const result = {};
  const envKeys = Object.keys(env);
  for (const wanted of CONVERTER_ENV_KEYS) {
    const key =
      platform === 'win32'
        ? envKeys.find((k) => k.toLowerCase() === wanted.toLowerCase())
        : envKeys.find((k) => k === wanted);
    if (key === undefined) continue;
    const value = env[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return Object.freeze(result);
}
