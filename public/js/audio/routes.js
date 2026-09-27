/**
 * Pure URL <-> route mapping for the audio section's client-side routing
 * (`pushState` between `/music` and `/audiobooks`, no reload). No DOM
 * access. See spec-music-audiobooks.md "Audio section URLs".
 */

/** @typedef {'music' | 'audiobooks'} AudioSection */
/** @typedef {'overview' | 'album' | 'grid' | 'book'} AudioView */
/** @typedef {{ section: AudioSection, view: AudioView, id: number | null }} AudioRoute */

// Same id shape as the server routes: 1-16 digits, no leading zero, and a
// safe integer once parsed (guards against precision loss on huge values).
const ID_PATTERN = /^[1-9][0-9]{0,15}$/;

/**
 * Parses a query-string id parameter; `null` for a missing or invalid value.
 * @param {string | null} raw
 * @returns {number | null}
 */
function parseId(raw) {
  if (raw === null || !ID_PATTERN.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * Parses a location into an audio route. The section is derived from the
 * pathname alone (never a stale `data-category`, since `pushState` moves
 * between the two pages without a reload). An invalid or missing id
 * resolves to the section's overview/grid view — `audioUrl` of that result
 * then differs from the input, which is the caller's cue to clean the URL
 * with `replaceState`.
 * @param {string} pathname
 * @param {string} search
 * @returns {AudioRoute}
 */
export function parseAudioUrl(pathname, search) {
  const params = new URLSearchParams(search);
  if (pathname === '/audiobooks') {
    const id = parseId(params.get('book'));
    return id === null ? { section: 'audiobooks', view: 'grid', id: null } : { section: 'audiobooks', view: 'book', id };
  }
  const id = parseId(params.get('album'));
  return id === null ? { section: 'music', view: 'overview', id: null } : { section: 'music', view: 'album', id };
}

/**
 * Builds the canonical URL (path + query) for a route.
 * @param {AudioRoute} route
 * @returns {string}
 */
export function audioUrl({ section, view, id }) {
  if (section === 'music' && view === 'album' && id !== null) return `/music?album=${id}`;
  if (section === 'audiobooks' && view === 'book' && id !== null) return `/audiobooks?book=${id}`;
  return `/${section}`;
}

/**
 * True when following a link from `current` to `next` only changes the
 * fragment (same path + query, non-empty hash) — e.g. Phase 1's
 * "Zum Inhalt springen" skip link to `#main`. Such a link must keep the
 * browser's native in-page jump instead of being turned into a route render.
 * @param {{ pathname: string, search: string, hash: string }} next
 * @param {{ pathname: string, search: string }} current
 * @returns {boolean}
 */
export function isFragmentOnlyChange(next, current) {
  return next.hash !== '' && next.pathname === current.pathname && next.search === current.search;
}

/**
 * Whether a `popstate` at `location` needs a re-render: `false` when its
 * canonical route URL equals the one last rendered, which is the case for a
 * fragment-only history step (browsers fire `popstate` for those too).
 * @param {{ pathname: string, search: string }} location
 * @param {string | null} renderedUrl canonical URL of the last rendered route
 * @returns {boolean}
 */
export function needsRender(location, renderedUrl) {
  return audioUrl(parseAudioUrl(location.pathname, location.search)) !== renderedUrl;
}
