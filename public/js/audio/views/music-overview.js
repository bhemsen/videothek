/**
 * Musik overview: the "Weiterhören" resume card (shown only once its album
 * has loaded — resume-album prefetch) and artist sections of album cards.
 * See spec-music-audiobooks.md "Views", "Start positions", "States and copy".
 */
import { el, createEmptyState } from '../../lib/dom.js';
import { pluralize } from '../../lib/library-format.js';
import { formatRemaining } from '../../lib/progress.js';
import { getMusicOverview, getAlbum } from '../audio-api.js';
import { coverImg } from '../cover-img.js';
import { audioIcon } from '../icons.js';
import { buildAlbumQueue, resumeStartIndex, MIDDLE_DOT, UNKNOWN_ARTIST, UNTITLED_ALBUM } from '../music-queue.js';
import { buildLoadErrorState } from './load-error.js';

/** @typedef {import('../app.js').ViewParams} ViewParams */
/** @typedef {import('../audio-api.js').MusicOverview} MusicOverview */
/** @typedef {import('../audio-api.js').MusicResume} MusicResume */
/** @typedef {import('../audio-api.js').ArtistSection} ArtistSection */
/** @typedef {import('../audio-api.js').AlbumSummary} AlbumSummary */
/** @typedef {import('../audio-api.js').AlbumDetail} AlbumDetail */

const TITLE = 'Musik';

/**
 * @param {ViewParams} params
 * @returns {Promise<{ title: string, dispose?: () => void }>}
 */
export async function render({ container, player, navigate }) {
  let disposed = false;
  const heading = el('h1', { class: 'shell-title' }, TITLE);
  const body = el('div');
  container.append(heading, body);

  /** @returns {Promise<void>} */
  async function load() {
    let overview;
    try {
      overview = await getMusicOverview();
    } catch {
      if (!disposed) body.replaceChildren(buildLoadErrorState(load));
      return;
    }
    if (disposed) return;
    renderOverview(overview);
  }

  /** @param {MusicOverview} overview @returns {void} */
  function renderOverview(overview) {
    if (overview.artists.length === 0) {
      body.replaceChildren(buildEmptyState());
      return;
    }
    const resumeSlot = el('div', { class: 'music-resume-slot' });
    body.replaceChildren(resumeSlot, ...overview.artists.map(buildArtistSection));
    if (overview.resume !== null) loadResumeCard(overview.resume, resumeSlot);
  }

  /** @param {MusicResume} resume @param {HTMLElement} slot @returns {Promise<void>} */
  async function loadResumeCard(resume, slot) {
    let album;
    try {
      album = await getAlbum(resume.albumId);
    } catch {
      return;
    }
    if (disposed) return;
    slot.replaceChildren(buildResumeCard(resume, album, player, navigate));
  }

  await load();
  return { title: TITLE, dispose: () => { disposed = true; } };
}

/** @returns {HTMLElement} */
function buildEmptyState() {
  return createEmptyState({
    title: 'Keine Musik gefunden.',
    text: 'Lege Musik im Ordner „Musik“ ab, z. B. „Musik/Interpret/Album/01 Titel.mp3“.',
  });
}

/**
 * @param {ArtistSection} section
 * @returns {HTMLElement}
 */
function buildArtistSection(section) {
  const name = section.name ?? UNKNOWN_ARTIST;
  const heading = el(
    'div',
    { class: 'music-artist-section__heading' },
    el('h2', {}, name),
    el('span', { class: 'music-artist-section__count' }, pluralize(section.albums.length, 'Album', 'Alben')),
  );
  const grid = el('div', { class: 'music-album-grid' }, ...section.albums.map(buildAlbumCard));
  return el('section', { class: 'music-artist-section' }, heading, grid);
}

/**
 * @param {AlbumSummary} album
 * @returns {HTMLElement}
 */
function buildAlbumCard(album) {
  const title = album.title ?? UNTITLED_ALBUM;
  const meta = album.year !== null ? el('p', { class: 'music-album-card__meta' }, String(album.year)) : null;
  return el(
    'a',
    { class: 'music-album-card', href: `/music?album=${album.id}` },
    coverImg({ coverId: album.coverId, kind: 'album', alt: '', lazy: true }),
    el('p', { class: 'music-album-card__title' }, title),
    meta,
  );
}

/**
 * Builds the "Weiterhören" card: one `<button>` playing the album queue from
 * the resumed track at its saved position and navigating to the album. The
 * "Fortsetzen" pill inside is a non-interactive `<span>` styled like a
 * button — no nested interactive element.
 * @param {MusicResume} resume @param {AlbumDetail} album
 * @param {ViewParams['player']} player @param {ViewParams['navigate']} navigate
 * @returns {HTMLElement}
 */
function buildResumeCard(resume, album, player, navigate) {
  const artist = resume.artist ?? UNKNOWN_ARTIST;
  const albumTitle = resume.albumTitle ?? UNTITLED_ALBUM;
  const duration = resume.duration;
  const fraction = duration !== null && duration > 0 ? Math.min(1, Math.max(0, resume.position / duration)) : 0;
  const bar = el('span', { class: 'music-resume-card__bar' });
  bar.style.setProperty('--progress', String(fraction));
  const meta =
    duration !== null
      ? el('span', { class: 'music-resume-card__meta' }, formatRemaining(Math.max(0, duration - resume.position)))
      : null;
  const button = el(
    'button',
    { type: 'button', class: 'music-resume-card' },
    el('span', { class: 'music-resume-card__cover' }, coverImg({ coverId: resume.coverId, kind: 'album', alt: '', tag: 'span' })),
    el(
      'span',
      { class: 'music-resume-card__body' },
      el('span', { class: 'audio-overline' }, 'Weiterhören'),
      el('span', { class: 'music-resume-card__title' }, resume.title),
      el('span', { class: 'music-resume-card__subtitle' }, `${artist} ${MIDDLE_DOT} ${albumTitle}`),
      el('span', { class: 'music-resume-card__bar-track', 'aria-hidden': 'true' }, bar),
      meta,
    ),
    el('span', { class: 'btn btn-primary music-resume-card__pill' }, audioIcon('play'), 'Fortsetzen'),
  );
  button.addEventListener('click', () => {
    const startIndex = resumeStartIndex(album, resume.trackId);
    player.playQueue(buildAlbumQueue(album, resume), { startIndex, mode: 'music', groupId: album.id });
    navigate({ section: 'music', view: 'album', id: album.id });
  });
  return button;
}
