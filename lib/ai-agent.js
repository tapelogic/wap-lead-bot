/**
 * ai-agent.js
 * Builds the prompt sent to the LLM and defensively parses its response.
 *
 * The model is instructed to return ONLY a JSON object. In practice LLMs
 * sometimes:
 *  - wrap JSON in ```json fences
 *  - add a sentence before/after the JSON
 *  - return invalid JSON (trailing comma, single quotes, truncated on
 *    length cutoff)
 *  - omit fields
 * None of those may crash the workflow or silently produce an empty reply
 * that gets sent to a real customer -- they must force a human handoff.
 */

const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;

function buildSystemPrompt(businessConfig) {
  const { businessName, language, services, handoffKeywords } = businessConfig;
  return [
    `You are the first-line WhatsApp assistant for "${businessName}".`,
    `Reply in ${language || 'the language the customer wrote in'}.`,
    services ? `What this business offers: ${services}` : null,
    'Your job: answer simple questions, collect the lead\'s name and what they need, and know when you are out of your depth.',
    'Escalate to a human (set "handoff": true) whenever: the customer asks for a price/quote you are not certain of, asks something you cannot answer confidently, sounds angry or upset, explicitly asks for a human, or asks something unrelated to the business.',
    handoffKeywords && handoffKeywords.length
      ? `Always escalate immediately if the message contains any of these words: ${handoffKeywords.join(', ')}.`
      : null,
    'Respond with ONLY a single JSON object, no prose outside it, matching exactly this shape:',
    '{"reply": string, "confidence": number between 0 and 1, "handoff": boolean, "lead": {"name": string|null, "intent": string|null}}',
    '"confidence" is YOUR OWN estimate of how correct/safe "reply" is. Be honest and conservative: if unsure, use a low number and set handoff true.',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildMessages(businessConfig, history, incomingText) {
  const messages = [{ role: 'system', content: buildSystemPrompt(businessConfig) }];
  for (const turn of history || []) {
    messages.push({ role: turn.role === 'bot' ? 'assistant' : 'user', content: turn.text });
  }
  messages.push({ role: 'user', content: incomingText });
  return messages;
}

/**
 * Extracts a JSON object from a raw LLM text response, tolerating common
 * wrapping mistakes (code fences, leading/trailing prose).
 */
function extractJsonObject(rawText) {
  if (typeof rawText !== 'string') return null;
  let s = rawText.trim();

  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) s = fenced[1].trim();

  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last === -1 || last < first) return null;
  s = s.slice(first, last + 1);

  try {
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}

/**
 * @param {string} rawText - raw content string from the LLM API response
 * @param {number} confidenceThreshold
 * @returns {{ ok: boolean, reply: string|null, confidence: number, handoff: boolean,
 *             lead: {name: string|null, intent: string|null}, parseError: boolean }}
 */
function parseAiResponse(rawText, confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD) {
  const parsed = extractJsonObject(rawText);

  if (!parsed || typeof parsed !== 'object') {
    return {
      ok: false,
      reply: null,
      confidence: 0,
      handoff: true,
      lead: { name: null, intent: null },
      parseError: true,
    };
  }

  const reply = typeof parsed.reply === 'string' && parsed.reply.trim() ? parsed.reply.trim() : null;
  let confidence = typeof parsed.confidence === 'number' && isFinite(parsed.confidence) ? parsed.confidence : 0;
  confidence = Math.max(0, Math.min(1, confidence));
  const modelHandoff = parsed.handoff === true;
  const lead = {
    name: parsed.lead && typeof parsed.lead.name === 'string' ? parsed.lead.name.trim() || null : null,
    intent: parsed.lead && typeof parsed.lead.intent === 'string' ? parsed.lead.intent.trim() || null : null,
  };

  const missingReply = !reply;
  const lowConfidence = confidence < confidenceThreshold;
  const handoff = modelHandoff || missingReply || lowConfidence;

  return {
    ok: true,
    reply,
    confidence,
    handoff,
    lead,
    parseError: false,
  };
}

module.exports = {
  buildSystemPrompt,
  buildMessages,
  extractJsonObject,
  parseAiResponse,
  DEFAULT_CONFIDENCE_THRESHOLD,
};
