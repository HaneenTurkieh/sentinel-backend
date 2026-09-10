SENTINEL BACKEND
=================

What this is
-------------
Node/Express API sitting between the ESP32 and everything else: Turso for
storage, an OpenAI-compatible AI provider (DeepSeek by default) for the
"Ask Sentinel" chat and incident narratives, and a dashboard that reads
from it. The ESP32 never talks to Turso or the AI provider directly - it
only knows this backend's URL and its own device API key.

Architecture (Stage 4)
------------------------
  ESP32 (deterministic - unaffected by any of this)
     |
     v
  Backend ingest (POST /api/status, POST /api/events)
     |
     v
  analytics.js  <- Layer 1: plain statistics, runs on every ping, no LLM.
     |             MQ-2 baseline drift, servo wear, RFID reliability,
     |             connectivity - written to device_maintenance.
     v
  ai.js  <- Layer 2, split in two:
     |        2a) the event is already saved and already visible to the
     |            dashboard the instant it's inserted - no AI in that path.
     |        2b) generateIncidentNarrative() runs AFTER that, in the
     |            background, only for critical event types, and only
     |            adds an explanation on top of an alert that already fired.
     v
  Dashboard (status, events + ai_summary, maintenance panel, chat)

The rule this preserves: **the ESP32 decides and alarms locally and
instantly; the backend records instantly; AI only ever explains,
afterward, and never gates anything safety-related.** A slow or failed AI
call changes nothing about whether an alert appears - it only changes how
soon the narrative text shows up next to an alert that's already there.

Routes
-------
  POST /api/status                          ESP32 -> backend, every ~5s. Requires X-Device-Key.
  POST /api/events                          ESP32 -> backend, immediately on state transitions. Requires X-Device-Key.
                                             For a set of critical event types, this also kicks off an async
                                             AI narrative in the background (see NARRATIVE_EVENT_TYPES in server.js) -
                                             this NEVER delays the response back to the ESP32.
  GET  /api/status?deviceId=sentinel-01              dashboard reads latest status
  GET  /api/events?deviceId=sentinel-01&limit=20     dashboard reads recent events (includes ai_summary once ready)
  GET  /api/events/:id                               single event lookup (e.g. to poll for its ai_summary)
  GET  /api/maintenance/:deviceId  (or ?deviceId=)   Layer 1 output: servo health, MQ-2 baseline drift,
                                                      RFID reliability, connectivity, rule-based notes
  POST /api/ai/chat     { "question": "...", "deviceId": "sentinel-01" } -> { "answer": "..." }
                        now also grounded in the maintenance summary, not just raw status/events

Local setup
------------
  npm install
  cp .env.example .env
  # then fill in .env - see below

  npm start
  # server listens on PORT (default 3000)

Turso setup (if you haven't already)
--------------------------------------
  npm install -g @turso/cli          # if you don't have the CLI yet
  turso auth login
  turso db create sentinel-db
  turso db show sentinel-db          # gives you TURSO_DATABASE_URL
  turso db tokens create sentinel-db # gives you TURSO_AUTH_TOKEN

Tables (and the new columns/migrations for Stage 4) are created
automatically on first run - see db.js. If you're upgrading an existing
deployment, just deploy this version and restart; the ALTER TABLE
migrations in initDb() are idempotent and safe to run against a database
that already has data in it.

.env values you must fill in
-------------------------------
  TURSO_DATABASE_URL   from `turso db show`
  TURSO_AUTH_TOKEN      from `turso db tokens create`
  DEVICE_API_KEY         any long random string - must match the ESP32
                          firmware's DEVICE_API_KEY constant EXACTLY
  AI_API_KEY              your DeepSeek (or OpenAI/Gemini) API key
  AI_BASE_URL / AI_MODEL  see the comments in .env.example - defaults to
                          DeepSeek, swap these two values to change provider

.env values that are optional (Layer 1 analytics tuning)
-------------------------------------------------------------
All of these have sane defaults baked into analytics.js and only need to
be set if you want to override them:

  MQ2_CLEAN_BASELINE       reference clean-air MQ-2 reading (default: 162,
                           matching the value you already measured)
  SERVO_RATED_CYCLES       assumed servo duty-cycle rating used for the
                           wear estimate (default: 30000 - a placeholder;
                           tune this against your SG90's actual datasheet
                           if you want a defensible number for judges)
  MQ2_BASELINE_EWMA_ALPHA  how fast the learned baseline adapts (default: 0.05)
  WIFI_RSSI_EWMA_ALPHA     how fast the RSSI trend adapts (default: 0.2)
  MQ2_DRIFT_ALERT_PCT      drift threshold before flagging recalibration (default: 20)
  STATUS_STALE_SECONDS     how long since the last status ping before a
                           device is considered offline (default: 20)

Never commit the real .env to GitHub. Only .env.example should be committed.

Deploying to Render
---------------------
  1. Push this folder to a GitHub repo (with .env in .gitignore, not committed).
  2. On Render: New -> Web Service -> connect the repo.
  3. Build command:  npm install
     Start command:  npm start
  4. Add every variable from .env as an Environment Variable in Render's
     dashboard (Render doesn't read your local .env file).
  5. Deploy. Render gives you a URL like https://sentinel-backend.onrender.com -
     that's the BACKEND_HOST value the ESP32 firmware needs.

Testing without hardware
--------------------------
You can exercise every route with curl before the ESP32 is even involved:

  curl -X POST http://localhost:3000/api/status \
    -H "Content-Type: application/json" \
    -H "X-Device-Key: YOUR_DEVICE_API_KEY" \
    -d '{"deviceId":"sentinel-01","temperature":24.8,"humidity":46,"pressure":1008,"mq2":162,"distance":128,"lockState":"locked","systemState":"normal","wifiRssi":-55,"servoCycles":3,"bootCount":1}'

  curl -X POST http://localhost:3000/api/events \
    -H "Content-Type: application/json" \
    -H "X-Device-Key: YOUR_DEVICE_API_KEY" \
    -d '{"deviceId":"sentinel-01","eventType":"unauthorized_rfid","rfidUid":"AB CD EF 12","temperature":24.7,"humidity":46,"pressure":1008,"mq2":165,"distance":42,"lockState":"locked","systemState":"security_alert"}'

  curl http://localhost:3000/api/status?deviceId=sentinel-01
  curl http://localhost:3000/api/events?deviceId=sentinel-01
  curl http://localhost:3000/api/maintenance/sentinel-01

  # Re-fetch a couple seconds after the unauthorized_rfid POST above to see
  # ai_summary populated once the background narrative finishes:
  curl http://localhost:3000/api/events?deviceId=sentinel-01&limit=1

  curl -X POST http://localhost:3000/api/ai/chat \
    -H "Content-Type: application/json" \
    -d '{"question":"Were there any unauthorized access attempts, and is any hardware due for maintenance?","deviceId":"sentinel-01"}'

What's NOT here yet
----------------------
The React dashboard (polls GET /api/status + GET /api/events every ~2s,
shows the "Ask Sentinel" chat box, and should now also poll GET
/api/maintenance for a health panel). This backend is what it talks to -
ask for the dashboard next once this is deployed and the curl tests above
return real data.
