/**
 * normalize.js
 * Turns a raw WhatsApp Cloud API webhook POST body into a flat list of
 * normalized "events" this workflow can act on.
 *
 * WhatsApp webhook shape (Cloud API, Meta):
 * {
 *   object: "whatsapp_business_account",
 *   entry: [{
 *     id: "<WABA id>",
 *     changes: [{
 *       field: "messages",
 *       value: {
 *         messaging_product: "whatsapp",
 *         metadata: { phone_number_id, display_phone_number },
 *         contacts: [{ profile: { name }, wa_id }],
 *         messages: [{ from, id, timestamp, type, text, image, ... }],
 *         statuses: [{ id, status, recipient_id, timestamp }]
 *       }
 *     }]
 *   }]
 * }
 *
 * Known real-world edge cases handled here (not happy-path-only):
 * - `messages` and `statuses` can both be present, or either can be absent.
 * - A single webhook call can carry more than one message (rare but allowed
 *   by the API, e.g. if delivery was delayed and Meta batches).
 * - `statuses` entries (sent/delivered/read/failed) are NOT user messages
 *   and must not be treated as one -- a naive workflow that reacts to any
 *   webhook hit will "reply" to its own delivery receipts.
 * - Meta redelivers the same webhook if your endpoint is slow or returns
 *   non-2xx, so the same message `id` can arrive more than once. Dedup is
 *   the caller's job (see dedupe.js) but this module exposes the id needed
 *   to do it.
 * - Non-text message types (image, audio, document, sticker, location,
 *   interactive button/list reply, unknown/unsupported) must not be run
 *   through a text-only AI prompt -- extract what's usable, flag the rest.
 * - `timestamp` is a unix-seconds value encoded as a STRING.
 * - Malformed/partial payloads (missing entry, empty changes, test pings
 *   from the Meta dashboard) must not throw.
 */

/**
 * @param {any} body - raw JSON body of the webhook POST
 * @returns {Array<object>} normalized events, each one of:
 *   { kind: 'message', id, from, timestamp, phoneNumberId, contactName, messageType, text, raw }
 *   { kind: 'status',  id, status, recipientId, timestamp }
 */
function normalizeWebhookBody(body) {
  const events = [];

  if (!body || typeof body !== 'object') return events;
  if (body.object !== 'whatsapp_business_account') return events;
  if (!Array.isArray(body.entry)) return events;

  for (const entry of body.entry) {
    const changes = Array.isArray(entry && entry.changes) ? entry.changes : [];
    for (const change of changes) {
      if (!change || change.field !== 'messages') continue;
      const value = change.value || {};
      const phoneNumberId =
        value.metadata && value.metadata.phone_number_id
          ? String(value.metadata.phone_number_id)
          : null;

      const contactsByWaId = {};
      if (Array.isArray(value.contacts)) {
        for (const c of value.contacts) {
          if (c && c.wa_id) {
            contactsByWaId[c.wa_id] = (c.profile && c.profile.name) || null;
          }
        }
      }

      if (Array.isArray(value.messages)) {
        for (const msg of value.messages) {
          if (!msg || !msg.id || !msg.from) continue; // malformed entry, skip
          events.push(normalizeSingleMessage(msg, phoneNumberId, contactsByWaId));
        }
      }

      if (Array.isArray(value.statuses)) {
        for (const st of value.statuses) {
          if (!st || !st.id) continue;
          events.push({
            kind: 'status',
            id: String(st.id),
            status: st.status || 'unknown',
            recipientId: st.recipient_id || null,
            timestamp: st.timestamp || null,
          });
        }
      }
    }
  }

  return events;
}

const SUPPORTED_TEXTLIKE_TYPES = new Set(['text', 'button', 'interactive']);

function normalizeSingleMessage(msg, phoneNumberId, contactsByWaId) {
  const base = {
    kind: 'message',
    id: String(msg.id),
    from: String(msg.from),
    timestamp: msg.timestamp || null,
    phoneNumberId,
    contactName: contactsByWaId[msg.from] || null,
    messageType: msg.type || 'unknown',
    text: null,
    raw: msg,
  };

  switch (msg.type) {
    case 'text':
      base.text = (msg.text && typeof msg.text.body === 'string') ? msg.text.body.trim() : '';
      break;
    case 'button':
      // reply to a template button
      base.text = (msg.button && msg.button.text) || '';
      break;
    case 'interactive': {
      const it = msg.interactive || {};
      if (it.type === 'button_reply' && it.button_reply) {
        base.text = it.button_reply.title || it.button_reply.id || '';
      } else if (it.type === 'list_reply' && it.list_reply) {
        base.text = it.list_reply.title || it.list_reply.id || '';
      } else {
        base.text = '';
      }
      break;
    }
    default:
      // image, audio, video, document, sticker, location, contacts, unknown...
      base.text = null;
      break;
  }

  base.isTextLike = SUPPORTED_TEXTLIKE_TYPES.has(msg.type) && !!base.text;
  return base;
}

module.exports = { normalizeWebhookBody, normalizeSingleMessage };
