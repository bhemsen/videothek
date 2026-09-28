// @ts-check

/**
 * Shared `limit` query-parameter parsing for the start page's two endpoints
 * (`src/api/home-listening.js`, `src/api/home-previews.js`). Mirrors
 * `src/api/progress-rules.js`'s `parseLimitParam`, with its own default and
 * upper bound.
 */

/** Default `limit` when the query parameter is absent. */
export const HOME_LIMIT_DEFAULT = 10;

/** Maximum accepted `limit`. */
export const HOME_LIMIT_MAX = 20;

/**
 * Parses the `limit` query parameter shared by `GET /api/home/listening` and
 * `GET /api/home/previews`: absent -> `HOME_LIMIT_DEFAULT`; a string of
 * plain digits in `1..HOME_LIMIT_MAX` -> that integer; anything else (empty,
 * signed, fractional, out of range, non-numeric) -> `null`, meaning the
 * caller must answer `400 invalid_query`.
 * @param {URLSearchParams} searchParams request query parameters
 * @returns {number | null} the parsed limit, or `null` when invalid
 */
export function parseHomeLimit(searchParams) {
  const raw = searchParams.get('limit');
  if (raw === null) {
    return HOME_LIMIT_DEFAULT;
  }
  if (!/^[0-9]+$/.test(raw)) {
    return null;
  }
  const limit = Number(raw);
  return limit >= 1 && limit <= HOME_LIMIT_MAX ? limit : null;
}
