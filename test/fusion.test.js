// ObservationFusion: per-feature source selection, freshness honesty,
// emit throttling, coverage recompute.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ObservationFusion } from '../sources/fusion.js';
import { FEATURE_KEYS } from '../core/features.js';
import { measuredCoverage, normalizeCoverage } from '../core/features.js';
import { DEFAULT_CONFIG } from '../core/config.js';

const cov = (over = {}) => ({ ...measuredCoverage(), ...over });
const obs = (t, features = {}, coverage = cov(), extra = {}) => ({
  t, features: { torsoLean: 0, lateralOffset: 0, hipDropSpeed: 0, kneeAsymmetry: 0, ...features },
  coverage, ...extra,
});

test('pose wins measured features; imu fills what pose lacks', () => {
  const out = [];
  const f = new ObservationFusion({ onObservation: (o) => out.push(o), minIntervalSec: 0 });
  f.push('imu', obs(1.0, { torsoLean: 10, lateralOffset: 0.5, hipDropSpeed: 0.4, kneeAsymmetry: 0 },
    cov({ kneeAsymmetry: 'unavailable' })));
  f.push('pose', obs(1.0, { torsoLean: 20, lateralOffset: 0.7, hipDropSpeed: 0.9, kneeAsymmetry: 0.3 }));
  const m = out.at(-1);
  assert.equal(m.features.torsoLean, 20);       // pose first in defaultPriority
  assert.equal(m.features.lateralOffset, 0.7);
  assert.equal(m.features.kneeAsymmetry, 0.3);  // only pose has it
  assert.equal(m.coverage.kneeAsymmetry, 'measured');
});

test('imu fills in when pose observation is stale', () => {
  const out = [];
  const f = new ObservationFusion({ onObservation: (o) => out.push(o), minIntervalSec: 0, staleMs: 500 });
  f.push('pose', obs(1.0, { kneeAsymmetry: 0.5 }));
  // 2s later (>500ms stale): pose kneeAsymmetry must be unavailable
  f.push('imu', obs(3.0, { torsoLean: 15 }, cov({ kneeAsymmetry: 'unavailable' })));
  const m = out.at(-1);
  assert.equal(m.coverage.kneeAsymmetry, 'unavailable');
  assert.equal(m.features.torsoLean, 15);
});

test('proxy coverage beats unavailable but loses to measured', () => {
  const out = [];
  const f = new ObservationFusion({ onObservation: (o) => out.push(o), minIntervalSec: 0 });
  const imuCov = cov({ lateralOffset: 'proxy', hipDropSpeed: 'proxy', kneeAsymmetry: 'unavailable' });
  f.push('imu', obs(1.0, { lateralOffset: 0.4, hipDropSpeed: 0.6 }, imuCov));
  f.push('pose', obs(1.0, { lateralOffset: 0.9, hipDropSpeed: 0.2 })); // all measured
  const m = out.at(-1);
  assert.equal(m.features.lateralOffset, 0.9);  // measured pose beats proxy imu
  assert.equal(m.coverage.lateralOffset, 'measured');
});

test('minIntervalSec throttles emission; cached obs still refresh merge', () => {
  const out = [];
  const f = new ObservationFusion({ onObservation: (o) => out.push(o), minIntervalSec: 0.1 });
  f.push('pose', obs(1.00, { torsoLean: 5 }));
  f.push('imu', obs(1.02, { torsoLean: 50 }));   // within interval -> no emit, but cached
  f.push('imu', obs(1.15, { torsoLean: 50 }));   // past interval -> emit, pose still fresh
  assert.equal(out.length, 2);
  const m = out[1];
  assert.equal(m.t, 1.15);
  assert.equal(m.features.torsoLean, 5); // pose (priority) still wins — cached value used
});

test('per-feature priority override respected', () => {
  const out = [];
  const f = new ObservationFusion({
    onObservation: (o) => out.push(o),
    minIntervalSec: 0,
    priority: { hipDropSpeed: ['imu', 'pose'] },
  });
  f.push('pose', obs(1.0, { hipDropSpeed: 0.1 }));
  f.push('imu', obs(1.0, { hipDropSpeed: 0.8 }, cov({ hipDropSpeed: 'proxy' })));
  const m = out.at(-1);
  assert.equal(m.features.hipDropSpeed, 0.8); // imu preferred for this feature
  assert.equal(m.coverage.hipDropSpeed, 'proxy');
});

test('all-unavailable features degrade honestly', () => {
  const out = [];
  const f = new ObservationFusion({ onObservation: (o) => out.push(o), minIntervalSec: 0 });
  const unavail = normalizeCoverage({});
  f.push('imu', obs(1.0, {}, unavail));
  const m = out.at(-1);
  for (const k of FEATURE_KEYS) assert.equal(m.coverage[k], 'unavailable');
});
