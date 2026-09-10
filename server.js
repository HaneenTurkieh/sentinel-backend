// server.js - SENTINEL backend entry point.
//
// CHANGES FROM THE ORIGINAL:
//  - Every status/event write now also updates analytics.js (Layer 1 -
//    plain statistics, runs synchronously, no LLM involved).
//  - Critical events now trigger an async incident narrative (Layer 2b)
//    AFTER the ESP32 already has its 200 OK - this never adds latency to
//    the ESP32's request, and a slow/failed AI call can't delay or block
//    the event from showing up immediately in the dashboard's event feed.
//  - New GET /api/maintenance/:deviceId (also accepts ?deviceId=) for the
//    dashboard's maintenance/predictive-maintenance panel.
//  - /api/ai/chat now also passes the maintenance summary into context.

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const {
  initDb, upsertStatus, insertEvent, updateEventSummary,
  getStatus, getEvents, getEventById,
} = require('./db');
const analytics = require('./analytics');
const { chatWithSentinel, generateIncidentNarrative } = require('./ai');

const app = express();
app.use(cors());
app.use(express.json());

const DEVICE_API_KEY = process.env.DEVICE_API_KEY;
const DEFAULT_DEVICE_ID = 'sentinel-01';

// Fail loudly at startup rather than silently on the first AI call. This is
// a WARNING, not a crash: per the "AI never gates core function" rule,
// status/event ingestion from the ESP32 must keep working even if AI is
// completely unconfigured - only /api/ai/chat and incident narratives
// would be affected.
if (!process.env.AI_API_KEY) {
  console.error(
    '[STARTUP] WARNING: AI_API_KEY is not set. The AI chat endpoint and ' +
    'incident narratives will fail on every call until this is set in ' +
    '.env (locally) or the Render environment variables (deployed). ' +
    'ESP32 status/event ingestion is unaffected and will work normally.'
  );
}

// Event types worth an AI narrative. Deliberately excludes routine/noisy
// types like wrong_pin (a single wrong PIN isn't an incident) - it still
// gets logged and shown instantly either way, just without AI prose.
const NARRATIVE_EVENT_TYPES = new Set([
  'unauthorized_rfid',
  'security_lockout',
  'smoke_warning',
  'gas_smoke_danger',
  'possible_fire',
]);

// The AI chat route has no auth (it's meant to be hit by a public dashboard),
// but each call costs real money against the AI provider. A simple in-memory
// sliding window keeps an open endpoint from turning into an open bill -
// good enough for a prototype; swap for a shared store (e.g. Redis) if this
// ever runs on more than one server instance.
const CHAT_RATE_LIMIT_MAX = 8;
const CHAT_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const chatRequestLog = new Map(); // ip -> array of request timestamps

function chatRateLimiter(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const timestamps = (chatRequestLog.get(ip) || []).filter(
    (t) => now - t < CHAT_RATE_LIMIT_WINDOW_MS
  );

  if (timestamps.length >= CHAT_RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'rate_limited', retryAfterMs: CHAT_RATE_LIMIT_WINDOW_MS });
  }

  timestamps.push(now);
  chatRequestLog.set(ip, timestamps);
  next();
}

