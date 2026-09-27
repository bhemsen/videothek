/**
 * Video player page (`/player?id=<id>`, no shell): validates the id, fetches
 * the item, and renders the not-found/not-playable/playback-error states
 * from docs/specs/spec-video-streaming.md's "Design" state table — or, on
 * the playable path, creates the page's single `<video>` element and starts
 * playback. `loadItem`/`startPlayback` are P4's seam (spec-progress-resume.md).
 */
import { el } from './lib/dom.js';
import { request, ApiError, toLogin } from './lib/api.js';
import { createStage } from './lib/player-stage.js';
import { keyAction } from './lib/player-keys.js';
import { headingFor, overlineFor, nextLabel, subtitleLabels, errorStateFor, backTarget } from './lib/player-format.js';
import { chevronIcon, skipIcon } from './player-icons.js';
import { buildLoadingNode, buildErrorPanel } from './player-panel.js';
import { getProgress, trackPlayback } from './lib/progress.js';
import { showResumeToast } from './lib/resume-toast.js';

/** @typedef {import('./lib/progress.js').ProgressEntry} ProgressEntry */
/** @typedef {import('./player-panel.js').PanelState} PanelState */
/** @typedef {{ id: number, title: string, season: number | null, episode: number | null, episodeEnd: number | null }} NextEpisode */
/** @typedef {{ index: number, lang: string | null, label: string | null }} SubtitleTrack */
/**
 * @typedef {{ id: number, category: string, title: string, ext: string, playable: boolean,
 *   seriesTitle: string | null, season: number | null, episode: number | null, episodeEnd: number | null,
 *   next: NextEpisode | null, subtitles: SubtitleTrack[] }} PlayerItem
 */

/** `id` query param: mirrors the server's `src/api/media.js` pattern exactly. */
const ID_RE = /^[1-9][0-9]{0,15}$/;

/** @type {HTMLVideoElement | null} */
let video = null;
/** @type {ReturnType<typeof createStage> | null} */
let stage = null;
/** @type {HTMLButtonElement | null} */
let nextButtonRef = null;
/** @type {PlayerItem | null} */
let currentItem = null;
let lastTime = 0;

const overlineEl = el('p', { class: 'player-title__overline' });
const headingEl = el('h1', { class: 'player-title__heading' });
const titleBlock = el('div', { class: 'player-title', hidden: true }, overlineEl, headingEl);
const backButton = el(
  'button',
  { type: 'button', class: 'btn btn-secondary player-back', onClick: () => goBack() },
  chevronIcon(),
  'Zurück',
);
const header = el('header', { class: 'player-header' }, backButton, titleBlock);
const videoHost = el('div', { class: 'player-stage', hidden: true });
const panelBox = el('div', { class: 'player-panel-box', 'aria-live': 'polite' }, buildLoadingNode());
const nextSlot = el('div', { class: 'player-next-slot' });
const hint = el(
  'p',
  { class: 'player-hint', hidden: true },
  'Tastatur: Leertaste Wiedergabe/Pause · ←/→ 10 Sekunden · F Vollbild · M Ton aus',
);
document.body.append(el('main', { class: 'player-page' }, header, videoHost, panelBox, nextSlot, hint));

