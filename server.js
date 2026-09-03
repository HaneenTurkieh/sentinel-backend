// server.js - SENTINEL backend entry point.

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const { initDb, upsertStatus, insertEvent, getStatus, getEvents } = require('./db');
const { chatWithSentinel } = require('./ai');

const app = express();
app.use(cors());
app.use(express.json());

const DEVICE_API_KEY = process.env.DEVICE_API_KEY;
const DEFAULT_DEVICE_ID = 'sentinel-01';

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

// --- ESP32 -> backend -------------------------------------------------

app.post('/api/status', requireDeviceKey, async (req, res) => {
  try {
    const s = req.body;
    if (!s || !s.deviceId) return res.status(400).json({ error: 'deviceId required' });
    await upsertStatus(s);
    res.json({ ok: true });
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
    await insertEvent(e);
    res.json({ ok: true });
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

app.post('/api/ai/chat', async (req, res) => {
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

    const answer = await chatWithSentinel({ question, status, events });
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
