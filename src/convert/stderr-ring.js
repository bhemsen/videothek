// @ts-check

const CONTINUATION_BYTE_MIN = 0x80;
const CONTINUATION_BYTE_MAX = 0xbf;

/**
 * A fixed-size trailing window over the bytes seen so far, for
 * `stderrTail`: memory stays bounded to `maxBytes` however much the
 * converter prints (spec-conversion-core.md, "Runner"). Once the window has
 * wrapped, leading continuation bytes are dropped, then the decoded text's
 * partial first line - which may hold a cut root spelling `redactDetail`
 * would otherwise miss - is dropped too.
 * @param {number} maxBytes
 * @returns {{ push: (chunk: Buffer) => void, finish: () => string }}
 */
export function createStderrRing(maxBytes) {
  /** @type {Buffer[]} */
  const chunks = [];
  let total = 0;
  let wrapped = false;

  /** @param {Buffer} chunk */
  function push(chunk) {
    chunks.push(chunk);
    total += chunk.length;
    while (total > maxBytes) {
      const first = chunks[0];
      const excess = total - maxBytes;
      if (first.length <= excess) {
        chunks.shift();
        total -= first.length;
      } else {
        chunks[0] = first.subarray(excess);
        total -= excess;
      }
      wrapped = true;
    }
  }

  /** @returns {string} the decoded, trimmed tail */
  function finish() {
    const bytes = Buffer.concat(chunks, total);
    let start = 0;
    while (start < bytes.length && bytes[start] >= CONTINUATION_BYTE_MIN && bytes[start] <= CONTINUATION_BYTE_MAX) start++;
    let text = bytes.subarray(start).toString('utf8');
    if (wrapped) {
      const newlineAt = text.indexOf('\n');
      text = newlineAt === -1 ? '' : text.slice(newlineAt + 1);
    }
    return text;
  }

  return { push, finish };
}
