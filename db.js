// db.js - Turso (libSQL) client, table setup, and query helpers.
//
// CHANGES FROM THE ORIGINAL:
//  - events table gains an `ai_summary` column (added via migration, so
//    this is safe to run against an existing database) - this is where
//    the async Layer 2b narrative gets written once it's ready, without
//    ever delaying the original insert/response to the ESP32.
//  - insertEvent() now returns the new row's id, so the caller can go
//    back and attach an ai_summary to that specific row later.
//  - new device_maintenance table + helpers, written to by analytics.js
//    (the Layer 1 analytics engine) - servo wear, MQ-2 baseline drift,
//    RFID reliability, connectivity.

const { createClient } = require('@libsql/client');

if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
  console.warn('[DB] WARNING: TURSO_DATABASE_URL or TURSO_AUTH_TOKEN is not set. ' +
    'Requests to the database will fail until .env is filled in.');
}

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function addColumnIfMissing(table, columnDef) {
  try {
    await client.execute(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
  } catch (err) {
    // SQLite/libSQL throws when the column already exists - that's the
    // expected, idempotent case on every restart after the first one.
    const msg = String(err && err.message ? err.message : err);
    if (!/duplicate column name/i.test(msg)) {
      throw err;
    }
  }
}

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

  // Migration: older databases created before this column existed.
  await addColumnIfMissing('events', 'ai_summary TEXT');

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
      servo_cycles INTEGER,
      boot_count INTEGER,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Migrations for status columns added after the original schema.
  await addColumnIfMissing('device_status', 'servo_cycles INTEGER');
  await addColumnIfMissing('device_status', 'boot_count INTEGER');

  // Layer 1 analytics output - one row per device, continuously updated.
  // This is NOT raw sensor data - it's the derived health/trend signals
  // that the analytics engine computes, and what the LLM layer and the
  // dashboard's maintenance panel read from.
  await client.execute(`
    CREATE TABLE IF NOT EXISTS device_maintenance (
      device_id TEXT PRIMARY KEY,
      mq2_baseline REAL,
      mq2_baseline_drift_pct REAL,
      servo_cycles INTEGER,
      servo_health_pct REAL,
      rfid_authorized_count INTEGER DEFAULT 0,
      rfid_unauthorized_count INTEGER DEFAULT 0,
      rfid_failure_rate_pct REAL,
      wifi_rssi_ewma REAL,
      last_reset_reason TEXT,
      boot_count INTEGER,
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
        (device_id, temperature, humidity, pressure, mq2, distance, lock_state, system_state, wifi_rssi, servo_cycles, boot_count, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(device_id) DO UPDATE SET
        temperature = excluded.temperature,
        humidity = excluded.humidity,
        pressure = excluded.pressure,
        mq2 = excluded.mq2,
        distance = excluded.distance,
        lock_state = excluded.lock_state,
        system_state = excluded.system_state,
        wifi_rssi = excluded.wifi_rssi,
        servo_cycles = excluded.servo_cycles,
        boot_count = excluded.boot_count,
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
      s.servoCycles ?? null,
      s.bootCount ?? null,
    ],
  });
}

// Returns the new row's id (Number), so the caller can attach an
// ai_summary to this exact event once the async narrative is ready.
async function insertEvent(e) {
  const rs = await client.execute({
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
  return Number(rs.lastInsertRowid);
}

async function updateEventSummary(eventId, summary) {
  await client.execute({
    sql: `UPDATE events SET ai_summary = ? WHERE id = ?`,
    args: [summary, eventId],
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

async function getEventById(eventId) {
  const rs = await client.execute({
    sql: `SELECT * FROM events WHERE id = ? LIMIT 1`,
    args: [eventId],
  });
  return rs.rows[0] || null;
}

// Maintenance / Layer 1 analytics -----------------------------------------

async function getMaintenance(deviceId) {
  const rs = await client.execute({
    sql: `SELECT * FROM device_maintenance WHERE device_id = ? LIMIT 1`,
    args: [deviceId],
  });
  return rs.rows[0] || null;
}

// Partial upsert: only overwrites the fields actually passed in `fields`,
// so analytics.js can update, say, just the MQ-2 baseline without having
// to know or re-supply every other maintenance column.
async function upsertMaintenance(deviceId, fields) {
  const existing = await getMaintenance(deviceId);
  const merged = {
    mq2_baseline: fields.mq2_baseline ?? existing?.mq2_baseline ?? null,
    mq2_baseline_drift_pct: fields.mq2_baseline_drift_pct ?? existing?.mq2_baseline_drift_pct ?? null,
    servo_cycles: fields.servo_cycles ?? existing?.servo_cycles ?? null,
    servo_health_pct: fields.servo_health_pct ?? existing?.servo_health_pct ?? null,
    rfid_authorized_count: fields.rfid_authorized_count ?? existing?.rfid_authorized_count ?? 0,
    rfid_unauthorized_count: fields.rfid_unauthorized_count ?? existing?.rfid_unauthorized_count ?? 0,
    rfid_failure_rate_pct: fields.rfid_failure_rate_pct ?? existing?.rfid_failure_rate_pct ?? null,
    wifi_rssi_ewma: fields.wifi_rssi_ewma ?? existing?.wifi_rssi_ewma ?? null,
    last_reset_reason: fields.last_reset_reason ?? existing?.last_reset_reason ?? null,
    boot_count: fields.boot_count ?? existing?.boot_count ?? null,
  };

  await client.execute({
    sql: `
      INSERT INTO device_maintenance
        (device_id, mq2_baseline, mq2_baseline_drift_pct, servo_cycles, servo_health_pct,
         rfid_authorized_count, rfid_unauthorized_count, rfid_failure_rate_pct,
         wifi_rssi_ewma, last_reset_reason, boot_count, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(device_id) DO UPDATE SET
        mq2_baseline = excluded.mq2_baseline,
        mq2_baseline_drift_pct = excluded.mq2_baseline_drift_pct,
        servo_cycles = excluded.servo_cycles,
        servo_health_pct = excluded.servo_health_pct,
        rfid_authorized_count = excluded.rfid_authorized_count,
        rfid_unauthorized_count = excluded.rfid_unauthorized_count,
        rfid_failure_rate_pct = excluded.rfid_failure_rate_pct,
        wifi_rssi_ewma = excluded.wifi_rssi_ewma,
        last_reset_reason = excluded.last_reset_reason,
        boot_count = excluded.boot_count,
        updated_at = CURRENT_TIMESTAMP
    `,
    args: [
      deviceId,
      merged.mq2_baseline,
      merged.mq2_baseline_drift_pct,
      merged.servo_cycles,
      merged.servo_health_pct,
      merged.rfid_authorized_count,
      merged.rfid_unauthorized_count,
      merged.rfid_failure_rate_pct,
      merged.wifi_rssi_ewma,
      merged.last_reset_reason,
      merged.boot_count,
    ],
  });
}

module.exports = {
  initDb,
  upsertStatus,
  insertEvent,
  updateEventSummary,
  getStatus,
  getEvents,
  getEventById,
  getMaintenance,
  upsertMaintenance,
};
