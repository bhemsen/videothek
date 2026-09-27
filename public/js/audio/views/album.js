/**
 * Album detail: cover header + "Alle abspielen", and the track list ("CD n"
 * sub-headings, playing-row highlight, non-playable rows). See
 * spec-music-audiobooks.md "Views", "Rows", "Start positions".
 */
import { el, createEmptyState } from '../../lib/dom.js';
import { createUnplayableBadge } from '../../lib/media-card.js';
import { pluralize } from '../../lib/library-format.js';
import { ApiError } from '../../lib/api.js';
import { getAlbum } from '../audio-api.js';
import { coverImg } from '../cover-img.js';
import { audioIcon } from '../icons.js';
import { formatDuration, formatTotal } from '../format.js';

/** @typedef {import('../app.js').ViewParams} ViewParams */
/** @typedef {import('../audio-api.js').AlbumDetail} AlbumDetail */
/** @typedef {import('../audio-api.js').AlbumTrack} AlbumTrack */
/** @typedef {NonNullable<ReturnType<ViewParams['player']['state']>>} PlayerState */

const MIDDLE_DOT = '·';
const EN_DASH = '–';
const UNKNOWN_ARTIST = 'Unbekannter Interpret';
const UNTITLED_ALBUM = 'Einzeltitel';
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * @param {ViewParams} params
 * @returns {Promise<{ title: string, dispose?: () => void }>}
 */
export async function render({ container, id, player }) {
  let disposed = false;
  let unsubscribe = /** @type {(() => void) | null} */ (null);
  let resultTitle = 'Album';
  const backLink = el('a', { class: 'back-link', href: '/music' }, '‹ Musik');
  const body = el('div');
  container.append(backLink, body);

  /** @returns {Promise<void>} */
  async function load() {
    if (id === null) {
      body.replaceChildren(buildMissingState());
      return;
    }
    let album;
    try {
      album = await getAlbum(id);
    } catch (err) {
      if (disposed) return;
      const missing = err instanceof ApiError && err.status === 404;
      body.replaceChildren(missing ? buildMissingState() : buildErrorState(load));
      return;
    }
    if (disposed) return;
    resultTitle = album.title ?? UNTITLED_ALBUM;
    document.title = `${resultTitle} ${MIDDLE_DOT} Videothek`;
    mountAlbum(album);
  }

  /** @param {AlbumDetail} album @returns {void} */
  function mountAlbum(album) {
    const { header, playButton } = buildHeader(album);
    playButton.addEventListener('click', () => playFrom(album, player, 0));
    const { list, applyHighlight } = buildTrackList(album, player);
    body.replaceChildren(header, list);
    applyHighlight(player.state());
    unsubscribe = player.onChange(() => applyHighlight(player.state()));
  }

  await load();
  return { title: resultTitle, dispose: () => { disposed = true; unsubscribe?.(); } };
}

/** @returns {HTMLElement} */
function buildMissingState() {
  const state = createEmptyState({ title: 'Album nicht gefunden.', text: '' });
  state.append(el('a', { href: '/music' }, 'Zu Musik'));
  return state;
}

/**
 * @param {() => Promise<void>} onRetry
 * @returns {HTMLElement}
 */
function buildErrorState(onRetry) {
  const state = createEmptyState({ title: 'Die Bibliothek konnte nicht geladen werden.', text: '' });
  state.append(el('button', { type: 'button', class: 'btn btn-secondary', onClick: onRetry }, 'Erneut versuchen'));
  return state;
}

/**
 * @param {AlbumDetail} album
 * @returns {{ header: HTMLElement, playButton: HTMLButtonElement }}
 */
function buildHeader(album) {
  const title = album.title ?? UNTITLED_ALBUM;
  const artist = album.artist ?? UNKNOWN_ARTIST;
  const metaParts = [];
  if (album.year !== null) metaParts.push(String(album.year));
  metaParts.push(pluralize(album.tracks.length, 'Titel', 'Titel'));
  metaParts.push(formatTotal(album.duration));
  const playButton = /** @type {HTMLButtonElement} */ (
    el('button', { type: 'button', class: 'btn btn-primary album-detail-header__play' }, audioIcon('play'), 'Alle abspielen')
  );
  const header = el(
    'div',
    { class: 'album-detail-header' },
    el('div', { class: 'album-detail-header__cover' }, coverImg({ coverId: album.coverId, kind: 'album', alt: '' })),
    el(
      'div',
      { class: 'album-detail-header__info' },
      el('p', { class: 'audio-overline' }, 'Album'),
      el('h1', { class: 'shell-title album-detail-header__title' }, title),
      el('p', { class: 'album-detail-header__artist' }, artist),
      el('p', { class: 'album-detail-header__meta' }, metaParts.join(` ${MIDDLE_DOT} `)),
      playButton,
    ),
  );
  return { header, playButton };
}

