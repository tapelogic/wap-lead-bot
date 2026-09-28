/**
 * router.js
 * Final decision layer: given the normalized event, the dedup result, the
 * session state and (if we got that far) the AI result, decide exactly one
 * action. This is kept separate from ai-agent.js so the "when do we shut up
 * and hand off to a human" policy is in one auditable place.
 *
 * Session shape (persisted externally -- see README for storage options):
 * {
 *   waId: string,
 *   state: 'bot' | 'human',       // 'human' = a person took over; bot stays silent
 *   history: [{ role: 'user'|'bot', text: string, ts: number }],
 *   lead: { name: string|null, intent: string|null },
 *   nonTextStreak: number,        // consecutive non-text messages with no usable text
 *   updatedAt: number
 * }
 */

const MAX_HISTORY_TURNS = 12; // keep prompts bounded; older context summarized by not being there
const NON_TEXT_HANDOFF_STREAK = 2; // 2 media-only messages in a row -> let a human look

function newSession(waId, now = Date.now()) {
  return {
    waId,
    state: 'bot',
    history: [],
    lead: { name: null, intent: null },
    nonTextStreak: 0,
    updatedAt: now,
  };
}

function pushHistory(session, role, text, now = Date.now()) {
  session.history.push({ role, text, ts: now });
  if (session.history.length > MAX_HISTORY_TURNS) {
    session.history = session.history.slice(-MAX_HISTORY_TURNS);
  }
  session.updatedAt = now;
}

/**
 * @param {object} event - normalized event from normalize.js (kind: 'message')
 * @param {object} session - session object (will be mutated)
 * @param {object|null} aiResult - result of ai-agent.parseAiResponse, or null
 *   if we haven't called the AI yet (e.g. non-text message, or already
 *   in human mode)
 * @returns {{ action: 'reply'|'handoff'|'ignore', replyText: string|null, reason: string }}
 */
function decide(event, session, aiResult) {
  if (session.state === 'human') {
    // A person already took this conversation over. The bot stays silent
    // until the human (via the CRM/sheet) flips the session back to 'bot'.
    // This is a deliberate product decision, not an oversight: an AI reply
    // arriving *after* a human already answered is confusing and looks
    // unprofessional to the customer.
    return { action: 'ignore', replyText: null, reason: 'session_owned_by_human' };
  }

  if (!event.isTextLike) {
    session.nonTextStreak = (session.nonTextStreak || 0) + 1;
    if (session.nonTextStreak >= NON_TEXT_HANDOFF_STREAK) {
      return {
        action: 'handoff',
        replyText: 'پیام شما دریافت شد؛ همکار ما به‌زودی به صورت شخصی پاسخ می‌دهد.',
        reason: 'repeated_non_text',
      };
    }
    return {
      action: 'reply',
      replyText: 'لطفاً درخواستتان را به صورت پیام متنی هم برایمان بنویسید تا بتوانیم دقیق پاسخ بدهیم 🙏',
      reason: 'non_text_message',
    };
  }

  session.nonTextStreak = 0;

  if (!aiResult) {
    // Should not happen if the caller wired things correctly, but never
    // send nothing and never crash -- fail toward a human.
    return { action: 'handoff', replyText: null, reason: 'missing_ai_result' };
  }

  if (aiResult.parseError) {
    return { action: 'handoff', replyText: null, reason: 'ai_response_unparseable' };
  }

  if (aiResult.handoff) {
    return {
      action: 'handoff',
      replyText: aiResult.reply || null, // if the model still produced a polite reply, send it before escalating
      reason: aiResult.confidence < 0.6 ? 'low_confidence' : 'model_requested_handoff',
    };
  }

  return { action: 'reply', replyText: aiResult.reply, reason: 'ai_answered' };
}

module.exports = { newSession, pushHistory, decide, MAX_HISTORY_TURNS, NON_TEXT_HANDOFF_STREAK };
