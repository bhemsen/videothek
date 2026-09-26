import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * @typedef {object} Config
 * @property {string|null} mediaRoot - Absolute path to the read-only media
 *   library, or `null` when `requireMediaRoot` was `false` and no usable
 *   value was configured.
 * @property {string} dataDir - Absolute path for the SQLite database
 *   directory (not created here — `openDatabase` does that).
 * @property {string} host - HTTP bind address.
 * @property {number} port - HTTP bind port, 1-65535.
 * @property {number} rescanIntervalMin - Periodic full rescan interval in
 *   minutes, 1-1440.
 * @property {string|null} adminUser - Initial admin username, or `null`.
 * @property {string|null} adminPassword - Initial admin password, or `null`.
 */

/**
 * Thrown by {@link loadConfig} when one or more environment variables are
 * invalid. `problems` never contains a variable's value, only its name and
 * the violated rule, so it is safe to log in full.
 */
export class ConfigError extends Error {
  /**
   * @param {string[]} problems - Each entry formatted `"<VAR>: <rule>"`.
   */
  constructor(problems) {
    super(`invalid configuration: ${problems.join('; ')}`);
    this.name = 'ConfigError';
    /** @type {string[]} */
    this.problems = problems;
  }
}

/**
 * Reads an environment variable, treating an unset or empty-string value as
 * absent (per the constitution's config rules).
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 * @returns {string|undefined}
 */
function readVar(env, name) {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

/**
 * @param {string} raw
 * @returns {number|null} the parsed integer, or `null` if `raw` is not a
 *   plain non-negative integer literal.
 */
function parseStrictInt(raw) {
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw);
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function isReadableDirectory(path) {
  try {
    if (!statSync(path).isDirectory()) return false;
    accessSync(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves and validates `MEDIA_ROOT`. The returned value, when not `null`,
 * has always passed through `path.resolve` (normalized, no trailing `.`/`..`
 * segments) so downstream containment checks can compare it directly. When
 * `requireMediaRoot` is `false` (CLI tools that must keep working with the
 * media disk unmounted) no problem is ever raised: a usable absolute value
 * is resolved and returned, anything else yields `null`.
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} problems
 * @param {boolean} requireMediaRoot
 * @returns {string|null}
 */
function resolveMediaRoot(env, problems, requireMediaRoot) {
  const raw = readVar(env, 'MEDIA_ROOT');
  if (!requireMediaRoot) {
    return raw !== undefined && isAbsolute(raw) ? resolve(raw) : null;
  }
  if (raw === undefined) {
    problems.push('MEDIA_ROOT: required');
    return null;
  }
  if (!isAbsolute(raw)) {
    problems.push('MEDIA_ROOT: must be an absolute path');
    return null;
  }
  if (!isReadableDirectory(raw)) {
    problems.push('MEDIA_ROOT: must be a readable directory');
    return null;
  }
  return resolve(raw);
}

/**
 * Containment via `path.relative` rather than a string-prefix test, so it
 * cannot be fooled by an unnormalized path (trailing `.`/`..` segments) or,
 * on win32, by a differently-cased path (`path.relative` is case-insensitive
 * there) — see `resolveMediaPath`'s decision in the video-streaming spec.
 * @param {string} parent - Resolved absolute path.
 * @param {string} child - Resolved absolute path.
 * @returns {boolean} whether `child` is `parent` itself or lies inside it.
 */
function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * Resolves `DATA_DIR` against the current working directory and, unless
 * `requireMediaRoot` is `false` (this containment check is itself one of
 * the "MEDIA_ROOT checks" that mode skips), checks it does not lie inside
 * `mediaRoot`.
 * @param {NodeJS.ProcessEnv} env
 * @param {string|null} mediaRoot
 * @param {string[]} problems
 * @param {boolean} requireMediaRoot
 * @returns {string}
 */
function resolveDataDir(env, mediaRoot, problems, requireMediaRoot) {
  const raw = readVar(env, 'DATA_DIR') ?? './data';
  const dataDir = resolve(process.cwd(), raw);
  if (requireMediaRoot && mediaRoot !== null && isInside(mediaRoot, dataDir)) {
    problems.push('DATA_DIR: must not be inside MEDIA_ROOT');
  }
  return dataDir;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} problems
 * @returns {number}
 */
function resolvePort(env, problems) {
  const raw = readVar(env, 'PORT');
  if (raw === undefined) return 8080;
  const port = parseStrictInt(raw);
  if (port === null || port < 1 || port > 65535) {
    problems.push('PORT: must be an integer between 1 and 65535');
    return 8080;
  }
  return port;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} problems
 * @returns {number}
 */
function resolveRescanIntervalMin(env, problems) {
  const raw = readVar(env, 'RESCAN_INTERVAL_MIN');
  if (raw === undefined) return 15;
  const value = parseStrictInt(raw);
  if (value === null || value < 1 || value > 1440) {
    problems.push('RESCAN_INTERVAL_MIN: must be an integer between 1 and 1440');
    return 15;
  }
  return value;
}

/**
 * `ADMIN_USER`/`ADMIN_PASSWORD` are optional but must be set together.
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} problems
 * @returns {{ adminUser: string|null, adminPassword: string|null }}
 */
function resolveAdmin(env, problems) {
  const adminUser = readVar(env, 'ADMIN_USER') ?? null;
  const adminPassword = readVar(env, 'ADMIN_PASSWORD') ?? null;
  if ((adminUser === null) !== (adminPassword === null)) {
    const missing = adminUser === null ? 'ADMIN_USER' : 'ADMIN_PASSWORD';
    problems.push(`${missing}: required when the other ADMIN_* variable is set`);
  }
  return { adminUser, adminPassword };
}

/**
 * Reads and validates every configuration variable in one pass, collecting
 * all problems instead of failing on the first one. Never logs or includes
 * a variable's value, only its name and the violated rule.
 * @param {NodeJS.ProcessEnv} [env] - Defaults to `process.env`; this is the
 *   only place in the codebase that reads it.
 * @param {{ requireMediaRoot?: boolean }} [options] - `requireMediaRoot:
 *   false` skips every `MEDIA_ROOT`-related check (CLI tools that must work
 *   with the media disk unmounted).
 * @returns {Config} a frozen, fully validated configuration object.
 * @throws {ConfigError} when any variable is invalid.
 */
export function loadConfig(env = process.env, { requireMediaRoot = true } = {}) {
  /** @type {string[]} */
  const problems = [];
  const mediaRoot = resolveMediaRoot(env, problems, requireMediaRoot);
  const dataDir = resolveDataDir(env, mediaRoot, problems, requireMediaRoot);
  const host = readVar(env, 'HOST') ?? '0.0.0.0';
  const port = resolvePort(env, problems);
  const rescanIntervalMin = resolveRescanIntervalMin(env, problems);
  const { adminUser, adminPassword } = resolveAdmin(env, problems);
  if (problems.length > 0) {
    throw new ConfigError(problems);
  }
  return Object.freeze({
    mediaRoot,
    dataDir,
    host,
    port,
    rescanIntervalMin,
    adminUser,
    adminPassword,
  });
}