// Protects the two write routes the ESP32 uses. Dashboard reads (GET) and
// the AI chat route are intentionally left open for the prototype - add
// a separate dashboard auth layer later if this goes beyond a demo.
function requireDeviceKey(req, res, next) {
  const key = req.header('X-Device-Key');
  if (!DEVICE_API_KEY) {
    console.error('[AUTH] DEVICE_API_KEY is not set on the server - refusing all writes.');
    return res.status(500).json({ error: 'server_misconfigured' });
  }
  if (!key || key !== DEVICE_API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// Fire-and-forget: generates the incident narrative and attaches it to
// the event row. Called only AFTER the ESP32 already has its response.
// Any failure here is logged and otherwise invisible to the rest of the
// system - the event itself is already saved and already visible.
async function enrichEventWithNarrative(eventId, eventForContext, deviceId) {
  try {
    const [recentEvents, maintenance] = await Promise.all([
      getEvents(deviceId, 10),
      analytics.buildMaintenanceSummary(deviceId, await getStatus(deviceId)),
    ]);
    const narrative = await generateIncidentNarrative({
      event: eventForContext,
      recentEvents,
      maintenance,
    });
    await updateEventSummary(eventId, narrative);
  } catch (err) {
    console.error('[AI] Failed to generate/store incident narrative for event', eventId, err);
  }
}

// --- ESP32 -> backend -------------------------------------------------

app.post('/api/status', requireDeviceKey, async (req, res) => {
  try {
    const s = req.body;
    if (!s || !s.deviceId) return res.status(400).json({ error: 'deviceId required' });
    await upsertStatus(s);
    res.json({ ok: true });

    // Non-blocking from the ESP32's point of view - response already sent.
    analytics.updateFromStatus(s.deviceId, s).catch((err) => {
      console.error('[ANALYTICS] updateFromStatus failed:', err);
    });
  } catch (err) {
    console.error('[POST /api/status] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.post('/api/events', requireDeviceKey, async (req, res) => {
  try {
    const e = req.body;
    if (!e || !e.deviceId || !e.eventType) {
      return res.status(400).json({ error: 'deviceId and eventType required' });
    }
    const eventId = await insertEvent(e);
    res.json({ ok: true });

    // Everything below happens AFTER the ESP32 already has its 200 OK.
    // The local alarm (buzzer/RGB/OLED) already fired before this event
    // was even posted - nothing here is on that critical path.
    analytics.updateFromEvent(e.deviceId, e).catch((err) => {
      console.error('[ANALYTICS] updateFromEvent failed:', err);
    });

    if (NARRATIVE_EVENT_TYPES.has(e.eventType)) {
      enrichEventWithNarrative(eventId, e, e.deviceId).catch((err) => {
        console.error('[AI] enrichEventWithNarrative failed:', err);
      });
    }
  } catch (err) {
    console.error('[POST /api/events] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// --- dashboard -> backend ----------------------------------------------

app.get('/api/status', async (req, res) => {
  try {
    const deviceId = req.query.deviceId || DEFAULT_DEVICE_ID;
    const status = await getStatus(deviceId);
    res.json(status || null);
  } catch (err) {
    console.error('[GET /api/status] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/api/events', async (req, res) => {
  try {
    const deviceId = req.query.deviceId || DEFAULT_DEVICE_ID;
    const limitRaw = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 20;
    const events = await getEvents(deviceId, limit);
    res.json(events);
  } catch (err) {
    console.error('[GET /api/events] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Single event lookup - useful for polling "did the AI summary show up
// yet?" for one specific event without re-fetching the whole list.
app.get('/api/events/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const event = await getEventById(id);
    if (!event) return res.status(404).json({ error: 'not_found' });
    res.json(event);
  } catch (err) {
    console.error('[GET /api/events/:id] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Layer 1 output, human-facing: servo health, MQ-2 baseline drift, RFID
// reliability, connectivity, and rule-based notes. No AI involved in
// producing this - it's what the AI (and the dashboard) reads FROM.
app.get('/api/maintenance/:deviceId?', async (req, res) => {
  try {
    const deviceId = req.params.deviceId || req.query.deviceId || DEFAULT_DEVICE_ID;
    const status = await getStatus(deviceId);
    const summary = await analytics.buildMaintenanceSummary(deviceId, status);
    res.json(summary);
  } catch (err) {
    console.error('[GET /api/maintenance] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.post('/api/ai/chat', chatRateLimiter, async (req, res) => {
  try {
    const { question, deviceId } = req.body || {};
    if (!question || typeof question !== 'string') {
      return res.status(400).json({ error: 'question (string) required' });
    }
    const targetDevice = deviceId || DEFAULT_DEVICE_ID;

    const [status, events] = await Promise.all([
      getStatus(targetDevice),
      getEvents(targetDevice, 15),
    ]);
    const maintenance = await analytics.buildMaintenanceSummary(targetDevice, status);

    const answer = await chatWithSentinel({ question, status, events, maintenance });
    res.json({ answer });
  } catch (err) {
    console.error('[POST /api/ai/chat] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'sentinel-backend' });
});

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[SERVER] SENTINEL backend listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('[SERVER] Failed to initialize database - not starting.', err);
    process.exit(1);
  });
