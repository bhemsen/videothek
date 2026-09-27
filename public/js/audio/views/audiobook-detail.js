/**
 * Book detail: header (cover, title, author, overall progress), the
 * Abspielen/Fortsetzen/Von-vorn-hören actions and the file list with
 * per-file progress and a live "now playing" row. See
 * spec-music-audiobooks.md "Views", "Rows" and "Start positions".
 */
import { el } from '../../lib/dom.js';
import { ApiError } from '../../lib/api.js';
import { formatClock } from '../../lib/progress.js';
import { getAudiobook } from '../audio-api.js';
import { coverImg } from '../cover-img.js';
import { audioIcon } from '../icons.js';
import { formatDuration, formatTotal, formatPercent } from '../format.js';

/** @typedef {import('../app.js').ViewParams} ViewParams */
/** @typedef {import('../audio-api.js').AudiobookDetail} AudiobookDetail */
/** @typedef {import('../audio-api.js').AudiobookFile} AudiobookFile */
/** @typedef {import('../queue.js').QueueItem} QueueItem */
/** @typedef {ReturnType<typeof import('../player.js').createAudioPlayer>} AudioPlayer */
/** @typedef {ReturnType<AudioPlayer['state']>} PlayerState */
/** @typedef {{ row: HTMLElement, numberCell: HTMLElement, numberText: string }} RowRef */

const TITLE = 'Hörbuch';
const UNKNOWN_AUTHOR = 'Unbekannter Autor';
const MIDDLE_DOT = '·';
const CHECK = '✓';

/**
 * @param {ViewParams} params
 * @returns {Promise<{ title: string, dispose?: () => void }>}
 */
export async function render({ container, id, player }) {
  container.append(el('h1', { class: 'shell-title' }, TITLE));
  /** @type {{ dispose: (() => void) | null }} */
  const state = { dispose: null };
  const result = await load(container, /** @type {number} */ (id), player, state);
  return { title: result.title, dispose: () => state.dispose?.() };
}

/**
 * Fetches the book and renders it into `container` (replacing the loading
 * heading); a request failure or a 404 renders its own state instead — a
 * network failure's retry re-runs this same function. `state.dispose` is
 * kept in sync so a retry that later succeeds still gets torn down on the
 * next navigation, even though `render`'s own return value resolved earlier.
 * @param {HTMLElement} container @param {number} id @param {AudioPlayer} player
 * @param {{ dispose: (() => void) | null }} state
 * @returns {Promise<{ title: string }>}
 */
async function load(container, id, player, state) {
  /** @type {AudiobookDetail} */
  let book;
  try {
    book = await getAudiobook(id);
  } catch (err) {
    container.replaceChildren(buildLoadError(err, () => load(container, id, player, state)));
    return { title: TITLE };
  }
  container.replaceChildren();
  const items = buildQueueItems(book);
  const rows = new Map();
  container.append(buildHeader(book, items, player), buildFileList(book, items, player, rows));
  const update = () => applyCurrentRow(rows, player.state(), book.id);
  state.dispose = player.onChange(update);
  update();
  return { title: book.title };
}

/**
 * @param {unknown} err @param {() => void} retry
 * @returns {HTMLElement}
 */
function buildLoadError(err, retry) {
  if (err instanceof ApiError && err.status === 404) {
    return el(
      'div',
      { class: 'book-error' },
      el('p', {}, 'Hörbuch nicht gefunden.'),
      el('a', { class: 'back-link', href: '/audiobooks' }, '‹ Hörbücher'),
    );
  }
  const button = el('button', { type: 'button', class: 'btn btn-secondary' }, 'Erneut versuchen');
  button.addEventListener('click', retry);
  return el('div', { class: 'book-error' }, el('p', {}, 'Die Bibliothek konnte nicht geladen werden.'), button);
}

/** @param {AudiobookDetail} book @param {QueueItem[]} items @param {AudioPlayer} player @returns {HTMLElement} */
function buildHeader(book, items, player) {
  const back = el('a', { class: 'back-link', href: '/audiobooks' }, '‹ Hörbücher');
  const cover = el('div', { class: 'book-detail__cover' }, coverImg({ coverId: book.coverId, kind: 'book' }));
  const info = buildInfo(book, items, player);
  return el('div', { class: 'book-detail' }, back, el('div', { class: 'book-detail__header' }, cover, info));
}

