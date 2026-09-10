// analytics.js - Layer 1: the "real AI/ML" layer.
//
// This is plain statistics, not an LLM call - it runs on every single
// status ping and event, continuously, whether or not anyone ever opens
// the dashboard or asks the chat a question. It turns raw sensor numbers
// into the structured signals that:
//   (a) the LLM layer (ai.js) explains in natural language, and
//   (b) the dashboard's maintenance panel reads directly, with no AI
//       involved at all.
//
// Nothing here ever touches hardware or thresholds on the ESP32. It only
// ever writes to device_maintenance. If a human decides, from this data,
// that MQ2_WARNING_ENTER should change, that's a manual firmware update -
// exactly per the "ESP32 decides" rule.

const { getMaintenance, upsertMaintenance } = require('./db');

// --- Tunable assumptions -------------------------------------------------
// These are reasonable starting points for a prototype/competition entry,
// not verified datasheet numbers. Calibrate SERVO_RATED_CYCLES against
// your actual SG90's rated duty cycle if you want a defensible number to
// quote to judges; the default here is a placeholder order-of-magnitude
// estimate for a hobby micro servo, not a spec.
const MQ2_CLEAN_BASELINE = Number(process.env.MQ2_CLEAN_BASELINE || 162);
const SERVO_RATED_CYCLES = Number(process.env.SERVO_RATED_CYCLES || 30000);
const MQ2_BASELINE_EWMA_ALPHA = Number(process.env.MQ2_BASELINE_EWMA_ALPHA || 0.05);
const WIFI_RSSI_EWMA_ALPHA = Number(process.env.WIFI_RSSI_EWMA_ALPHA || 0.2);
// How far the learned baseline has to drift from the reference before
// it's worth flagging as "this sensor may need recalibration."
const MQ2_DRIFT_ALERT_PCT = Number(process.env.MQ2_DRIFT_ALERT_PCT || 20);
// How stale a status ping has to be before a device counts as offline,
// given the ESP32 posts roughly every 5s (see STATUS_POST_INTERVAL_MS).
const STATUS_STALE_SECONDS = Number(process.env.STATUS_STALE_SECONDS || 20);

function ewma(previous, sample, alpha) {
  if (previous === null || previous === undefined || Number.isNaN(previous)) return sample;
  return alpha * sample + (1 - alpha) * previous;
}

// Called on every POST /api/status from the ESP32.
async function updateFromStatus(deviceId, status) {
  const existing = await getMaintenance(deviceId);

  const fields = {};

  // Only let genuinely clean-air readings pull the baseline - don't let a
  // warning/danger spike drag the "normal" baseline around.
  if (status.systemState === 'normal' && typeof status.mq2 === 'number') {
    const newBaseline = ewma(existing?.mq2_baseline, status.mq2, MQ2_BASELINE_EWMA_ALPHA);
    fields.mq2_baseline = newBaseline;
    fields.mq2_baseline_drift_pct = ((newBaseline - MQ2_CLEAN_BASELINE) / MQ2_CLEAN_BASELINE) * 100;
  }

  if (typeof status.servoCycles === 'number') {
    fields.servo_cycles = status.servoCycles;
    fields.servo_health_pct = Math.max(0, 100 - (status.servoCycles / SERVO_RATED_CYCLES) * 100);
  }

  if (typeof status.wifiRssi === 'number') {
    fields.wifi_rssi_ewma = ewma(existing?.wifi_rssi_ewma, status.wifiRssi, WIFI_RSSI_EWMA_ALPHA);
  }

  if (typeof status.bootCount === 'number') {
    fields.boot_count = status.bootCount;
  }

  if (Object.keys(fields).length > 0) {
    await upsertMaintenance(deviceId, fields);
  }
}