/** Parses `?id=` per {@link ID_RE}, also requiring a safe integer — validated before any request. @param {string} raw @returns {number | null} */
function parseId(raw) {
  if (!ID_RE.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

/** "Zurück"/"Zurück zur Übersicht": `history.back()` for a real same-origin previous page, else the home page. @returns {void} */
function goBack() {
  const target = backTarget({ referrer: document.referrer, origin: location.origin, historyLength: history.length });
  if (target === 'back') history.back();
  else location.assign('/');
}

/** Shows the title block for a loaded item and sets `document.title`. @param {PlayerItem} item @returns {void} */
function renderTitleBlock(item) {
  overlineEl.textContent = overlineFor(item);
  headingEl.textContent = headingFor(item);
  titleBlock.hidden = false;
  document.title = `${headingFor(item)} – Videothek`;
}

/**
 * Builds/clears the below-stage "Nächste Folge" button, shown only while the
 * video is attached (hidden in every panel state, where `next` instead
 * appears as a panel action).
 * @param {NextEpisode | null} next @returns {void}
 */
function renderNextButton(next) {
  nextSlot.replaceChildren();
  nextButtonRef = null;
  if (next === null) return;
  nextButtonRef = /** @type {HTMLButtonElement} */ (
    el(
      'button',
      { type: 'button', class: 'btn btn-secondary player-next', onClick: () => goToNext(next) },
      skipIcon(),
      nextLabel(next),
    )
  );
  nextSlot.append(nextButtonRef);
}

/** "Nächste Folge": `location.replace` keeps the browse page the history predecessor. @param {NextEpisode | null} next @returns {void} */
function goToNext(next) {
  if (next === null) return;
  location.replace(`/player?id=${next.id}`);
}

/**
 * Renders an error/empty-state panel: hides the video stage and the
 * below-stage next button, builds the panel, updates `document.title` for
 * item-less states, and focuses the primary action.
 * @param {PanelState} state
 * @param {{ hasItem: boolean, ext?: string, next?: NextEpisode | null, onRetry?: () => void }} opts
 * @returns {void}
 */
function showPanel(state, { hasItem, ext, next = null, onRetry }) {
  videoHost.hidden = true;
  hint.hidden = true;
  renderNextButton(null);
  const { node, focusTarget, heading } = buildErrorPanel({
    state,
    hasItem,
    ext,
    nextLabel: nextLabel(next),
    onBack: goBack,
    onRetry,
    onNext: () => goToNext(next),
  });
  panelBox.replaceChildren(node);
  panelBox.hidden = false;
  if (!hasItem) document.title = `${heading} – Videothek`;
  focusTarget.focus();
}

/**
 * Builds the page's single `<video>` element (playable path only); tracks
 * `lastTime` for a later retry, but only while metadata is loaded
 * (`readyState >= 1`) — `load()` during a retry fires `timeupdate` at 0
 * before `loadedmetadata`, which must not clobber the saved position.
 * @param {PlayerItem} item @returns {HTMLVideoElement}
 */
function buildVideoElement(item) {
  return /** @type {HTMLVideoElement} */ (
    el('video', {
      controls: true,
      playsinline: true,
      preload: 'metadata',
      'aria-label': headingFor(item),
      onTimeupdate: () => {
        const v = /** @type {HTMLVideoElement} */ (video);
        if (v.readyState >= 1) lastTime = v.currentTime;
      },
      onError: () => handleVideoError(),
      onEnded: () => nextButtonRef?.focus(),
    })
  );
}

/** Appends subtitle tracks and starts playback — the P4 seam, called exactly once per page load. @param {HTMLVideoElement} v @param {PlayerItem} item @returns {void} */
function startPlayback(v, item) {
  const labels = subtitleLabels(item.subtitles);
  item.subtitles.forEach((track, i) => {
    v.append(
      el('track', {
        kind: 'subtitles',
        src: `/media/${item.id}/subtitles/${track.index}`,
        srclang: track.lang ?? 'und',
        label: labels[i],
      }),
    );
  });
  v.src = `/media/${item.id}`;
  Promise.resolve(v.play()).catch(() => {});
}

/** Creates and attaches the page's one `<video>` element, shows the stage/next button, starts playback and arms P4's tracker (never re-run on retry). @param {PlayerItem} item @param {ProgressEntry} entry @returns {void} */
function attachVideo(item, entry) {
  video = buildVideoElement(item);
  stage = createStage(videoHost, video);
  videoHost.append(video);
  videoHost.hidden = false;
  hint.hidden = false;
  panelBox.hidden = true;
  renderNextButton(item.next);
  startPlayback(video, item);
  trackPlayback(video, item.id, { entry, onResume: (p) => showResumeToast({ media: /** @type {HTMLVideoElement} */ (video), position: p }) });
}

/** Re-attaches the same `<video>` near `lastTime` ("Erneut versuchen" for file-missing/codec/connection-lost). @returns {void} */
function retryPlayback() {
  panelBox.hidden = true;
  videoHost.hidden = false;
  hint.hidden = false;
  renderNextButton(currentItem?.next ?? null);
  /** @type {ReturnType<typeof createStage>} */ (stage).retry(lastTime);
}

/**
 * Handles the `<video>` `error` event: code 1 (our own detach) is ignored;
 * otherwise a `HEAD` probe disambiguates file-missing/codec/connection-lost
 * (`toLogin()` on an expired session).
 * @returns {Promise<void>}
 */
async function handleVideoError() {
  const v = /** @type {HTMLVideoElement} */ (video);
  if (v.error === null || v.error.code === 1) return;
  const mediaErrorCode = v.error.code;
  /** @type {ReturnType<typeof createStage>} */ (stage).detach();
  /** @type {number | null} */ let headStatus = null;
  try {
    const response = await fetch(`/media/${/** @type {PlayerItem} */ (currentItem).id}`, { method: 'HEAD', cache: 'no-store' });
    headStatus = response.status;
  } catch {
    headStatus = null;
  }
  if (headStatus === 401) {
    toLogin();
    return;
  }
  const state = errorStateFor({ headStatus, mediaErrorCode });
  showPanel(state, { hasItem: true, next: currentItem?.next ?? null, onRetry: retryPlayback });
}

/**
 * Fetches the item and renders the matching state: not-found, load-failed,
 * not-playable, or the attached video. `getProgress(id)` (P4 seam) starts
 * alongside the item fetch and is awaited only on the playable path.
 * @param {number} id @returns {Promise<void>}
 */
async function loadItem(id) {
  const itemPromise = request('GET', `/api/library/items/${id}`);
  const noEntry = /** @type {ProgressEntry} */ ({ itemId: id, position: 0, duration: null, state: 'none', updatedAt: null });
  const progressPromise = getProgress(id).catch(() => noEntry);
  /** @type {PlayerItem} */ let item;
  try {
    const { data } = await itemPromise;
    item = /** @type {PlayerItem} */ (data);
  } catch (error) {
    const apiError = error instanceof ApiError ? error : null;
    if (apiError?.status === 401) return;
    if (apiError?.status === 404) return showPanel('not-found', { hasItem: false });
    return showPanel('load-failed', { hasItem: false, onRetry: () => location.reload() });
  }
  if (item.category !== 'movies' && item.category !== 'series') {
    return showPanel('not-found', { hasItem: false });
  }
  currentItem = item;
  renderTitleBlock(item);
  if (!item.playable) {
    return showPanel('not-playable', { hasItem: true, ext: item.ext.toUpperCase(), next: item.next });
  }
  attachVideo(item, await progressPromise);
}

/** Applies one keyboard action to the video element. @param {'toggle' | 'back' | 'forward' | 'fullscreen' | 'mute'} action @returns {void} */
function applyKeyAction(action) {
  const v = /** @type {HTMLVideoElement} */ (video);
  if (action === 'toggle') {
    if (v.paused) Promise.resolve(v.play()).catch(() => {});
    else v.pause();
  } else if (action === 'back') {
    v.currentTime = Math.max(0, v.currentTime - 10);
  } else if (action === 'forward') {
    const max = Number.isFinite(v.duration) ? v.duration : Infinity;
    v.currentTime = Math.min(max, v.currentTime + 10);
  } else if (action === 'fullscreen') {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else v.requestFullscreen().catch(() => {});
  } else {
    v.muted = !v.muted;
  }
}

/** The page's single `keydown` listener: acts only while the video element is connected. @param {KeyboardEvent} event @returns {void} */
function onKeyDown(event) {
  if (video === null || !video.isConnected) return;
  const target = /** @type {HTMLElement} */ (event.target);
  const action = keyAction({
    key: event.key,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    tagName: target.tagName,
    isContentEditable: target.isContentEditable,
  });
  if (action === null) return;
  event.preventDefault();
  applyKeyAction(action);
}

document.addEventListener('keydown', onKeyDown);

const id = parseId(new URLSearchParams(location.search).get('id') ?? '');
if (id === null) {
  showPanel('not-found', { hasItem: false });
} else {
  loadItem(id);
}