/** @param {AudiobookDetail} book @param {QueueItem[]} items @param {AudioPlayer} player @returns {HTMLElement} */
function buildInfo(book, items, player) {
  const fileMeta = `${pluralizeFiles(book.fileCount)} ${MIDDLE_DOT} ${formatTotal(book.duration)}`;
  const children = [
    el('p', { class: 'book-detail__overline' }, 'Hörbuch'),
    el('h1', { class: 'shell-title' }, book.title),
    el('p', { class: 'book-detail__author' }, book.author ?? UNKNOWN_AUTHOR),
    el('p', { class: 'book-detail__meta' }, fileMeta),
  ];
  if (book.fraction !== null) children.push(buildOverallProgress(book.fraction));
  children.push(buildActions(book, items, player));
  return el('div', { class: 'book-detail__info' }, ...children);
}

/** @param {number} fraction @returns {HTMLElement} */
function buildOverallProgress(fraction) {
  const fill = el('div', { class: 'book-detail__progress-fill' });
  fill.style.setProperty('--progress', String(fraction));
  return el(
    'div',
    { class: 'book-detail__progress' },
    el('p', { class: 'book-detail__progress-text' }, `${formatPercent(fraction)} gehört`),
    el('div', { class: 'book-detail__progress-bar' }, fill),
  );
}

/** @param {AudiobookDetail} book @param {QueueItem[]} items @param {AudioPlayer} player @returns {HTMLElement} */
function buildActions(book, items, player) {
  const actions = [];
  if (book.resume !== null) actions.push(buildPrimaryButton(book, items, player));
  if (book.state === 'in_progress') actions.push(buildRestartButton(book, items, player));
  return el('div', { class: 'book-detail__actions' }, ...actions);
}

/** @param {AudiobookDetail} book @param {QueueItem[]} items @param {AudioPlayer} player @returns {HTMLElement} */
function buildPrimaryButton(book, items, player) {
  const resume = /** @type {NonNullable<AudiobookDetail['resume']>} */ (book.resume);
  const index = book.files.findIndex((file) => file.id === resume.itemId);
  const button = el('button', { type: 'button', class: 'btn btn-primary' }, audioIcon('play'), primaryLabel(book, resume));
  button.addEventListener('click', () => player.playQueue(items, { startIndex: index, mode: 'audiobook', groupId: book.id }));
  return button;
}

/** @param {AudiobookDetail} book @param {NonNullable<AudiobookDetail['resume']>} resume @returns {string} */
function primaryLabel(book, resume) {
  if (book.state === 'new') return 'Abspielen';
  if (book.state === 'finished') return 'Von vorn hören';
  const file = book.files.find((f) => f.id === resume.itemId);
  return `Fortsetzen ${MIDDLE_DOT} ${file?.title ?? ''} – ${formatClock(resume.position)}`;
}

/**
 * Restarts the book from its first file at position 0, overriding that
 * file's own (possibly unfinished) stored position — later files in the
 * queue keep their normal per-file start rule (spec "Start positions").
 * @param {AudiobookDetail} book @param {QueueItem[]} items @param {AudioPlayer} player
 * @returns {HTMLElement}
 */
function buildRestartButton(book, items, player) {
  const button = el('button', { type: 'button', class: 'btn btn-secondary' }, 'Von vorn hören');
  button.addEventListener('click', () => {
    const restartItems = items.map((item, index) => (index === 0 ? { ...item, start: 0 } : item));
    player.playQueue(restartItems, { startIndex: 0, mode: 'audiobook', groupId: book.id });
  });
  return button;
}

/** @param {AudiobookDetail} book @param {QueueItem[]} items @param {AudioPlayer} player @param {Map<number, RowRef>} rows @returns {HTMLElement} */
function buildFileList(book, items, player, rows) {
  const list = el('ul', { class: 'file-list' });
  book.files.forEach((file, index) => list.append(buildFileRow(file, index, book, items, player, rows)));
  return list;
}

/**
 * @param {AudiobookFile} file @param {number} index @param {AudiobookDetail} book @param {QueueItem[]} items
 * @param {AudioPlayer} player @param {Map<number, RowRef>} rows @returns {HTMLElement}
 */
