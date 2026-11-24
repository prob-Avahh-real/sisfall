// ReminderManager: tick 判定、daily dedupe、storage 持久化、训练中门控。
// ImuMapper gyro: gyroscope channel blends into lateralOffset proxy.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ReminderManager, REMINDER_KEYS } from '../core/reminders.js';
import { ImuMapper } from '../sources/imu.js';
import { parseImuPacket } from '../sources/web-bluetooth.js';
import { DEFAULT_CONFIG } from '../core/config.js';

function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    _map: m,
  };
}

test('training reminder fires once per day and persists fired-day', () => {
  const storage = fakeStorage();
  const fired = [];
  let clock = new Date('2026-01-01T08:59:00');
  const rm = new ReminderManager({
    storage,
    now: () => clock,
    onNotify: (kind) => fired.push(kind),
  });
  rm.setScheduleTime('09:00');
  rm.tick();
  assert.deepEqual(fired, []); // 08:59 not yet
  clock = new Date('2026-01-01T09:00:30');
  rm.tick();
  assert.deepEqual(fired, ['training']);
  rm.tick(); // same day — dedupe
  assert.equal(fired.length, 1);
  // reload from storage keeps fired-day
  const rm2 = new ReminderManager({ storage, now: () => clock, onNotify: () => {} });
  assert.equal(rm2.lastScheduleFired, rm.lastScheduleFired);
});

test('medication reminder fires per due time and persists doseFired', () => {
  const storage = fakeStorage();
  const fired = [];
  let clock = new Date('2026-01-01T08:00:30');
  const rm = new ReminderManager({
    storage,
    now: () => clock,
    onNotify: (kind) => fired.push(kind),
  });
  rm.setMedicationTimes(['08:00', '20:00']);
  rm.tick();
  assert.deepEqual(fired, ['medication']);
  rm.tick(); // same minute — no refire
  assert.equal(fired.length, 1);
  clock = new Date('2026-01-01T20:00:30');
  rm.tick();
  assert.equal(fired.length, 2);
  const raw = JSON.parse(storage.getItem(REMINDER_KEYS.doseFired));
  assert.ok(Object.keys(raw).length >= 2);
});

test('trainingActive suppresses training reminder but not medication', () => {
  const fired = [];
  const clock = new Date('2026-01-01T09:00:30');
  const rm = new ReminderManager({ now: () => clock, onNotify: (k) => fired.push(k) });
  rm.setScheduleTime('09:00');
  rm.setMedicationTimes(['09:00']);
  rm.tick({ trainingActive: true });
  assert.deepEqual(fired, ['medication']);
});

test('imu mapper: gyro contributes to lateralOffset proxy when accel is quiet', () => {
  const mapper = new ImuMapper(DEFAULT_CONFIG);
  // warmup: 30 quiet upright samples
  for (let i = 0; i < 40; i++) {
    const o = mapper.map({ t: i / 50, ax: 0, ay: 0, az: 1, gx: 0, gy: 0, gz: 0 });
    if (o) break;
  }
  // quiet accel + strong yaw rate -> gyro proxy should lift lateralOffset
  const quiet = mapper.map({ t: 1.0, ax: 0, ay: 0, az: 1, gx: 0, gy: 0, gz: 100 });
  const still = mapper.map({ t: 1.02, ax: 0, ay: 0, az: 1, gx: 0, gy: 0, gz: 0 });
  assert.ok(quiet.features.lateralOffset > 0.1, `gyro lateralOffset ${quiet.features.lateralOffset}`);
  assert.ok(still.features.lateralOffset >= 0);
  assert.equal(quiet.coverage.lateralOffset, 'proxy'); // honest label kept
});

test('ble packet parser reads 6-axis gyro when present', () => {
  // 12-byte packet: 3×i16 accel (g) + 3×i16 gyro (dps, /14.375)
  const buf = new ArrayBuffer(12);
  const dv = new DataView(buf);
  dv.setInt16(0, 4096, true);  // ax = 1 g
  dv.setInt16(2, 0, true);
  dv.setInt16(4, 0, true);
  dv.setInt16(6, 1437, true);  // gx = 100 dps
  dv.setInt16(8, 0, true);
  dv.setInt16(10, 0, true);
  const s = parseImuPacket(dv, { scale: 4096, gyroScale: 14.375 });
  assert.ok(Math.abs(s.ax - 1) < 1e-6);
  assert.ok(Math.abs(s.gx - 100) < 0.2); // 1437/14.375 = 99.91 dps
  // 6-byte packet: no gyro fields
  const dv2 = new DataView(new ArrayBuffer(6));
  dv2.setInt16(0, 4096, true);
  const s2 = parseImuPacket(dv2, { scale: 4096 });
  assert.equal(s2.gx, undefined);
});
