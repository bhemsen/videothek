/**
 * German display formatting for the audio section. Pure, no DOM access.
 */

import { formatClock } from '../lib/progress.js';

const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;

/**
 * Formats a duration as a clock (reuses Phase 4's `formatClock`), or the
 * unknown placeholder for `null`.
 * @param {number | null} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  return seconds === null ? '–:–' : formatClock(seconds);
}

/**
 * Formats a total duration in rounded minutes/hours, e.g. `48 Min.`,
 * `7 Std. 12 Min.`, `7 Std.` (minutes rounded, minimum `1 Min.`); the unknown
 * placeholder for `null`.
 * @param {number | null} seconds
 * @returns {string}
 */
export function formatTotal(seconds) {
  if (seconds === null) return '–:–';
  const totalMinutes = Math.max(1, Math.round(seconds / SECONDS_PER_MINUTE));
  if (totalMinutes < MINUTES_PER_HOUR) return `${totalMinutes} Min.`;
  const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR);
  const minutes = totalMinutes % MINUTES_PER_HOUR;
  return minutes === 0 ? `${hours} Std.` : `${hours} Std. ${minutes} Min.`;
}

/**
 * Formats a 0–1 fraction as a floored percentage, e.g. `34 %`; the unknown
 * placeholder for `null`.
 * @param {number | null} fraction
 * @returns {string}
 */
export function formatPercent(fraction) {
  if (fraction === null) return '–';
  return `${Math.floor(fraction * 100)} %`;
}