function buildFileRow(file, index, book, items, player, rows) {
  const numberCell = el('span', { class: 'file-row__number' }, String(index + 1));
  const main = el(
    'div',
    { class: 'file-row__main' },
    numberCell,
    el('span', { class: 'file-row__title' }, file.title),
    file.playable ? buildFileStatus(file) : buildUnplayableBadge(),
  );
  if (!file.playable) return el('div', { class: 'file-row file-row--unplayable' }, main);
  const progress = file.progress;
  const bar = progress !== null && !progress.finished ? buildFileBar(file.duration, progress) : null;
  const row = /** @type {HTMLButtonElement} */ (el('button', { type: 'button', class: 'file-row' }, main, bar));
  row.addEventListener('click', () => player.playQueue(items, { startIndex: index, mode: 'audiobook', groupId: book.id }));
  rows.set(file.id, { row, numberCell, numberText: String(index + 1) });
  return row;
}

/** @param {AudiobookFile} file @returns {HTMLElement} */
function buildFileStatus(file) {
  if (file.progress !== null && file.progress.finished) return el('span', { class: 'file-row__status' }, `${CHECK} Gehört`);
  return el('span', { class: 'file-row__status' }, formatDuration(file.duration));
}

/**
 * @param {number | null} duration @param {NonNullable<AudiobookFile['progress']>} progress
 * @returns {HTMLElement}
 */
function buildFileBar(duration, progress) {
  const total = duration ?? progress.duration;
  const fraction = total ? Math.min(1, Math.max(0, progress.position / total)) : 0;
  const fill = el('div', { class: 'file-row__bar-fill' });
  fill.style.setProperty('--progress', String(fraction));
  return el(
    'div',
    { class: 'file-row__bar' },
    fill,
    el('span', { class: 'visually-hidden' }, `Zu ${Math.round(fraction * 100)} % gehört`),
  );
}

/** @returns {HTMLElement} */
function buildUnplayableBadge() {
  return el('span', { class: 'file-row__badge' }, 'Nicht abspielbar');
}

/**
 * Highlights whichever row matches the player's current item (this book's
 * queue only): `aria-current`, `.file-row--current` and an equaliser glyph
 * swapped in for the row number — spec "Rows".
 * @param {Map<number, RowRef>} rows @param {PlayerState} state @param {number} bookId
 * @returns {void}
 */
function applyCurrentRow(rows, state, bookId) {
  const currentId = state !== null && state.mode === 'audiobook' && state.groupId === bookId ? state.item.id : null;
  for (const [fileId, { row, numberCell, numberText }] of rows) {
    const isCurrent = fileId === currentId;
    row.classList.toggle('file-row--current', isCurrent);
    if (isCurrent) {
      row.setAttribute('aria-current', 'true');
      numberCell.replaceChildren(equaliserIcon());
    } else {
      row.removeAttribute('aria-current');
      numberCell.replaceChildren(numberText);
    }
  }
}

/**
 * Small static three-bar equaliser glyph for the currently playing row's
 * number cell (styled by `audio-books.css`); plain `<span>`s rather than an
 * SVG addition to the shared `icons.js`, which the sibling album-view issue
 * edits concurrently.
 * @returns {HTMLElement}
 */
function equaliserIcon() {
  return el('span', { class: 'file-row__equalizer', 'aria-hidden': 'true' }, el('span', {}), el('span', {}), el('span', {}));
}

/**
 * Builds the book's play queue: one item per file, its `start` following the
 * per-file rule (own unfinished progress, else 0); `groupTitle`/`subtitle`
 * carry the book title/author so the bar shows "book · author".
 * @param {AudiobookDetail} book
 * @returns {QueueItem[]}
 */
function buildQueueItems(book) {
  return book.files.map((file) => ({
    id: file.id,
    title: file.title,
    subtitle: book.author,
    groupTitle: book.title,
    coverId: book.coverId,
    duration: file.duration,
    playable: file.playable,
    start: fileStart(file),
  }));
}

/** @param {AudiobookFile} file @returns {number} */
function fileStart(file) {
  return file.progress !== null && !file.progress.finished ? file.progress.position : 0;
}

/** @param {number} count @returns {string} */
function pluralizeFiles(count) {
  return count === 1 ? '1 Datei' : `${count} Dateien`;
}