// Called on every POST /api/events from the ESP32.
async function updateFromEvent(deviceId, event) {
  const existing = await getMaintenance(deviceId);
  const fields = {};

  if (event.eventType === 'authorized_rfid' || event.eventType === 'unauthorized_rfid') {
    const authorizedCount = (existing?.rfid_authorized_count || 0) + (event.eventType === 'authorized_rfid' ? 1 : 0);
    const unauthorizedCount = (existing?.rfid_unauthorized_count || 0) + (event.eventType === 'unauthorized_rfid' ? 1 : 0);
    const total = authorizedCount + unauthorizedCount;

    fields.rfid_authorized_count = authorizedCount;
    fields.rfid_unauthorized_count = unauthorizedCount;
    fields.rfid_failure_rate_pct = total > 0 ? (unauthorizedCount / total) * 100 : 0;
  }

  if (event.eventType === 'system_started' && event.details) {
    try {
      const parsed = JSON.parse(event.details);
      if (parsed.resetReason) fields.last_reset_reason = parsed.resetReason;
      if (typeof parsed.bootCount === 'number') fields.boot_count = parsed.bootCount;
      if (typeof parsed.servoCycles === 'number') {
        fields.servo_cycles = parsed.servoCycles;
        fields.servo_health_pct = Math.max(0, 100 - (parsed.servoCycles / SERVO_RATED_CYCLES) * 100);
      }
    } catch (_err) {
      // details wasn't JSON - ignore, nothing to extract.
    }
  }

  if (Object.keys(fields).length > 0) {
    await upsertMaintenance(deviceId, fields);
  }
}

// Builds the human-facing maintenance summary: the maintenance table's
// stored numbers, plus rule-based notes and a connectivity read computed
// fresh from the latest status timestamp. This is what both the
// dashboard's maintenance panel and the LLM chat/incident-report layer
// consume - it's the boundary between "real analytics" and "AI prose."
async function buildMaintenanceSummary(deviceId, latestStatus) {
  const m = await getMaintenance(deviceId);
  const notes = [];

  let connectivity = 'unknown';
  let lastSeenSecondsAgo = null;
  if (latestStatus && latestStatus.updated_at) {
    const updatedAtMs = new Date(latestStatus.updated_at.replace(' ', 'T') + 'Z').getTime();
    lastSeenSecondsAgo = Math.round((Date.now() - updatedAtMs) / 1000);
    connectivity = lastSeenSecondsAgo <= STATUS_STALE_SECONDS ? 'online' : 'stale_or_offline';
    if (connectivity === 'stale_or_offline') {
      notes.push(`No status update in ${lastSeenSecondsAgo}s - device may be offline or Wi-Fi may be down (local safety logic is unaffected either way).`);
    }
  }

  if (m?.mq2_baseline_drift_pct != null && Math.abs(m.mq2_baseline_drift_pct) >= MQ2_DRIFT_ALERT_PCT) {
    const direction = m.mq2_baseline_drift_pct > 0 ? 'higher' : 'lower';
    notes.push(`MQ-2 clean-air baseline has drifted ${Math.abs(m.mq2_baseline_drift_pct).toFixed(1)}% ${direction} than the ${MQ2_CLEAN_BASELINE} reference - consider recalibrating (section 10 of the spec) or checking for sensor contamination.`);
  }

  if (m?.servo_health_pct != null && m.servo_health_pct <= 20) {
    notes.push(`Servo estimated at ${m.servo_health_pct.toFixed(1)}% of assumed rated life (${m.servo_cycles} cycles against an assumed ${SERVO_RATED_CYCLES}-cycle rating) - consider having a spare on hand.`);
  }

  if (m?.rfid_failure_rate_pct != null && m.rfid_failure_rate_pct >= 50 && (m.rfid_authorized_count + m.rfid_unauthorized_count) >= 5) {
    notes.push(`${m.rfid_failure_rate_pct.toFixed(0)}% of recent RFID scans have been unauthorized/failed reads - could be attempted access, or could be antenna/module reliability. Worth reviewing recent events.`);
  }

  if (m?.last_reset_reason && m.last_reset_reason !== 'power_on' && m.last_reset_reason !== 'external_reset') {
    notes.push(`Last boot was caused by "${m.last_reset_reason}", not a normal power-on - if this repeats, check the power supply and wiring for brownouts.`);
  }

  return {
    connectivity,
    lastSeenSecondsAgo,
    mq2Baseline: m?.mq2_baseline ?? null,
    mq2BaselineDriftPct: m?.mq2_baseline_drift_pct ?? null,
    servoCycles: m?.servo_cycles ?? null,
    servoHealthPct: m?.servo_health_pct ?? null,
    rfidAuthorizedCount: m?.rfid_authorized_count ?? 0,
    rfidUnauthorizedCount: m?.rfid_unauthorized_count ?? 0,
    rfidFailureRatePct: m?.rfid_failure_rate_pct ?? null,
    wifiRssiEwma: m?.wifi_rssi_ewma ?? null,
    lastResetReason: m?.last_reset_reason ?? null,
    bootCount: m?.boot_count ?? null,
    notes,
  };
}

module.exports = { updateFromStatus, updateFromEvent, buildMaintenanceSummary };
