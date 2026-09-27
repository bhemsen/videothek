/**
 * `GET /api/gallery?folder=<key>` — one folder of the merged `images` tree
 * (breadcrumb, child folders with covers, direct items) as camelCase JSON.
 * `src/library/gallery.js` shapes the view with neutral `thumb` markers (no
 * URLs, no DB, no I/O); this module resolves the key against the index,
 * fetches each child folder's cover, and maps markers to `/media/…` URLs —
 * the only place in this route that knows about HTTP paths.
 */

import { buildGalleryView, childFolders } from '../library/gallery.js';
import { parseFolderKey } from '../library/image-folders.js';
import {
  findFolderCover,
  folderExists,
  listFolderItems,
  listSubtreeFolderCounts,
} from '../db/image-meta.js';
import { requireUser } from '../http/guards.js';
import { sendError, sendJson } from '../http/respond.js';

/**
 * Builds the `thumbUrl` for a neutral `thumb` marker, following the P2
 * `src/api/library-json.js` precedent of mapping URLs only in `src/api/`.
 * @param {number} id
 * @param {'embedded' | 'original' | null} thumb
 * @param {number} version
 * @returns {string | null}
 */
function thumbUrlFor(id, thumb, version) {
  if (thumb === 'embedded') return `/media/${id}/thumb?v=${version}`;
  if (thumb === 'original') return `/media/${id}`;
  return null;
}

/**
 * Maps a folder's `GalleryCoverView` to the response's `cover` shape.
 * @param {import('../library/gallery.js').GalleryCoverView | null} cover
 * @returns {{ thumbUrl: string | null, thumbOrientation: number } | null}
 */
function mapCover(cover) {
  if (!cover) return null;
  return {
    thumbUrl: thumbUrlFor(cover.id, cover.thumb, cover.version),
    thumbOrientation: cover.thumbOrientation,
  };
}

/**
 * Maps a `GalleryItemView` to the response's item shape.
 * @param {import('../library/gallery.js').GalleryItemView} item
 * @returns {{ id: number, name: string, kind: 'image' | 'video', playable: boolean,
 *   takenAt: string, url: string | null, thumbUrl: string | null, thumbOrientation: number }}
 */
function mapItem(item) {
  return {
    id: item.id,
    name: item.name,
    kind: item.kind,
    playable: item.playable,
    takenAt: item.takenAt,
    url: item.playable ? `/media/${item.id}` : null,
    thumbUrl: thumbUrlFor(item.id, item.thumb, item.version),
    thumbOrientation: item.thumbOrientation,
  };
}

/**
 * Loads and shapes the response body for one folder key that is already
 * confirmed to exist: direct items, child folders with their subtree counts
 * and one cover lookup per child, then URL-mapped.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} key
 * @returns {object}
 */
function loadFolderView(db, key) {
  const items = listFolderItems(db, key);
  const folderCounts = listSubtreeFolderCounts(db, key);
  const folders = childFolders(key, folderCounts).map((folder) => ({
    ...folder,
    coverRow: findFolderCover(db, folder.key),
  }));
  const view = buildGalleryView({ key, items, folders });
  return {
    key: view.key,
    name: view.name,
    breadcrumb: view.breadcrumb,
    folders: view.folders.map((folder) => ({
      key: folder.key,
      name: folder.name,
      count: folder.count,
      cover: mapCover(folder.cover),
    })),
    items: view.items.map(mapItem),
  };
}

/**
 * Registers `GET /api/gallery?folder=<key>` (session required via
 * `requireUser`): one folder of the merged `images` tree as camelCase JSON.
 * `404 {"error":"not_found"}` for a syntactically invalid `folder` value or a
 * key with no matching folder in the index (the root always exists, even in
 * an empty library); `401 {"error":"unauthorized"}` without a session.
 * @param {ReturnType<typeof import('../http/router.js').createRouter>} router
 * @param {{ db: import('node:sqlite').DatabaseSync }} deps
 * @returns {void}
 */
export function registerGalleryRoutes(router, { db }) {
  router.add(
    'GET',
    '/api/gallery',
    requireUser((_req, res, ctx) => {
      const key = parseFolderKey(ctx.url.searchParams.get('folder'));
      if (key === null || !folderExists(db, key)) {
        sendError(res, 404, 'not_found');
        return;
      }
      sendJson(res, 200, loadFolderView(db, key));
    })
  );
}
