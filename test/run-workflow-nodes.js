/**
 * run-workflow-nodes.js
 * Integration test that executes the LITERAL Code-node source and the
 * LITERAL HTTP-node URL/body expressions pulled straight out of
 * n8n/workflow.json -- the exact file you import into n8n -- against a
 * real local HTTP server (mock-server.js). No n8n engine is involved
 * (network to install n8n is blocked in this sandbox; see README), so
 * this does NOT prove n8n's own node execution has no bugs. What it DOES
 * prove: the JS this workflow ships, and the request shape it sends for
 * each HTTP node, produce the right decision and the right outbound calls
 * for every scenario below, via real network round-trips on loopback.
 *
 * Run: node test/run-workflow-nodes.js
 */
const vm = require('vm');
const assert = require('assert');
const path = require('path');
const { startMockServer } = require('./mock-server');

const workflow = require(path.join('..', 'n8n', 'workflow.json'));
const nodesByName = Object.fromEntries(workflow.nodes.map((n) => [n.name, n]));

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  - ${name}`);
    console.log('        ' + (e.stack || e.message));
  }
}

// --- shim helpers ---------------------------------------------------

let staticStore; // reset per test via resetState()
function resetState() {
  staticStore = {};
}

function runCodeAllItems(nodeName, inputItems, env) {
  const node = nodesByName[nodeName];
  assert.strictEqual(node.parameters.mode, 'runOnceForAllItems', `${nodeName} expected runOnceForAllItems`);
  const context = vm.createContext({
    $getWorkflowStaticData: () => staticStore,
    $env: env,
    $input: {
      first: () => inputItems[0],
      all: () => inputItems,
    },
    console,
  });
  const wrapped = `(function(){\n${node.parameters.jsCode}\n})()`;
  return vm.runInContext(wrapped, context);
}

function runCodeEachItem(nodeName, itemJson, priorNodeName, priorNodeItemJson, env) {
  const node = nodesByName[nodeName];
  assert.strictEqual(node.parameters.mode, 'runOnceForEachItem', `${nodeName} expected runOnceForEachItem`);
  const context = vm.createContext({
    $getWorkflowStaticData: () => staticStore,
    $env: env,
    $json: itemJson,
    $: (name) => {
      if (name !== priorNodeName) throw new Error(`unexpected node reference: ${name}`);
      return { item: { json: priorNodeItemJson } };
    },
    console,
  });
  const wrapped = `(function(){\n${node.parameters.jsCode}\n})()`;
  return vm.runInContext(wrapped, context);
}

function evalJs(inner, ctx) {
  const fn = new vm.Script(`(function($json, $env){ return (${inner}); })`);
  const context = vm.createContext({});
  return fn.runInContext(context)(ctx.$json, ctx.$env);
}

// n8n expression values come in two shapes:
//  - a whole-value expression, e.g. "={{$env.FOO}}" -> evaluate, keep native type
//  - a mixed template, e.g. "=Bearer {{$env.FOO}}" -> string-substitute each {{...}}
function evalExpr(raw, ctx) {
  if (typeof raw !== 'string' || !raw.startsWith('=')) return raw;
  const body = raw.slice(1);
  const trimmed = body.trim();
  const fullMatch = trimmed.match(/^\{\{([\s\S]*)\}\}$/);
  if (fullMatch) return evalJs(fullMatch[1], ctx);
  return body.replace(/\{\{([\s\S]*?)\}\}/g, (_, inner) => String(evalJs(inner, ctx)));
}

async function runHttp(nodeName, itemJson, env, records) {
  const node = nodesByName[nodeName];
  const p = node.parameters;
  const ctx = { $json: itemJson, $env: env };
  const url = evalExpr(p.url, ctx);
  const headers = { 'Content-Type': 'application/json' };
  if (p.headerParameters && p.headerParameters.parameters) {
    for (const h of p.headerParameters.parameters) headers[h.name] = evalExpr(h.value, ctx);
  }
  const body = p.sendBody ? evalExpr(p.jsonBody, ctx) : undefined;
  const res = await fetch(url, {
    method: p.method || 'POST',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return json;
}

// --- one full pipeline run, scenario-parameterized -------------------

async function processWebhookBody(waBody, env) {
  const inputItems = [{ json: { body: waBody } }];
  const routedItems = runCodeAllItems('Normalize, Dedupe, Route', inputItems, env);

  const outcomes = [];
  for (const item of routedItems) {
    let decisionItem;
    if (item.json.needsAI) {
      const aiResponse = await runHttp('Call AI', item.json, env);
      decisionItem = runCodeEachItem('Parse AI, Decide, Persist', aiResponse, 'Normalize, Dedupe, Route', item.json, env);
    } else {
      decisionItem = item;
    }

    const d = decisionItem.json.decision;
    const result = { waId: decisionItem.json.waId, decision: d, sentReply: false, sentInterim: false, notified: false, logged: false };

    if (d.action === 'reply') {
      await runHttp('Send WhatsApp Reply', decisionItem.json, env);
      result.sentReply = true;
    } else if (d.action === 'handoff') {
      if (d.replyText) {
        await runHttp('Send WhatsApp Interim Reply', decisionItem.json, env);
        result.sentInterim = true;
      }
      await runHttp('Notify Human (Handoff)', decisionItem.json, env);
      result.notified = true;
    }
    await runHttp('Log to CRM', decisionItem.json, env);
    result.logged = true;

    outcomes.push(result);
  }
  return outcomes;
}

function waTextMessage({ id, from, text, tsBase = 1700000000 }) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba1', changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: '999888' },
      contacts: [{ profile: { name: 'Test User' }, wa_id: from }],
      messages: [{ from, id, timestamp: String(tsBase), type: 'text', text: { body: text } }],
    } }] }],
  };
}

function waImageMessage({ id, from, tsBase = 1700000000 }) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba1', changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: '999888' },
      messages: [{ from, id, timestamp: String(tsBase), type: 'image', image: { id: 'media1' } }],
    } }] }],
  };
}

function waStatus({ id, recipient }) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba1', changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: '999888' },
      statuses: [{ id, status: 'delivered', recipient_id: recipient, timestamp: '1700000005' }],
    } }] }],
  };
}

// --- run all scenarios -------------------------------------------------

(async function main() {
  const { port, records, close } = await startMockServer();
  const env = {
    AI_API_URL: `http://127.0.0.1:${port}/ai/chat/completions`,
    AI_API_KEY: 'mock-key',
    AI_MODEL: 'gpt-4o-mini',
    WHATSAPP_TOKEN: 'mock-wa-token',
    HUMAN_NOTIFY_WEBHOOK_URL: `http://127.0.0.1:${port}/notify`,
    CRM_LOG_WEBHOOK_URL: `http://127.0.0.1:${port}/crm`,
  };
  // patch WhatsApp graph URL host so it hits our mock instead of graph.facebook.com
  const originalFetch = global.fetch;
  global.fetch = (url, opts) => {
    if (typeof url === 'string' && url.startsWith('https://graph.facebook.com/')) {
      url = url.replace('https://graph.facebook.com', `http://127.0.0.1:${port}`);
    }
    return originalFetch(url, opts);
  };

  await test('happy path: confident AI reply -> one WhatsApp send, logged as reply', async () => {
    resetState();
    const outcomes = await processWebhookBody(waTextMessage({ id: 'wamid.1', from: '98911111111', text: 'سلام، قیمت چنده؟' }), env);
    assert.strictEqual(outcomes.length, 1);
    assert.strictEqual(outcomes[0].decision.action, 'reply');
    assert.strictEqual(records.whatsappSends.length, 1);
    assert.strictEqual(records.crmLogs.length, 1);
    assert.strictEqual(records.crmLogs[0].action, 'reply');
    assert.strictEqual(records.notifications.length, 0);
  });

  await test('duplicate webhook delivery (Meta retry) -> AI and WhatsApp called only once', async () => {
    resetState();
    records.aiCalls.length = 0; records.whatsappSends.length = 0; records.crmLogs.length = 0;
    const body = waTextMessage({ id: 'wamid.dup', from: '98911111112', text: 'قیمت‌ها چیه؟' });
    const first = await processWebhookBody(body, env);
    const second = await processWebhookBody(body, env); // exact same message id redelivered
    assert.strictEqual(first.length, 1);
    assert.strictEqual(second.length, 0); // silently dropped, no items produced at all
    assert.strictEqual(records.aiCalls.length, 1);
    assert.strictEqual(records.whatsappSends.length, 1);
  });

  await test('non-text message once -> asks for text, no AI call, no handoff yet', async () => {
    resetState();
    records.aiCalls.length = 0; records.whatsappSends.length = 0; records.notifications.length = 0;
    const outcomes = await processWebhookBody(waImageMessage({ id: 'wamid.img1', from: '98911111113' }), env);
    assert.strictEqual(outcomes[0].decision.action, 'reply');
    assert.strictEqual(outcomes[0].decision.reason, 'non_text_message');
    assert.strictEqual(records.aiCalls.length, 0);
    assert.strictEqual(records.whatsappSends.length, 1);
    assert.strictEqual(records.notifications.length, 0);
  });

  await test('two non-text messages in a row -> hands off to a human', async () => {
    resetState();
    records.notifications.length = 0;
    const from = '98911111114';
    await processWebhookBody(waImageMessage({ id: 'wamid.img2', from }), env);
    const outcomes = await processWebhookBody(waImageMessage({ id: 'wamid.img3', from }), env);
    assert.strictEqual(outcomes[0].decision.action, 'handoff');
    assert.strictEqual(outcomes[0].decision.reason, 'repeated_non_text');
    assert.strictEqual(records.notifications.length, 1);
  });

  await test('AI returns unparseable garbage -> handoff, human notified, no reply sent to customer', async () => {
    resetState();
    records.whatsappSends.length = 0; records.notifications.length = 0;
    const outcomes = await processWebhookBody(waTextMessage({ id: 'wamid.garbage', from: '98911111115', text: 'MOCK_GARBAGE please help' }), env);
    assert.strictEqual(outcomes[0].decision.action, 'handoff');
    assert.strictEqual(outcomes[0].decision.reason, 'ai_response_unparseable');
    assert.strictEqual(outcomes[0].sentReply, false);
    assert.strictEqual(outcomes[0].sentInterim, false); // no replyText to send
    assert.strictEqual(records.notifications.length, 1);
  });

  await test('AI returns truncated JSON (token limit cutoff) -> handoff, does not crash the pipeline', async () => {
    resetState();
    const outcomes = await processWebhookBody(waTextMessage({ id: 'wamid.trunc', from: '98911111116', text: 'MOCK_TRUNCATED test' }), env);
    assert.strictEqual(outcomes[0].decision.action, 'handoff');
    assert.strictEqual(outcomes[0].decision.reason, 'ai_response_unparseable');
  });

  await test('AI low confidence -> handoff WITH interim reply sent, then human notified', async () => {
    resetState();
    records.whatsappSends.length = 0; records.notifications.length = 0;
    const outcomes = await processWebhookBody(waTextMessage({ id: 'wamid.lowconf', from: '98911111117', text: 'MOCK_LOW_CONF یه سوال عجیب' }), env);
    assert.strictEqual(outcomes[0].decision.action, 'handoff');
    assert.strictEqual(outcomes[0].decision.reason, 'low_confidence');
    assert.strictEqual(outcomes[0].sentInterim, true);
    assert.strictEqual(records.whatsappSends.length, 1);
    assert.strictEqual(records.notifications.length, 1);
  });

  await test('model explicitly requests handoff even with high confidence', async () => {
    resetState();
    const outcomes = await processWebhookBody(waTextMessage({ id: 'wamid.modelhandoff', from: '98911111118', text: 'MOCK_MODEL_HANDOFF شکایت دارم' }), env);
    assert.strictEqual(outcomes[0].decision.action, 'handoff');
    assert.strictEqual(outcomes[0].decision.reason, 'model_requested_handoff');
  });

  await test('session already owned by a human -> bot stays silent, still logs to CRM', async () => {
    resetState();
    const from = '98911111119';
    // first message: force handoff via keyword-triggered model handoff
    await processWebhookBody(waTextMessage({ id: 'wamid.h1', from, text: 'MOCK_MODEL_HANDOFF' }), env);
    records.aiCalls.length = 0; records.whatsappSends.length = 0; records.notifications.length = 0; records.crmLogs.length = 0;
    // second message from the same customer, session.state is now 'human'
    const outcomes = await processWebhookBody(waTextMessage({ id: 'wamid.h2', from, text: 'یه سوال دیگه' }), env);
    assert.strictEqual(outcomes[0].decision.action, 'ignore');
    assert.strictEqual(records.aiCalls.length, 0); // no AI call spent on a message a human already owns
    assert.strictEqual(records.whatsappSends.length, 0);
    assert.strictEqual(records.notifications.length, 0);
    assert.strictEqual(records.crmLogs.length, 1); // still visible in the CRM log
  });

  await test('a delivery-status-only webhook produces zero outcomes (not mistaken for a message)', async () => {
    resetState();
    records.crmLogs.length = 0;
    const outcomes = await processWebhookBody(waStatus({ id: 'wamid.status1', recipient: '98911111120' }), env);
    assert.strictEqual(outcomes.length, 0);
    assert.strictEqual(records.crmLogs.length, 0);
  });

  global.fetch = originalFetch;
  await close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
