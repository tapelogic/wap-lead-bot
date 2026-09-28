/**
 * Dependency-free test runner (no jest/mocha needed for a project this
 * size -- see preferences: don't add a dependency without real value).
 * Run: node test/run.js
 */
const assert = require('assert');
const { normalizeWebhookBody } = require('../lib/normalize');
const { markAndCheck } = require('../lib/dedupe');
const { extractJsonObject, parseAiResponse } = require('../lib/ai-agent');
const { newSession, pushHistory, decide } = require('../lib/router');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  - ${name}`);
    console.log('        ' + e.message);
  }
}

// ---------------------------------------------------------------------
console.log('normalize.js');

test('parses a plain text message', () => {
  const body = {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'waba1',
      changes: [{
        field: 'messages',
        value: {
          metadata: { phone_number_id: '111' },
          contacts: [{ profile: { name: 'Ali' }, wa_id: '98912345678' }],
          messages: [{ from: '98912345678', id: 'wamid.1', timestamp: '1700000000', type: 'text', text: { body: '  سلام  ' } }],
        },
      }],
    }],
  };
  const events = normalizeWebhookBody(body);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].kind, 'message');
  assert.strictEqual(events[0].text, 'سلام'); // trimmed
  assert.strictEqual(events[0].isTextLike, true);
  assert.strictEqual(events[0].contactName, 'Ali');
});

test('does not treat a delivery-status webhook as a message', () => {
  const body = {
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba1', changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: '111' },
      statuses: [{ id: 'wamid.1', status: 'delivered', recipient_id: '98912345678', timestamp: '1700000001' }],
    } }] }],
  };
  const events = normalizeWebhookBody(body);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].kind, 'status');
});

test('flags a non-text (image) message without a text body, does not throw', () => {
  const body = {
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba1', changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: '111' },
      messages: [{ from: '98912345678', id: 'wamid.2', timestamp: '1700000002', type: 'image', image: { id: 'media1' } }],
    } }] }],
  };
  const events = normalizeWebhookBody(body);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].isTextLike, false);
  assert.strictEqual(events[0].text, null);
});

test('handles an interactive button reply', () => {
  const body = {
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba1', changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: '111' },
      messages: [{ from: '98912345678', id: 'wamid.3', timestamp: '1700000003', type: 'interactive',
        interactive: { type: 'button_reply', button_reply: { id: 'opt1', title: 'قیمت‌ها' } } }],
    } }] }],
  };
  const events = normalizeWebhookBody(body);
  assert.strictEqual(events[0].text, 'قیمت‌ها');
  assert.strictEqual(events[0].isTextLike, true);
});

test('handles a batch of two messages in one webhook call', () => {
  const body = {
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba1', changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: '111' },
      messages: [
        { from: '98910000001', id: 'wamid.a', timestamp: '1700000010', type: 'text', text: { body: 'اول' } },
        { from: '98910000002', id: 'wamid.b', timestamp: '1700000011', type: 'text', text: { body: 'دوم' } },
      ],
    } }] }],
  };
  const events = normalizeWebhookBody(body);
  assert.strictEqual(events.length, 2);
});

test('does not throw on a malformed/empty body (Meta dashboard test ping)', () => {
  assert.deepStrictEqual(normalizeWebhookBody({}), []);
  assert.deepStrictEqual(normalizeWebhookBody(null), []);
  assert.deepStrictEqual(normalizeWebhookBody({ object: 'whatsapp_business_account' }), []);
  assert.deepStrictEqual(normalizeWebhookBody({ object: 'page' }), []); // wrong object type (e.g. Messenger)
});

test('skips a message missing required fields instead of crashing', () => {
  const body = {
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba1', changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: '111' },
      messages: [{ type: 'text', text: { body: 'no id or from' } }],
    } }] }],
  };
  assert.deepStrictEqual(normalizeWebhookBody(body), []);
});

// ---------------------------------------------------------------------
console.log('dedupe.js');

test('first delivery of a message id is accepted', () => {
  const seen = {};
  assert.strictEqual(markAndCheck(seen, 'wamid.1', 1000), true);
});

test('redelivery of the same message id (Meta retry) is rejected', () => {
  const seen = {};
  markAndCheck(seen, 'wamid.1', 1000);
  assert.strictEqual(markAndCheck(seen, 'wamid.1', 1500), false);
});

test('entries older than TTL are cleaned up and do not leak memory forever', () => {
  const seen = {};
  const ttl = 1000;
  markAndCheck(seen, 'wamid.old', 0, ttl);
  markAndCheck(seen, 'wamid.new', 5000, ttl); // triggers cleanup pass
  assert.strictEqual(Object.prototype.hasOwnProperty.call(seen, 'wamid.old'), false);
});

test('missing message id lets the event through (no id to dedup on)', () => {
  const seen = {};
  assert.strictEqual(markAndCheck(seen, null, 1000), true);
});

// ---------------------------------------------------------------------
console.log('ai-agent.js');

test('parses clean JSON response', () => {
  const raw = JSON.stringify({ reply: 'سلام، بفرمایید', confidence: 0.9, handoff: false, lead: { name: 'Ali', intent: 'pricing' } });
  const r = parseAiResponse(raw);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reply, 'سلام، بفرمایید');
  assert.strictEqual(r.handoff, false);
});

test('extracts JSON wrapped in a ```json code fence', () => {
  const raw = '```json\n{"reply":"ok","confidence":0.8,"handoff":false,"lead":{"name":null,"intent":null}}\n```';
  const obj = extractJsonObject(raw);
  assert.strictEqual(obj.reply, 'ok');
});