/**
 * @param {AlbumDetail} album @param {ViewParams['player']} player @param {number} startIndex
 * @returns {void}
 */
function playFrom(album, player, startIndex) {
  const items = album.tracks.map((track) => ({
    id: track.id,
    title: track.title,
    subtitle: track.artist ?? UNKNOWN_ARTIST,
    groupTitle: null,
    coverId: album.coverId,
    duration: track.duration,
    playable: track.playable,
    start: 0,
  }));
  player.playQueue(items, { startIndex, mode: 'music', groupId: album.id });
}

/**
 * Builds the track list ("CD n" headings only when `discCount > 1`) and an
 * `applyHighlight` updater keyed by the player's current item.
 * @param {AlbumDetail} album @param {ViewParams['player']} player
 * @returns {{ list: HTMLElement, applyHighlight: (state: PlayerState | null) => void }}
 */
function buildTrackList(album, player) {
  /** @type {HTMLElement[]} */
  const rows = [];
  /** @type {Map<number, { numberSpan: HTMLElement, row: HTMLElement, trackNo: string }>} */
  const byId = new Map();
  let lastDisc = /** @type {number | null} */ (null);
  album.tracks.forEach((track, index) => {
    if (album.discCount > 1 && track.discNo !== lastDisc) {
      rows.push(el('p', { class: 'track-list__disc-heading' }, `CD ${track.discNo}`));
      lastDisc = track.discNo;
    }
    const built = buildTrackRow(track, index, album, player);
    rows.push(built.row);
    byId.set(track.id, built);
  });
  const applyHighlight = (/** @type {PlayerState | null} */ state) => {
    const activeId = state !== null && state.mode === 'music' && state.groupId === album.id ? state.item.id : null;
    for (const [trackId, entry] of byId) setRowActive(entry, trackId === activeId);
  };
  return { list: el('div', { class: 'track-list' }, ...rows), applyHighlight };
}

/**
 * @param {{ numberSpan: HTMLElement, row: HTMLElement, trackNo: string }} entry @param {boolean} active
 * @returns {void}
 */
function setRowActive(entry, active) {
  entry.numberSpan.replaceChildren(active ? equalizerIcon() : entry.trackNo);
  if (entry.row instanceof HTMLButtonElement) {
    if (active) entry.row.setAttribute('aria-current', 'true');
    else entry.row.removeAttribute('aria-current');
  }
}

/**
 * @param {AlbumTrack} track @param {number} index @param {AlbumDetail} album @param {ViewParams['player']} player
 * @returns {{ row: HTMLElement, numberSpan: HTMLElement, trackNo: string }}
 */
function buildTrackRow(track, index, album, player) {
  const trackNo = track.trackNo !== null ? String(track.trackNo) : EN_DASH;
  const numberSpan = el('span', { class: 'track-row__number' }, trackNo);
  const titleSpan = el('span', { class: 'track-row__title' }, track.title);
  const durationSpan = el('span', { class: 'track-row__duration' }, formatDuration(track.duration));
  if (!track.playable) {
    const row = el(
      'div',
      { class: 'track-row track-row--unplayable', title: 'Dieses Dateiformat kann der Browser nicht direkt abspielen.' },
      numberSpan,
      titleSpan,
      createUnplayableBadge(),
      durationSpan,
    );
    return { row, numberSpan, trackNo };
  }
  const row = el('button', { type: 'button', class: 'track-row' }, numberSpan, titleSpan, durationSpan);
  row.addEventListener('click', () => playFrom(album, player, index));
  return { row, numberSpan, trackNo };
}

/**
 * The playing-row glyph: three bars of differing height, bottom-aligned.
 * @returns {SVGSVGElement}
 */
function equalizerIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const [x, y, height] of [[4, 10, 10], [10, 4, 16], [16, 8, 12]]) {
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', '4');
    rect.setAttribute('height', String(height));
    rect.setAttribute('fill', 'currentColor');
    svg.append(rect);
  }
  return svg;
}
