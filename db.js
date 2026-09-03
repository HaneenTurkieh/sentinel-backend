// db.js - Turso (libSQL) client, table setup, and query helpers.

const { createClient } = require('@libsql/client');

if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
  console.warn('[DB] WARNING: TURSO_DATABASE_URL or TURSO_AUTH_TOKEN is not set. ' +
    'Requests to the database will fail until .env is filled in.');
}

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function initDb() {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      rfid_uid TEXT,
      temperature REAL,
      humidity REAL,
      pressure REAL,
      mq2 INTEGER,
      distance REAL,
      lock_state TEXT,
      system_state TEXT,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS device_status (
      device_id TEXT PRIMARY KEY,
      temperature REAL,
      humidity REAL,
      pressure REAL,
      mq2 INTEGER,
      distance REAL,
      lock_state TEXT,
      system_state TEXT,
      wifi_rssi INTEGER,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  console.log('[DB] Tables ready.');
}

// Upsert = insert, or update in place if this device_id already has a row.
// device_status only ever holds ONE row per device (the latest snapshot).
async function upsertStatus(s) {
  await client.execute({
    sql: `
      INSERT INTO device_status
        (device_id, temperature, humidity, pressure, mq2, distance, lock_state, system_state, wifi_rssi, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(device_id) DO UPDATE SET
        temperature = excluded.temperature,
        humidity = excluded.humidity,
        pressure = excluded.pressure,
        mq2 = excluded.mq2,
        distance = excluded.distance,
        lock_state = excluded.lock_state,
        system_state = excluded.system_state,
        wifi_rssi = excluded.wifi_rssi,
        updated_at = CURRENT_TIMESTAMP
    `,
    args: [
      s.deviceId,
      s.temperature ?? null,
      s.humidity ?? null,
      s.pressure ?? null,
      s.mq2 ?? null,
      s.distance ?? null,
      s.lockState ?? null,
      s.systemState ?? null,
      s.wifiRssi ?? null,
    ],
  });
}

async function insertEvent(e) {
  await client.execute({
    sql: `
      INSERT INTO events
        (device_id, event_type, rfid_uid, temperature, humidity, pressure, mq2, distance, lock_state, system_state, details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      e.deviceId,
      e.eventType,
      e.rfidUid ?? null,
      e.temperature ?? null,
      e.humidity ?? null,
      e.pressure ?? null,
      e.mq2 ?? null,
      e.distance ?? null,
      e.lockState ?? null,
      e.systemState ?? null,
      e.details ?? null,
    ],
  });
}

async function getStatus(deviceId) {
  const rs = await client.execute({
    sql: `SELECT * FROM device_status WHERE device_id = ? LIMIT 1`,
    args: [deviceId],
  });
  return rs.rows[0] || null;
}

async function getEvents(deviceId, limit) {
  const rs = await client.execute({
    sql: `SELECT * FROM events WHERE device_id = ? ORDER BY id DESC LIMIT ?`,
    args: [deviceId, limit],
  });
  return rs.rows;
}

module.exports = { initDb, upsertStatus, insertEvent, getStatus, getEvents };
