/**
 * Safe DOM construction helpers. No function here ever assigns `innerHTML`;
 * every element is built with `document.createElement`/`setAttribute`/`append`.
 */

/**
 * @typedef {Record<string, string>} Dataset
 */

/**
 * @typedef {Record<string, unknown>} ElAttrs
 * Recognized keys: `class` (string or string[]), `dataset` (Dataset),
 * `on<Event>` (function -> addEventListener), any other key is set as a plain
 * attribute; `null`/`false`/`undefined` values are omitted, `true` sets the
 * attribute with an empty value (boolean attribute), everything else is
 * stringified.
 */

/**
 * @typedef {Node | string | null | undefined | false} ElChild
 */

/**
 * Creates an HTML element, applies attributes and appends children.
 * Never uses `innerHTML`.
 * @param {string} tag
 * @param {ElAttrs} [attrs]
 * @param {...ElChild} children
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  applyAttrs(element, attrs);
  appendChildren(element, children);
  return element;
}

/**
 * @param {HTMLElement} element
 * @param {ElAttrs} attrs
 * @returns {void}
 */
function applyAttrs(element, attrs) {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') {
      applyClass(element, value);
    } else if (key === 'dataset') {
      applyDataset(element, /** @type {Dataset} */ (value));
    } else if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.slice(2).toLowerCase(), /** @type {EventListener} */ (value));
    } else if (key.startsWith('on')) {
      // Never emit inline event-handler attributes for non-function `on*` values.
      continue;
    } else {
      applyAttr(element, key, value);
    }
  }
}

/**
 * @param {HTMLElement} element
 * @param {unknown} value
 * @returns {void}
 */
function applyClass(element, value) {
  const className = Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value);
  element.setAttribute('class', className);
}

/**
 * @param {HTMLElement} element
 * @param {Dataset} dataset
 * @returns {void}
 */
function applyDataset(element, dataset) {
  for (const [key, value] of Object.entries(dataset)) {
    element.dataset[key] = value;
  }
}

/**
 * @param {HTMLElement} element
 * @param {string} key
 * @param {unknown} value
 * @returns {void}
 */
function applyAttr(element, key, value) {
  if (value === null || value === undefined || value === false) return;
  if (value === true) {
    element.setAttribute(key, '');
    return;
  }
  element.setAttribute(key, String(value));
}

/**
 * @param {HTMLElement} element
 * @param {ElChild[]} children
 * @returns {void}
 */
function appendChildren(element, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
}

/**
 * Builds an empty-state block: a title and a line of explanatory text.
 * @param {{ title: string, text: string }} params
 * @returns {HTMLElement}
 */
export function createEmptyState({ title, text }) {
  return el(
    'div',
    { class: 'empty-state' },
    el('p', { class: 'empty-state-title' }, title),
    el('p', { class: 'empty-state-text' }, text),
  );
}
