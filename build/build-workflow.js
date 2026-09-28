/**
 * build-workflow.js
 * Generates n8n/workflow.json for import into n8n.
 *
 * IMPORTANT: the Code nodes below do NOT hand-copy the logic in lib/*.js.
 * They read those files' actual source at build time and splice it in
 * verbatim (module.exports lines stripped). This guarantees the code that
 * ships inside the n8n workflow is byte-identical to the code that just
 * passed 28 unit tests in test/run.js -- there is no separate "workflow
 * version" of the logic that could silently drift out of sync.
 *
 * Run: node build/build-workflow.js
 * Output: n8n/workflow.json
 */
const fs = require('fs');
const path = require('path');

const LIB_DIR = path.join(__dirname, '..', 'lib');
const OUT_DIR = path.join(__dirname, '..', 'n8n');
const OUT_FILE = path.join(OUT_DIR, 'workflow.json');

function readLibSource(filename) {
  const raw = fs.readFileSync(path.join(LIB_DIR, filename), 'utf8');
  // Strip the module.exports block (n8n Code nodes are not CommonJS modules;
  // we just want the function declarations available in scope).
  return raw.replace(/module\.exports\s*=\s*\{[\s\S]*?\};?\s*$/m, '').trim();
}

const SRC_NORMALIZE = readLibSource('normalize.js');
const SRC_DEDUPE = readLibSource('dedupe.js');
const SRC_AI_AGENT = readLibSource('ai-agent.js');
const SRC_ROUTER = readLibSource('router.js');

// ---------------------------------------------------------------------
// Business config: the only part a buyer/reseller actually needs to edit
// per client. Kept as one literal object at the top of the relevant Code
// nodes rather than pulled from n8n credentials, so it's obvious in a demo
// what to change for a new customer.
const BUSINESS_CONFIG_LITERAL = `const BUSINESS_CONFIG = {
  businessName: 'Demo Business',
  language: 'Persian (Farsi) unless the customer writes in another language',
  services: 'General customer inquiries (replace with the real product/service list for this client)',
  handoffKeywords: ['شکایت', 'complaint', 'refund', 'مرجوعی', 'لغو', 'cancel', 'قانونی', 'lawyer'],
};
const CONFIDENCE_THRESHOLD = 0.6;`;

// ---------------------------------------------------------------------
// Node 2: verify-token check for the GET webhook-verification handshake
const CODE_CHECK_VERIFY = `${BUSINESS_CONFIG_LITERAL}

// Set this to the same random string you enter in the Meta App dashboard
// (WhatsApp > Configuration > Webhook > Verify Token). Move this to an n8n
// credential/environment variable for anything beyond a demo.
const VERIFY_TOKEN = 'REPLACE_WITH_YOUR_VERIFY_TOKEN';

const q = $input.first().json.query || {};
const mode = q['hub.mode'];
const token = q['hub.verify_token'];
const challenge = q['hub.challenge'];

if (mode === 'subscribe' && token === VERIFY_TOKEN) {
  return [{ json: { statusCode: 200, body: challenge } }];
}
return [{ json: { statusCode: 403, body: 'verification failed' } }];`;

// ---------------------------------------------------------------------
// Node 5: normalize the raw webhook body, dedupe against redelivery,
// load/create the per-customer session, and decide whether this item needs
// an AI call or can be routed immediately (non-text message, or a session
// already owned by a human).
const CODE_NORMALIZE_ROUTE = `${SRC_NORMALIZE}

${SRC_DEDUPE}

${SRC_ROUTER}

${SRC_AI_AGENT}

${BUSINESS_CONFIG_LITERAL}

const staticData = $getWorkflowStaticData('global');
staticData.seenIds = staticData.seenIds || {};
staticData.sessions = staticData.sessions || {};

const body = $input.first().json.body || $input.first().json;
const events = normalizeWebhookBody(body);
const outputItems = [];

for (const event of events) {
  if (event.kind === 'status') continue; // delivery/read receipt, not a message

  const isNew = markAndCheck(staticData.seenIds, event.id);
  if (!isNew) continue; // Meta redelivered a message we already handled

  let session = staticData.sessions[event.from];
  if (!session) {
    session = newSession(event.from);
    staticData.sessions[event.from] = session;
  }
  if (event.isTextLike) pushHistory(session, 'user', event.text);

  const needsAI = event.isTextLike && session.state === 'bot';

  if (needsAI) {
    const historyForPrompt = session.history.slice(0, -1); // exclude the message we're about to send as the final user turn
    const messages = buildMessages(BUSINESS_CONFIG, historyForPrompt, event.text);
    outputItems.push({
      json: {
        waId: event.from,
        phoneNumberId: event.phoneNumberId,
        contactName: event.contactName,
        needsAI: true,
        messages,
        event,
      },
    });
  } else {
    const decision = decide(event, session, null);
    if (decision.action === 'handoff') session.state = 'human';
    if (decision.action === 'reply' && decision.replyText) pushHistory(session, 'bot', decision.replyText);
    outputItems.push({
      json: {
        waId: event.from,
        phoneNumberId: event.phoneNumberId,
        contactName: event.contactName,
        needsAI: false,
        decision,
        event,
      },
    });
  }
}

return outputItems;`;

