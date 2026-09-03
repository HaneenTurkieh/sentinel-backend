SENTINEL BACKEND
=================

What this is
-------------
Node/Express API sitting between the ESP32 and everything else: Turso for
storage, an OpenAI-compatible AI provider (DeepSeek by default) for the
"Ask Sentinel" chat, and a dashboard that reads from it. The ESP32 never
talks to Turso or the AI provider directly - it only knows this backend's
URL and its own device API key, exactly per the frozen spec.

Routes
-------
  POST /api/status     ESP32 -> backend, every ~5s. Requires X-Device-Key header.
  POST /api/events      ESP32 -> backend, immediately on state transitions. Requires X-Device-Key header.
  GET  /api/status?deviceId=sentinel-01     dashboard reads latest status
  GET  /api/events?deviceId=sentinel-01&limit=20     dashboard reads recent events
  POST /api/ai/chat     { "question": "...", "deviceId": "sentinel-01" } -> { "answer": "..." }

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

Tables are created automatically on first run (see db.js) - you don't need
to run any SQL by hand.

.env values you must fill in
-------------------------------
  TURSO_DATABASE_URL   from `turso db show`
  TURSO_AUTH_TOKEN      from `turso db tokens create`
  DEVICE_API_KEY         any long random string - must match the ESP32
                          firmware's DEVICE_API_KEY constant EXACTLY
  AI_API_KEY              your DeepSeek (or OpenAI/Gemini) API key
  AI_BASE_URL / AI_MODEL  see the comments in .env.example - defaults to
                          DeepSeek, swap these two values to change provider

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
    -d '{"deviceId":"sentinel-01","temperature":24.8,"humidity":46,"pressure":1008,"mq2":162,"distance":128,"lockState":"locked","systemState":"normal","wifiRssi":-55}'

  curl -X POST http://localhost:3000/api/events \
    -H "Content-Type: application/json" \
    -H "X-Device-Key: YOUR_DEVICE_API_KEY" \
    -d '{"deviceId":"sentinel-01","eventType":"unauthorized_rfid","rfidUid":"AB CD EF 12","temperature":24.7,"humidity":46,"pressure":1008,"mq2":165,"distance":42,"lockState":"locked","systemState":"security_alert"}'

  curl http://localhost:3000/api/status?deviceId=sentinel-01
  curl http://localhost:3000/api/events?deviceId=sentinel-01

  curl -X POST http://localhost:3000/api/ai/chat \
    -H "Content-Type: application/json" \
    -d '{"question":"Were there any unauthorized access attempts?","deviceId":"sentinel-01"}'

What's NOT here yet
----------------------
The React dashboard (polls GET /api/status + GET /api/events every ~2s,
shows the "Ask Sentinel" chat box). This backend is what it talks to - ask
for the dashboard next once this is deployed and the curl tests above
return real data.