test('extracts JSON with leading/trailing prose from the model', () => {
  const raw = 'Sure, here is the JSON:\n{"reply":"ok","confidence":0.8,"handoff":false,"lead":{}}\nHope that helps!';
  const obj = extractJsonObject(raw);
  assert.strictEqual(obj.reply, 'ok');
});

test('unparseable garbage forces handoff instead of crashing or replying empty', () => {
  const r = parseAiResponse('the model just rambled with no JSON at all');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.parseError, true);
  assert.strictEqual(r.handoff, true);
  assert.strictEqual(r.reply, null);
});

test('truncated JSON (hit token limit mid-object) forces handoff, not a crash', () => {
  const raw = '{"reply": "این یک پاسخ نسبتا طولانی است که به دلی';
  const r = parseAiResponse(raw);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.handoff, true);
});

test('low confidence forces handoff even if model said handoff:false', () => {
  const raw = JSON.stringify({ reply: 'شاید...', confidence: 0.2, handoff: false, lead: {} });
  const r = parseAiResponse(raw, 0.6);
  assert.strictEqual(r.handoff, true);
  assert.strictEqual(r.reply, 'شاید...'); // reply preserved so router can decide whether to still send it
});

test('confidence is clamped into [0,1] even if the model returns garbage numbers', () => {
  const raw = JSON.stringify({ reply: 'ok', confidence: 5, handoff: false, lead: {} });
  const r = parseAiResponse(raw);
  assert.strictEqual(r.confidence, 1);
  const raw2 = JSON.stringify({ reply: 'ok', confidence: -3, handoff: false, lead: {} });
  const r2 = parseAiResponse(raw2);
  assert.strictEqual(r2.confidence, 0);
});

test('missing/empty reply field forces handoff', () => {
  const raw = JSON.stringify({ confidence: 0.9, handoff: false, lead: {} });
  const r = parseAiResponse(raw);
  assert.strictEqual(r.handoff, true);
});

test('non-numeric confidence defaults to 0 (forces handoff) instead of NaN propagating', () => {
  const raw = '{"reply":"ok","confidence":"high","handoff":false,"lead":{}}';
  const r = parseAiResponse(raw);
  assert.strictEqual(r.confidence, 0);
  assert.strictEqual(r.handoff, true);
});

// ---------------------------------------------------------------------
console.log('router.js');

test('normal happy path: text message, confident AI answer -> reply', () => {
  const session = newSession('98912345678');
  const event = { isTextLike: true, text: 'قیمت قالب گرافیتی چنده؟' };
  const ai = { ok: true, reply: 'برای اطلاع دقیق قیمت، محصول موردنظر را بفرمایید.', confidence: 0.85, handoff: false, parseError: false, lead: { name: null, intent: 'pricing' } };
  const d = decide(event, session, ai);
  assert.strictEqual(d.action, 'reply');
  assert.strictEqual(d.replyText, ai.reply);
});

test('session already owned by a human -> bot stays silent even with a confident AI answer', () => {
  const session = newSession('98912345678');
  session.state = 'human';
  const event = { isTextLike: true, text: 'الو؟' };
  const ai = { ok: true, reply: 'سلام', confidence: 0.99, handoff: false, parseError: false, lead: {} };
  const d = decide(event, session, ai);
  assert.strictEqual(d.action, 'ignore');
  assert.strictEqual(d.reason, 'session_owned_by_human');
});

test('single media message -> asks for text, does not hand off yet', () => {
  const session = newSession('98912345678');
  const event = { isTextLike: false, text: null };
  const d = decide(event, session, null);
  assert.strictEqual(d.action, 'reply');
  assert.strictEqual(session.nonTextStreak, 1);
});

test('two media messages in a row -> hands off to human', () => {
  const session = newSession('98912345678');
  decide({ isTextLike: false }, session, null);
  const d = decide({ isTextLike: false }, session, null);
  assert.strictEqual(d.action, 'handoff');
  assert.strictEqual(d.reason, 'repeated_non_text');
});

test('a text message after a media message resets the non-text streak', () => {
  const session = newSession('98912345678');
  decide({ isTextLike: false }, session, null);
  assert.strictEqual(session.nonTextStreak, 1);
  const ai = { ok: true, reply: 'ok', confidence: 0.9, handoff: false, parseError: false, lead: {} };
  decide({ isTextLike: true, text: 'سلام' }, session, ai);
  assert.strictEqual(session.nonTextStreak, 0);
});

test('AI parse error -> handoff with no reply text sent to the customer', () => {
  const session = newSession('98912345678');
  const ai = { ok: false, reply: null, confidence: 0, handoff: true, parseError: true, lead: {} };
  const d = decide({ isTextLike: true, text: 'x' }, session, ai);
  assert.strictEqual(d.action, 'handoff');
  assert.strictEqual(d.reason, 'ai_response_unparseable');
});

test('low-confidence AI reply is still sent to the customer before handing off (polite, not silent)', () => {
  const session = newSession('98912345678');
  const ai = { ok: true, reply: 'اجازه بدید از همکارم بپرسم و بهتون خبر بدم.', confidence: 0.3, handoff: true, parseError: false, lead: {} };
  const d = decide({ isTextLike: true, text: 'یه سوال عجیب' }, session, ai);
  assert.strictEqual(d.action, 'handoff');
  assert.strictEqual(d.replyText, ai.reply);
  assert.strictEqual(d.reason, 'low_confidence');
});

test('history is capped so prompts do not grow unbounded on a long conversation', () => {
  const session = newSession('98912345678');
  for (let i = 0; i < 30; i++) pushHistory(session, 'user', `msg ${i}`, i);
  assert.ok(session.history.length <= 12);
  assert.strictEqual(session.history[session.history.length - 1].text, 'msg 29');
});

// ---------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
