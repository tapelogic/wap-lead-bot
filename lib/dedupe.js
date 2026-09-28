/**
 * dedupe.js
 * WhatsApp Cloud API redelivers the same webhook when your endpoint is slow
 * or returns a non-2xx status. Without dedup, a slow AI call means the same
 * inbound message gets answered twice (or a human gets paged twice).
 *
 * In n8n this is backed by the workflow's static data
 * ($getWorkflowStaticData('global')), which n8n persists in its own
 * database per workflow. That's fine for a single-instance MVP; it is NOT
 * safe under horizontal scaling (multiple n8n workers) or huge volume,
 * because it round-trips the whole store on every read/write and has no
 * row-level locking. Documented in README as a known scaling limit.
 *
 * seenIds is a plain object map { [messageId]: timestampMs } so it is
 * JSON-serializable (a requirement for n8n static data).
 */

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h: WhatsApp message ids don't repeat after that in practice

/**
 * @param {Record<string, number>} seenIds - mutated in place
 * @param {string} messageId
 * @param {number} nowMs
 * @param {number} ttlMs
 * @returns {boolean} true if this is a NEW message (caller should process it)
 */
function markAndCheck(seenIds, messageId, nowMs = Date.now(), ttlMs = DEFAULT_TTL_MS) {
  if (!messageId) return true; // nothing to dedup against; let it through

  // opportunistic cleanup so the object doesn't grow forever
  for (const id of Object.keys(seenIds)) {
    if (nowMs - seenIds[id] > ttlMs) delete seenIds[id];
  }

  if (Object.prototype.hasOwnProperty.call(seenIds, messageId)) {
    return false; // already processed -> duplicate delivery
  }
  seenIds[messageId] = nowMs;
  return true;
}

module.exports = { markAndCheck, DEFAULT_TTL_MS };
