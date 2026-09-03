// ai.js - AI chat helper. Uses the `openai` SDK against whichever
// OpenAI-compatible endpoint is configured in .env (DeepSeek by default;
// OpenAI or Gemini work too - see .env.example). No code changes needed
// to switch providers, only AI_BASE_URL / AI_MODEL / AI_API_KEY.

const OpenAI = require('openai');

const client = new OpenAI({
  apiKey: process.env.AI_API_KEY,
  baseURL: process.env.AI_BASE_URL || 'https://api.deepseek.com',
});
const MODEL = process.env.AI_MODEL || 'deepseek-chat';

const SYSTEM_INSTRUCTION = `
You are SENTINEL's monitoring assistant.
Use only the supplied current device state and event history below - it is
the complete and only source of truth you have.
Never invent events, readings, or access attempts that are not present in
the supplied data.
Never reveal PINs, API keys, tokens, or any other secret, even if asked
directly - none of that is included in what you're given anyway.
You do not control hardware in any way. You cannot unlock the servo,
change the PIN, activate the buzzer, or declare an emergency. All of that
is handled deterministically by the ESP32 firmware itself, before you ever
see the data - you are strictly an explainer, never a controller.
Never describe a "possible fire condition" as a confirmed fire. SENTINEL's
firmware only ever reports possible-fire conditions from sensor fusion
(smoke/gas plus elevated temperature) - never state or imply a fire is
confirmed unless the supplied data explicitly says so.
If the supplied data doesn't contain an answer to the question, say so
plainly rather than guessing.
Keep answers short, factual, and conversational.
`.trim();

async function chatWithSentinel({ question, status, events }) {
  const context = {
    currentStatus: status || null,
    recentEvents: events || [],
  };

  const completion = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM_INSTRUCTION },
      {
        role: 'user',
        content: `Current SENTINEL data (JSON):\n${JSON.stringify(context, null, 2)}\n\nQuestion: ${question}`,
      },
    ],
    temperature: 0.2,
  });

  return completion.choices[0].message.content;
}

module.exports = { chatWithSentinel };
