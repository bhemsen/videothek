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
 * Creates a router with whole-segment path matching: `:name` matches exactly
 * one non-empty percent-decoded segment, a literal segment beats a param at
 * the same position, and a duplicate `(method, pattern)` registration throws.
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

  /**
   * Registers a handler for a method and pattern.
   * @param {string} method
   * @param {string} pattern
   * @param {Handler} handler
   * @returns {void}
   */
  function add(method, pattern, handler) {
    const upperMethod = method.toUpperCase();
    let node = root;
    for (const segment of splitSegments(pattern)) {
      if (segment.startsWith(':')) {
        if (!node.paramChild) {
          node.paramChild = { name: segment.slice(1), node: createNode() };
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
   * Matches a method and pathname against the registered routes.
   * @param {string} method
   * @param {string} pathname
   * @returns {{ handler: Handler, params: Record<string, string> } | { allow: string[] } | null}
   */
  function match(method, pathname) {
    const upperMethod = method.toUpperCase();
    /** @type {Record<string, string>} */
    const params = {};
    let node = root;
    for (const raw of splitSegments(pathname)) {
      const literalChild = node.literalChildren.get(raw);
      if (literalChild) {
        node = literalChild;
        continue;
      }
      if (!node.paramChild) return null;
      const decoded = decodeParamSegment(raw);
      if (decoded === null) return null;
      params[node.paramChild.name] = decoded;
      node = node.paramChild.node;
    }

    const handler = node.methods.get(upperMethod);
    if (handler) return { handler, params };

    const getHandler = node.methods.get('GET');
    if (upperMethod === 'HEAD' && getHandler) return { handler: getHandler, params };

    if (node.methods.size > 0) {
      const allow = new Set(node.methods.keys());
      if (allow.has('GET')) allow.add('HEAD');
      return { allow: [...allow].sort() };
    }

    return null;
  }

  /**
   * Lists every registered route.
   * @returns {{ method: string, pattern: string }[]}
   */
  function routes() {
    return registered.map((route) => ({ ...route }));
  }

  return { add, match, routes };
}
