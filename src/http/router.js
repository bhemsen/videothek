/**
 * @typedef {{ id: number, username: string, role: 'admin' | 'user' }} AuthUser
 */

/**
 * @typedef {{
 *   user: AuthUser | null,
 *   params: Record<string, string>,
 *   url: URL,
 *   sessionId: string | null,
 * }} RequestContext
 */

/**
 * @typedef {(
 *   req: import('node:http').IncomingMessage,
 *   res: import('node:http').ServerResponse,
 *   ctx: RequestContext,
 * ) => void | Promise<void>} Handler
 */

/**
 * @typedef {{
 *   literalChildren: Map<string, RouteNode>,
 *   paramChild: { name: string, node: RouteNode } | null,
 *   methods: Map<string, Handler>,
 * }} RouteNode
 */

/**
 * @typedef {{ type: 'handler', handler: Handler, params: Record<string, string> }} HandlerOutcome
 */

/**
 * @typedef {{ type: 'allow', methods: Set<string> }} AllowOutcome
 */

/**
 * @typedef {HandlerOutcome | AllowOutcome} MatchOutcome
 */

/**
 * Splits a `/`-separated path or pattern into its segments. `/` itself has
 * zero segments; a trailing slash yields a trailing empty segment, so it
 * stays distinct from the same path without one.
 * @param {string} pathOrPattern
 * @returns {string[]}
 */
function splitSegments(pathOrPattern) {
  const withoutLeadingSlash = pathOrPattern.slice(1);
  return withoutLeadingSlash === '' ? [] : withoutLeadingSlash.split('/');
}

/**
 * Percent-decodes one path segment for a `:name` param. Malformed encoding
 * or an empty result is rejected — a param must be one non-empty segment.
 * @param {string} raw
 * @returns {string | null}
 */
function decodeParamSegment(raw) {
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return decoded.length > 0 ? decoded : null;
}

/**
 * @returns {RouteNode}
 */
function createNode() {
  return { literalChildren: new Map(), paramChild: null, methods: new Map() };
}

/**
 * Registers a handler for a method and pattern on the trie rooted at `root`.
 * A duplicate `(method, pattern)` throws, and so does reusing a trie
 * position under a different `:name` — a node carries exactly one param
 * name, so a later pattern with a different name at the same position would
 * otherwise silently get the wrong `params` key.
 * @param {RouteNode} root
 * @param {{ method: string, pattern: string }[]} registered
 * @param {string} method
 * @param {string} pattern
 * @param {Handler} handler
 * @returns {void}
 */
function addRoute(root, registered, method, pattern, handler) {
  const upperMethod = method.toUpperCase();
  let node = root;
  for (const segment of splitSegments(pattern)) {
    if (segment.startsWith(':')) {
      const paramName = segment.slice(1);
      if (node.paramChild && node.paramChild.name !== paramName) {
        throw new Error(
          `param name conflict: :${node.paramChild.name} vs :${paramName} at the same ` +
            `position (registering ${upperMethod} ${pattern})`,
        );
      }
      if (!node.paramChild) {
        node.paramChild = { name: paramName, node: createNode() };
      }
      node = node.paramChild.node;
    } else {
      let child = node.literalChildren.get(segment);
      if (!child) {
        child = createNode();
        node.literalChildren.set(segment, child);
      }
      node = child;
    }
  }
  if (node.methods.has(upperMethod)) {
    throw new Error(`duplicate route: ${upperMethod} ${pattern}`);
  }
  node.methods.set(upperMethod, handler);
  registered.push({ method: upperMethod, pattern });
}

/**
 * Resolves the outcome at a leaf node once the full path has been consumed:
 * an exact method match, a `HEAD` → `GET` fallback, an `{ allow }` candidate
 * when the node has other methods, or `null` when it has none.
 * @param {RouteNode} node
 * @param {string} method
 * @returns {MatchOutcome | null}
 */
function leafResult(node, method) {
  const handler = node.methods.get(method);
  if (handler) return { type: 'handler', handler, params: {} };

  if (method === 'HEAD') {
    const getHandler = node.methods.get('GET');
    if (getHandler) return { type: 'handler', handler: getHandler, params: {} };
  }

  if (node.methods.size === 0) return null;
  const methods = new Set(node.methods.keys());
  if (methods.has('GET')) methods.add('HEAD');
  return { type: 'allow', methods };
}

/**
 * Matches the remaining path segments from `index` against the trie,
 * trying the literal child before the param child at each segment and
 * backtracking to the param child when the literal subtree yields no
 * handler or `{ allow }` candidate at the matched path length — a literal
 * only beats a param when both would otherwise match the same path.
 * `{ allow }` candidates from both branches are merged, so the result
 * reflects every pattern that fits the path, not just the first one found.
 * @param {RouteNode} node
 * @param {string[]} segments
 * @param {number} index
 * @param {string} method
 * @returns {MatchOutcome | null}
 */
function matchNode(node, segments, index, method) {
  if (index === segments.length) return leafResult(node, method);

  const raw = segments[index];
  /** @type {Set<string> | null} */
  let allow = null;

  const literalChild = node.literalChildren.get(raw);
  if (literalChild) {
    const result = matchNode(literalChild, segments, index + 1, method);
    if (result && result.type === 'handler') return result;
    if (result && result.type === 'allow') allow = result.methods;
  }

  if (node.paramChild) {
    const decoded = decodeParamSegment(raw);
    if (decoded !== null) {
      const result = matchNode(node.paramChild.node, segments, index + 1, method);
      if (result && result.type === 'handler') {
        result.params[node.paramChild.name] = decoded;
        return result;
      }
      if (result && result.type === 'allow') {
        allow = allow ? new Set([...allow, ...result.methods]) : result.methods;
      }
    }
  }

  return allow ? { type: 'allow', methods: allow } : null;
}

/**
 * Matches a method and pathname against the trie rooted at `root`.
 * @param {RouteNode} root
 * @param {string} method
 * @param {string} pathname
 * @returns {{ handler: Handler, params: Record<string, string> } | { allow: string[] } | null}
 */
function matchRoute(root, method, pathname) {
  const result = matchNode(root, splitSegments(pathname), 0, method.toUpperCase());
  if (!result) return null;
  if (result.type === 'handler') return { handler: result.handler, params: result.params };
  return { allow: [...result.methods].sort() };
}

/**
 * Creates a router with whole-segment path matching: `:name` matches exactly
 * one non-empty percent-decoded segment, a literal segment beats a param at
 * the same position when both would otherwise match, and a duplicate
 * `(method, pattern)` registration throws.
 * @returns {{
 *   add: (method: string, pattern: string, handler: Handler) => void,
 *   match: (method: string, pathname: string) =>
 *     { handler: Handler, params: Record<string, string> } | { allow: string[] } | null,
 *   routes: () => { method: string, pattern: string }[],
 * }}
 */
export function createRouter() {
  const root = createNode();
  /** @type {{ method: string, pattern: string }[]} */
  const registered = [];

  return {
    add: (method, pattern, handler) => addRoute(root, registered, method, pattern, handler),
    match: (method, pathname) => matchRoute(root, method, pathname),
    routes: () => registered.map((route) => ({ ...route })),
  };
}