// ---------------------------------------------------------------------
// Node 8: parse the AI HTTP response, apply the same decide() policy, and
// persist the outcome back into the session.
const CODE_PARSE_DECIDE = `${SRC_AI_AGENT}

${SRC_ROUTER}

const CONFIDENCE_THRESHOLD = 0.6;

const staticData = $getWorkflowStaticData('global');
const prior = $('Normalize, Dedupe, Route').item.json;
const aiResponse = $json;

const rawText =
  aiResponse && aiResponse.choices && aiResponse.choices[0] && aiResponse.choices[0].message
    ? aiResponse.choices[0].message.content
    : null;

const aiResult = parseAiResponse(rawText, CONFIDENCE_THRESHOLD);
const session = staticData.sessions[prior.waId];

const decision = decide(prior.event, session, aiResult);

if (decision.action === 'handoff') {
  session.state = 'human';
}
if (decision.replyText) {
  pushHistory(session, 'bot', decision.replyText);
}

return {
  json: {
    waId: prior.waId,
    phoneNumberId: prior.phoneNumberId,
    contactName: prior.contactName,
    decision,
    aiResult,
  },
};`;

// ---------------------------------------------------------------------
function ifNode(name, position, leftExpr, rightValue, operation = 'equals') {
  return {
    id: name.replace(/\s+/g, '_'),
    name,
    type: 'n8n-nodes-base.if',
    typeVersion: 2,
    position,
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [
          {
            id: 'c1',
            leftValue: leftExpr,
            rightValue,
            operator: { type: 'string', operation },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
  };
}

function codeNode(name, position, jsCode, mode = 'runOnceForAllItems') {
  return {
    id: name.replace(/\s+/g, '_'),
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position,
    parameters: { mode, language: 'javaScript', jsCode },
  };
}

function httpNode(name, position, { url, method = 'POST', body, headers, sendBody = true }) {
  const params = {
    method,
    url,
    authentication: 'none',
    sendHeaders: !!headers,
    sendBody,
    options: {},
  };
  if (headers) {
    params.headerParameters = { parameters: Object.entries(headers).map(([n, v]) => ({ name: n, value: v })) };
  }
  if (sendBody) {
    params.specifyBody = 'json';
    params.jsonBody = body;
  }
  return {
    id: name.replace(/\s+/g, '_'),
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position,
    parameters: params,
  };
}

const nodes = [];
const connections = {};

// n8n's real connections schema (packages/workflow/src/interfaces.ts:
// IConnections/INodeConnections) is:
//   { [sourceNodeName]: { [connectionType]: Array<Array<IConnection> | null> } }
// i.e. each source node's entry is keyed by connection type ("main" for
// ordinary data flow) BEFORE the per-output array of targets. A flat
// `{ [sourceNodeName]: Array<Array<IConnection>> }` (no "main" key) is not
// this schema -- n8n's importer doesn't reject it outright, it just can't
// resolve most of the connections against it, so they silently vanish from
// the canvas instead of erroring. That was the exact bug here.
function connect(fromName, toName, fromOutput = 0) {
  connections[fromName] = connections[fromName] || { main: [] };
  while (connections[fromName].main.length <= fromOutput) connections[fromName].main.push([]);
  connections[fromName].main[fromOutput].push({ node: toName, type: 'main', index: 0 });
}

// 1. Verify webhook (GET) ------------------------------------------------
nodes.push({
  id: 'Webhook_Verify',
  name: 'Webhook Verify (GET)',
  type: 'n8n-nodes-base.webhook',
  typeVersion: 2,
  position: [0, 0],
  webhookId: 'wa-verify',
  parameters: {
    httpMethod: 'GET',
    path: 'wa-lead-bot',
    responseMode: 'responseNode',
    options: {},
  },
});

nodes.push(codeNode('Check Verify Token', [220, 0], CODE_CHECK_VERIFY));

nodes.push({
  id: 'Respond_Verify',
  name: 'Respond to Webhook (Verify)',
  type: 'n8n-nodes-base.respondToWebhook',
  typeVersion: 1.1,
  position: [440, 0],
  parameters: {
    respondWith: 'text',
    responseBody: '={{$json.body}}',
    options: { responseCode: '={{$json.statusCode}}' },
  },
});

connect('Webhook Verify (GET)', 'Check Verify Token');
connect('Check Verify Token', 'Respond to Webhook (Verify)');

// 2. Receive messages (POST) ---------------------------------------------
nodes.push({
  id: 'Webhook_Receive',
  name: 'Webhook Receive (POST)',
  type: 'n8n-nodes-base.webhook',
  typeVersion: 2,
  position: [0, 300],
  webhookId: 'wa-receive',
  parameters: {
    httpMethod: 'POST',
    path: 'wa-lead-bot',
    responseMode: 'onReceived',
    responseCode: 200,
    responseData: 'EVENT_RECEIVED',
    options: {},
  },
});

nodes.push(codeNode('Normalize, Dedupe, Route', [220, 300], CODE_NORMALIZE_ROUTE));

nodes.push(ifNode('Needs AI?', [460, 300], '={{$json.needsAI}}', 'true', 'equals'));

nodes.push(
  httpNode('Call AI', [700, 200], {
    url: '={{$env.AI_API_URL || "https://api.openai.com/v1/chat/completions"}}',
    headers: { Authorization: '=Bearer {{$env.AI_API_KEY}}', 'Content-Type': 'application/json' },
    body: '={{ { "model": $env.AI_MODEL || "gpt-4o-mini", "messages": $json.messages, "temperature": 0.3 } }}',
  })
);

nodes.push(codeNode('Parse AI, Decide, Persist', [940, 200], CODE_PARSE_DECIDE, 'runOnceForEachItem'));

connect('Webhook Receive (POST)', 'Normalize, Dedupe, Route');
connect('Normalize, Dedupe, Route', 'Needs AI?');
connect('Needs AI?', 'Call AI', 0); // true output
connect('Call AI', 'Parse AI, Decide, Persist');

// 3. Route by decision.action ---------------------------------------------
nodes.push(ifNode('Action = reply?', [1180, 300], '={{$json.decision.action}}', 'reply', 'equals'));
nodes.push(ifNode('Action = handoff?', [1180, 500], '={{$json.decision.action}}', 'handoff', 'equals'));

// both branches (AI path output0 "true", non-AI path output1 "false") feed the routers
connect('Needs AI?', 'Action = reply?', 1); // false output = non-AI items, decision already computed
connect('Parse AI, Decide, Persist', 'Action = reply?');
connect('Needs AI?', 'Action = handoff?', 1);
connect('Parse AI, Decide, Persist', 'Action = handoff?');

nodes.push(
  httpNode('Send WhatsApp Reply', [1420, 200], {
    url: '={{"https://graph.facebook.com/v20.0/" + $json.phoneNumberId + "/messages"}}',
    headers: { Authorization: '=Bearer {{$env.WHATSAPP_TOKEN}}', 'Content-Type': 'application/json' },
    body: '={{ { "messaging_product": "whatsapp", "to": $json.waId, "type": "text", "text": { "body": $json.decision.replyText } } }}',
  })
);
connect('Action = reply?', 'Send WhatsApp Reply', 0);

nodes.push(ifNode('Handoff has interim text?', [1420, 500], '={{$json.decision.replyText}}', '', 'notEqual'));
connect('Action = handoff?', 'Handoff has interim text?', 0);

nodes.push(
  httpNode('Send WhatsApp Interim Reply', [1660, 440], {
    url: '={{"https://graph.facebook.com/v20.0/" + $json.phoneNumberId + "/messages"}}',
    headers: { Authorization: '=Bearer {{$env.WHATSAPP_TOKEN}}', 'Content-Type': 'application/json' },
    body: '={{ { "messaging_product": "whatsapp", "to": $json.waId, "type": "text", "text": { "body": $json.decision.replyText } } }}',
  })
);
connect('Handoff has interim text?', 'Send WhatsApp Interim Reply', 0);

nodes.push(
  httpNode('Notify Human (Handoff)', [1900, 500], {
    url: '={{$env.HUMAN_NOTIFY_WEBHOOK_URL}}',
    body:
      '={{ { "text": "🔔 تحویل به انسان: " + ($json.contactName || $json.waId) + " (" + $json.waId + ") — دلیل: " + $json.decision.reason } }}',
  })
);
connect('Send WhatsApp Interim Reply', 'Notify Human (Handoff)');
connect('Handoff has interim text?', 'Notify Human (Handoff)', 1); // false output -> straight to notify, nothing to send

nodes.push(
  httpNode('Log to CRM', [2140, 350], {
    url: '={{$env.CRM_LOG_WEBHOOK_URL}}',
    body:
      '={{ { "waId": $json.waId, "contactName": $json.contactName, "action": ($json.decision ? $json.decision.action : "unknown"), "reason": ($json.decision ? $json.decision.reason : null), "replyText": ($json.decision ? $json.decision.replyText : null), "timestamp": new Date().toISOString() } }}',
  })
);
connect('Send WhatsApp Reply', 'Log to CRM');
connect('Notify Human (Handoff)', 'Log to CRM');
connect('Action = handoff?', 'Log to CRM', 1); // ignore path (neither reply nor handoff) still gets logged

nodes.push({ id: 'NoOp_placeholder', name: 'End', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [2380, 350], parameters: {} });
connect('Log to CRM', 'End');

const workflow = {
  name: 'WhatsApp Lead Bot - AI Reply + Human Handoff',
  nodes,
  connections,
  active: false,
  settings: { executionOrder: 'v1' },
  pinData: {},
};

// ---------------------------------------------------------------------
// Self-check: this is what should have caught the missing-"main" bug
// before the file ever reached a real n8n instance. It fails the build
// (non-zero exit, no file written) instead of silently emitting a
// workflow.json that n8n will import without error but with connections
// missing. Checks the shape connect() is supposed to produce, plus the
// class of mistake that shape doesn't prevent by itself (a typo'd target
// name, two nodes accidentally sharing a name/id).
function validateWorkflow(wf) {
  const names = new Set();
  const ids = new Set();
  for (const node of wf.nodes) {
    if (names.has(node.name)) throw new Error(`Duplicate node name: "${node.name}"`);
    names.add(node.name);
    if (ids.has(node.id)) throw new Error(`Duplicate node id: "${node.id}" (node "${node.name}")`);
    ids.add(node.id);
  }

  for (const [fromName, nodeConnections] of Object.entries(wf.connections)) {
    if (!names.has(fromName)) {
      throw new Error(`connections references unknown source node: "${fromName}"`);
    }
    if (Array.isArray(nodeConnections) || typeof nodeConnections !== 'object' || nodeConnections === null) {
      throw new Error(
        `connections["${fromName}"] must be an object keyed by connection type (e.g. "main"), not ${
          Array.isArray(nodeConnections) ? 'an array' : typeof nodeConnections
        } -- this is the exact shape of the bug that dropped connections on import`
      );
    }
    for (const [connType, outputs] of Object.entries(nodeConnections)) {
      if (!Array.isArray(outputs)) {
        throw new Error(`connections["${fromName}"]["${connType}"] must be an array of output slots`);
      }
      outputs.forEach((targets, outputIndex) => {
        if (targets === null) return; // an unconnected output slot is valid n8n shape
        if (!Array.isArray(targets)) {
          throw new Error(`connections["${fromName}"]["${connType}"][${outputIndex}] must be an array`);
        }
        for (const target of targets) {
          if (!target || typeof target.node !== 'string') {
            throw new Error(
              `connections["${fromName}"]["${connType}"][${outputIndex}] has a malformed target: ${JSON.stringify(target)}`
            );
          }
          if (!names.has(target.node)) {
            throw new Error(`connections["${fromName}"] points to "${target.node}", but no node with that name exists`);
          }
        }
      });
    }
  }
}

validateWorkflow(workflow);

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(workflow, null, 2));
console.log(`Wrote ${OUT_FILE}`);
console.log(`Nodes: ${nodes.length}`);
