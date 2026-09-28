/**
 * Idempotent stylesheet injection: lets a row/section module own its CSS
 * file without `public/index.html` growing a new `<link>` per feature.
 */
import { el } from './dom.js';

/**
 * Appends `<link rel="stylesheet" href>` to `<head>` once (a no-op when a
 * link with that `href` already exists).
 * @param {string} href
 * @returns {void}
 */
export function injectStylesheet(href) {
  if (document.head.querySelector(`link[href="${href}"]`)) return;
  document.head.append(el('link', { rel: 'stylesheet', href }));
}
