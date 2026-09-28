/**
 * mock-server.js
 * Stands in for the WhatsApp Graph API, an OpenAI-compatible chat
 * completions endpoint, and two generic webhook endpoints (human-handoff
 * notification, CRM log). Built on Node's built-in http module only --
 * no dependency, since npm registry access is blocked in this sandbox
 * anyway (see README "What was and wasn't verified").
 *
 * Test control: the AI endpoint inspects the last user message for a
 * magic marker to decide which canned scenario to return, so integration
 * tests can drive every branch of the decision logic deterministically.
 */
const http = require('http');

function startMockServer() {
  const records = { whatsappSends: [], aiCalls: [], notifications: [], crmLogs: [] };

  const server = http.createServer((req, res) => {
    let chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const bodyStr = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = bodyStr ? JSON.parse(bodyStr) : null; } catch (e) { body = { __parseError: true, raw: bodyStr }; }

      if (req.method === 'POST' && req.url === '/ai/chat/completions') {
        records.aiCalls.push(body);
        const lastUser = [...(body.messages || [])].reverse().find((m) => m.role === 'user');
        const text = (lastUser && lastUser.content) || '';
        let content;
        if (text.includes('MOCK_GARBAGE')) {
          content = 'sorry, I cannot help with that, please contact support somehow';
        } else if (text.includes('MOCK_LOW_CONF')) {
          content = JSON.stringify({ reply: 'اجازه بدید بررسی کنم و بهتون خبر بدم.', confidence: 0.25, handoff: false, lead: {} });
        } else if (text.includes('MOCK_MODEL_HANDOFF')) {
          content = JSON.stringify({ reply: 'این مورد را به همکارم ارجاع می‌دهم.', confidence: 0.95, handoff: true, lead: { name: null, intent: 'complaint' } });
        } else if (text.includes('MOCK_TRUNCATED')) {
          content = '{"reply": "این پاسخ قطع شده در وسط ط';
        } else {
          content = JSON.stringify({
            reply: 'سلام! برای اطلاع دقیق، لطفاً محصول موردنظر را بفرمایید.',
            confidence: 0.9,
            handoff: false,
            lead: { name: null, intent: 'general_inquiry' },
          });
        }
        respondJson(res, 200, { choices: [{ message: { role: 'assistant', content } }] });
        return;
      }

      if (req.method === 'POST' && /^\/v\d+\.\d+\/.+\/messages$/.test(req.url)) {
        records.whatsappSends.push({ url: req.url, body });
        respondJson(res, 200, { messaging_product: 'whatsapp', messages: [{ id: 'wamid.mock.' + records.whatsappSends.length }] });
        return;
      }

      if (req.method === 'POST' && req.url === '/notify') {
        records.notifications.push(body);
        respondJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'POST' && req.url === '/crm') {
        records.crmLogs.push(body);
        respondJson(res, 200, { ok: true });
        return;
      }

      respondJson(res, 404, { error: 'not found', url: req.url });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, records, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

function respondJson(res, status, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}

module.exports = { startMockServer };
