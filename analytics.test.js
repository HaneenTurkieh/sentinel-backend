// analytics.test.js - unit tests for the Layer 1 analytics engine.
// Run with: node --test
//
// analytics.js talks to db.js for storage. Rather than hitting a real
// database, each test substitutes a tiny in-memory test double for
// db.js's exports before requiring analytics.js fresh, so these run
// instantly with no environment variables, network, or Turso needed.

const test = require('node:test');
const assert = require('node:assert/strict');

function loadAnalyticsWithFakeDb() {
  const store = {};
  const fakeDb = {
    async getMaintenance(deviceId) { return store[deviceId] || null; },
    async upsertMaintenance(deviceId, fields) {
      store[deviceId] = { ...(store[deviceId] || {}), ...fields };
    },
  };
  const dbPath = require.resolve('./db.js');
  const analyticsPath = require.resolve('./analytics.js');
  delete require.cache[analyticsPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };
  const analytics = require('./analytics.js');
  return { analytics, store };
}

test('MQ-2 baseline ignores a reading taken during a danger spike', async () => {
  const { analytics, store } = loadAnalyticsWithFakeDb();
  await analytics.updateFromStatus('dev1', { systemState: 'normal', mq2: 162 });
  const baselineBefore = store.dev1.mq2_baseline;

  await analytics.updateFromStatus('dev1', { systemState: 'danger', mq2: 500 });

  assert.equal(store.dev1.mq2_baseline, baselineBefore,
    'a danger-state reading must not drag the clean-air baseline around');
});

test('MQ-2 baseline drifts toward sustained new clean-air readings', async () => {
  const { analytics, store } = loadAnalyticsWithFakeDb();
  for (let i = 0; i < 50; i++) {
    await analytics.updateFromStatus('dev1', { systemState: 'normal', mq2: 210 });
  }
  assert.ok(store.dev1.mq2_baseline > 190,
    'baseline should have drifted up toward the sustained 210 readings');
});

test('servo health percentage decreases as cycle count rises', async () => {
  const { analytics, store } = loadAnalyticsWithFakeDb();
  await analytics.updateFromStatus('dev1', { systemState: 'normal', servoCycles: 0 });
  const freshHealth = store.dev1.servo_health_pct;

  await analytics.updateFromStatus('dev1', { systemState: 'normal', servoCycles: 25000 });
  const wornHealth = store.dev1.servo_health_pct;

  assert.ok(wornHealth < freshHealth, 'servo health should drop as cycles accumulate');
});

test('RFID failure rate is computed from authorized vs unauthorized events', async () => {
  const { analytics, store } = loadAnalyticsWithFakeDb();
  await analytics.updateFromEvent('dev1', { eventType: 'authorized_rfid' });
  await analytics.updateFromEvent('dev1', { eventType: 'unauthorized_rfid' });
  await analytics.updateFromEvent('dev1', { eventType: 'unauthorized_rfid' });

  assert.equal(store.dev1.rfid_failure_rate_pct, (2 / 3) * 100);
});

test('buildMaintenanceSummary flags a non-power-on reset reason', async () => {
  const { analytics } = loadAnalyticsWithFakeDb();
  await analytics.updateFromEvent('dev1', {
    eventType: 'system_started',
    details: JSON.stringify({ resetReason: 'brownout', bootCount: 3, servoCycles: 10 }),
  });

  const summary = await analytics.buildMaintenanceSummary('dev1', null);

  assert.ok(summary.notes.some((n) => n.includes('brownout')),
    'a brownout reset reason should surface as a maintenance note');
});

test('buildMaintenanceSummary reports offline when status is stale', async () => {
  const { analytics } = loadAnalyticsWithFakeDb();
  const staleTimestamp = new Date(Date.now() - 5 * 60 * 1000) // 5 minutes ago
    .toISOString().slice(0, 19).replace('T', ' ');

  const summary = await analytics.buildMaintenanceSummary('dev1', { updated_at: staleTimestamp });

  assert.equal(summary.connectivity, 'stale_or_offline');
});
