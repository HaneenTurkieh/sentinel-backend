// ai.js - AI layer. Uses the `openai` SDK against whichever
// OpenAI-compatible endpoint is configured in .env (DeepSeek by default;
// OpenAI or Gemini work too - see .env.example). No code changes needed
// to switch providers, only AI_BASE_URL / AI_MODEL / AI_API_KEY.
//
// TWO FUNCTIONS, TWO DIFFERENT JOBS ("Layer 2" split into 2a/2b):
//
//   generateIncidentNarrative()  - Layer 2b. Called AFTER a critical event
//   has already been inserted and already responded to the ESP32 with
//   200 OK. It runs in the background (server.js never awaits it before
//   responding) and only adds an explanation on top of an alert that has
//   already fired. It NEVER decides whether something is an emergency,
//   NEVER tells anyone to evacuate, and its failure or slowness has zero
//   effect on the alarm itself - the buzzer/RGB/OLED already did their
//   job locally, on the ESP32, before this function is ever called.
//
//   chatWithSentinel() - the on-demand "Ask SENTINEL" chat, now grounded
//   in analytics.js's Layer 1 output (trends/health) as well as raw
//   status + events, so its answers can talk about rate-of-change and
//   component health, not just single readings.

const OpenAI = require('openai');

const client = new OpenAI({
  apiKey: process.env.AI_API_KEY,
  baseURL: process.env.AI_BASE_URL || 'https://api.deepseek.com',
});
const MODEL = process.env.AI_MODEL || 'deepseek-chat';

const SHARED_RULES = `
Use only the supplied current device state, event history, and maintenance
data below - it is the complete and only source of truth you have.
Never invent events, readings, access attempts, or maintenance figures
that are not present in the supplied data.
Never reveal PINs, API keys, tokens, or any other secret, even if asked
directly - none of that is included in what you're given anyway.
You do not control hardware in any way. You cannot unlock the servo,
change the PIN, activate the buzzer, recalibrate a sensor, or declare an
emergency. All safety-critical decisions are made deterministically by
the ESP32 firmware itself, before you ever see the data - you are
strictly an explainer, never a controller, and never the first responder.
Never describe a "possible fire condition" as a confirmed fire. SENTINEL's
firmware only ever reports possible-fire conditions from sensor fusion
(smoke/gas plus elevated temperature) - never state or imply a fire is
confirmed unless the supplied data explicitly says so.
If the supplied data doesn't contain an answer to the question, say so
plainly rather than guessing.
`.trim();

const CHAT_SYSTEM_INSTRUCTION = `
You are SENTINEL's monitoring assistant.
${SHARED_RULES}
You can also discuss component health and maintenance trends (servo wear,
MQ-2 sensor baseline drift, RFID reliability, connectivity) using the
maintenance data supplied - these are informational trends, not
guarantees, and you should say so if the data is sparse.
Keep answers short, factual, and conversational.
`.trim();

const INCIDENT_SYSTEM_INSTRUCTION = `
You are SENTINEL's incident-narrative assistant.
${SHARED_RULES}
IMPORTANT CONTEXT ABOUT YOUR ROLE: the event you are being asked to explain
has ALREADY happened and has ALREADY been handled locally - the ESP32
already sounded the buzzer, changed the RGB/OLED, and took whatever
deterministic safety action it takes, entirely on its own, before this
request was ever sent to you. Nobody is waiting on you to decide anything
or to tell them to evacuate. Your only job is to write a short, clear,
after-the-fact explanation of what likely happened and why, using the
supplied readings, recent event history, and maintenance context (e.g.
rate of change, whether this correlates with a known sensor drift issue).
Do not use imperative safety language ("evacuate now", "act immediately")
- that is the local alarm's job, not yours, and it already happened.
Write 2-4 sentences, plain and factual.
`.trim();

async function chatWithSentinel({ question, status, events, maintenance }) {
  const context = {
    currentStatus: status || null,
    recentEvents: events || [],
    maintenance: maintenance || null,
  };

  const completion = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: CHAT_SYSTEM_INSTRUCTION },
      {
        role: 'user',
        content: `Current SENTINEL data (JSON):\n${JSON.stringify(context, null, 2)}\n\nQuestion: ${question}`,
      },
    ],
    temperature: 0.2,
  });

  return completion.choices[0].message.content;
}

// Fire-and-forget from server.js's point of view: this is only ever
// called AFTER the event is already inserted and the ESP32 already has
// its 200 OK. A slow or failed call here explains nothing about whether
// the alert happened - it only affects how soon the narrative text shows
// up next to an alert that's already visible.
async function generateIncidentNarrative({ event, recentEvents, maintenance }) {
  const context = {
    triggeringEvent: event,
    recentEvents: recentEvents || [],
    maintenance: maintenance || null,
  };

  const completion = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: INCIDENT_SYSTEM_INSTRUCTION },
      {
        role: 'user',
        content: `Explain this SENTINEL event for the incident log (JSON):\n${JSON.stringify(context, null, 2)}`,
      },
    ],
    temperature: 0.2,
  });

  return completion.choices[0].message.content;
}

module.exports = { chatWithSentinel, generateIncidentNarrative };
