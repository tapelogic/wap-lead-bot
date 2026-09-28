# WhatsApp Lead Bot — AI Reply + Human Handoff (n8n)

A portfolio-ready n8n workflow: a WhatsApp Business number answers simple
customer questions with AI, logs every lead to a CRM sheet, and hands off
to a human the moment it's unsure, the customer is upset, or the message
needs a person (with the human notified and the customer told someone is
coming). Built for freelance/subcontract WhatsApp-automation jobs (the
single most requested project type on the n8n Jobs forum right now).

## What's in this repo

```
lib/                 The actual decision logic (plain Node.js, framework-free)
  normalize.js        Parses raw WhatsApp Cloud API webhook payloads
  dedupe.js            Prevents double-replies when Meta redelivers a webhook
  ai-agent.js          Builds the AI prompt, defensively parses the AI's JSON reply
  router.js            The "when do we shut up and hand off to a human" policy
test/
  run.js                28 unit tests for lib/ (pure logic, no network)
  mock-server.js         A tiny local HTTP server standing in for the
                          WhatsApp Graph API, the AI API, and two webhook
                          endpoints (human-notify, CRM log)
  run-workflow-nodes.js  10 integration tests that execute the LITERAL code
                          and HTTP requests inside n8n/workflow.json against
                          mock-server.js over real HTTP on loopback
build/
  build-workflow.js    Generates n8n/workflow.json by splicing the exact
                        source of lib/*.js into the workflow's Code nodes
                        (no hand-copied logic, no drift between what's
                        tested and what ships)
n8n/
  workflow.json        Import this into n8n
```

## What was actually verified, and what was not

Being upfront about this because it matters more than it sounds:

**Verified, by actually running it:**
- All decision logic (28 unit tests: `node test/run.js`) — duplicate
  delivery, non-text messages, malformed/truncated AI JSON, low-confidence
  handoff, capped conversation history, etc.
- The exact Code-node source and HTTP-node request shapes that are inside
  `n8n/workflow.json` — not a hand-written approximation of them — run
  end-to-end against a real local HTTP server over real network calls
  (10 integration tests: `node test/run-workflow-nodes.js`). This is done
  with Node's `vm` module executing the literal `jsCode` strings pulled out
  of the JSON file, so a bug introduced while assembling the workflow would
  show up here.

**NOT verified — and why:** this sandbox's network egress policy blocks
`registry.npmjs.org` and the Docker registry (`403 Host not in allowlist`),
so n8n itself could not be installed here to do a real import-and-click-run.
That means the following have **not** been confirmed:
- That `n8n/workflow.json` imports cleanly into a real n8n instance with no
  red-flagged nodes (node type/typeVersion strings were written from
  current n8n documentation, not confirmed against a running instance).
- That the WhatsApp Cloud API and the OpenAI-compatible chat-completions
  API behave exactly as assumed against real credentials (only their
  documented request/response shapes were used).

**Before using this on a real client project:** import `workflow.json` into
your own n8n (free cloud trial or self-hosted), confirm no node shows an
error icon, and run one real WhatsApp message through it with a real
WhatsApp Business test number. That's a 10–15 minute check, not a rebuild —
the logic underneath it is already tested.

## How the decision logic works

1. **Normalize** the raw webhook into one event per message. Delivery/read
   receipts (`statuses`) are recognized and ignored — treating every
   webhook hit as a message is a common beginner bug that makes the bot
   "reply" to its own delivery confirmations.
2. **Dedupe** by WhatsApp message id, using n8n's workflow static data
   (`$getWorkflowStaticData`). WhatsApp redelivers a webhook if your
   endpoint is slow or errors; without this, a slow AI call = the customer
   gets answered twice.
3. **Session state per customer** (`bot` or `human`), also in static data.
   Once a conversation is handed off, the bot stays silent — it does not
   jump back in after a human has already started answering.
4. **Non-text messages** (image/audio/document/location/etc.) get a polite
   "please also send this as text" once; a second one in a row hands off to
   a human instead of guessing at an image.
5. **The AI is asked to self-report a confidence score** and to set
   `handoff: true` itself when it's out of its depth. Its JSON response is
   parsed defensively — code-fenced, prefixed with prose, truncated, or
   outright garbage output all fail safe into a human handoff, never into
   an empty or wrong reply sent to a real customer.
6. Every outcome (reply sent / handed off / ignored because a human owns
   the session) is logged to a webhook you point at a CRM/sheet, so the
   business owner has one place to see every lead.

## Setup (for a real deployment)

Set these in n8n (Settings → Variables, or your host's env vars):

| Variable | What it's for |
|---|---|
| `WHATSAPP_TOKEN` | WhatsApp Cloud API permanent access token |
| `AI_API_URL` | Chat-completions endpoint (defaults to OpenAI's) |
| `AI_API_KEY` | Your AI provider's API key |
| `AI_MODEL` | e.g. `gpt-4o-mini` |
| `HUMAN_NOTIFY_WEBHOOK_URL` | Where to POST a handoff alert (a Slack incoming webhook or a Telegram bot webhook both work with zero extra nodes) |
| `CRM_LOG_WEBHOOK_URL` | Where to POST every processed message (a Google Apps Script Web App or a service like Sheety in front of a Google Sheet works without n8n needing Google OAuth credentials) |

Also edit the `VERIFY_TOKEN` constant in the **Check Verify Token** node and
the `BUSINESS_CONFIG` object (business name, services, language, handoff
keywords) in the **Normalize, Dedupe, Route** node — those two edits are
the entire "customize for a new client" step.

## Known limits (tell a client this up front, don't discover it in production)

- **Static-data storage is an MVP choice, not a scale one.** It's fine for
  one n8n instance and a realistic small-business message volume. It is
  not safe under multiple parallel n8n workers and has no row-level
  locking. For a client processing serious volume, swap the
  `$getWorkflowStaticData` calls for a Postgres/Airtable table — the
  `newSession`/`pushHistory` shape in `lib/router.js` maps directly to a
  table row, so this is a contained change, not a rewrite.
- **Handoff never auto-resolves.** Once a session is `human`, it stays that
  way until someone flips it back (e.g., a checkbox in the CRM sheet that a
  small addition to this workflow reads). Decide with the client whether
  that reset is manual or time-based.
- **24-hour WhatsApp session window:** this workflow only replies to
  inbound messages, which is always inside the window, so this doesn't
  bite here — but if a client later wants proactive/scheduled outreach,
  that requires pre-approved message templates, a different API call.
- **This has not been load-tested.** It's sized for "one small business's
  WhatsApp inbox," not a call-center volume.

## Running the tests

```
node test/run.js                 # 28 unit tests, pure logic, instant
node test/run-workflow-nodes.js  # 10 integration tests, spins up a local
                                  # mock server, exercises the literal
                                  # workflow.json code over real HTTP
```

Rebuild `n8n/workflow.json` after any change to `lib/*.js`:

```
node build/build-workflow.js
```
