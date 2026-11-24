// Cross-session persistence: snapshot/restore round-trip keeps baseline,
// symptoms (with correct decay after tShiftSec), staging evidence, policy,
// stats, and the journal alive across "reloads".

import test from 'node:test';
import assert from 'node:assert/strict';
import { SisFallAgent } from '../core/agent.js';
import { snapshotAgent, restoreAgent } from '../core/persistence.js';
import { runScenario } from '../sources/sim.js';

function feed(agent, scenario = 'wobble', seconds = 20) {
  const { observations, checkins } = runScenario(scenario);
  for (const o of observations) {
    if (o.t > seconds) break;
    agent.ingest(o);
  }
  for (const c of checkins ?? []) {
    if (c.t <= seconds) agent.ingestCheckin(c.checkin ?? c);
  }
}

test('snapshot -> JSON -> restore round-trips agent state', () => {
  const a = new SisFallAgent();
  feed(a, 'wobble', 25);
  a.ingestCheckin({ t: 20, symptom: 'dizziness', severity: 0.8 });

  const snap = JSON.parse(JSON.stringify(snapshotAgent(a)));
  const b = new SisFallAgent();
  assert.equal(restoreAgent(b, snap, { tShiftSec: 0 }), true);

  // journal survives
  assert.ok(b.journal.size >= a.journal.size - 1);
  // baseline warm state survives
  assert.equal(b.baseline.n, a.baseline.n);
  assert.equal(b.baseline.warm, a.baseline.warm);
  // symptoms survive with level intact at zero shift
  assert.ok(b.symptoms.latest.dizziness, 'dizziness check-in restored');
  // staging evidence survives
  assert.ok(b.stager.frames > 0);
  assert.ok(b.stager._records.length > 0);
});

test('tShiftSec decays restored symptoms correctly', () => {
  const a = new SisFallAgent();
  a.ingestCheckin({ t: 0, symptom: 'dizziness', severity: 1 });
  const snap = snapshotAgent(a);

  const fresh = new SisFallAgent();
  restoreAgent(fresh, snap, { tShiftSec: 0 });
  const decayed = new SisFallAgent();
  // dizziness half-life is 10 min = 600 s; shift by one half-life
  restoreAgent(decayed, snap, { tShiftSec: 600 });

  const lf = fresh.symptoms.at(0).levels.dizziness;
  const ld = decayed.symptoms.at(0).levels.dizziness;
  assert.ok(lf > 0.9, `fresh level ${lf}`);
  assert.ok(ld > 0.4 && ld < 0.6, `one-half-life level ${ld}`);
});

test('corrupt or foreign snapshots are ignored safely', () => {
  const a = new SisFallAgent();
  assert.equal(restoreAgent(a, null), false);
  assert.equal(restoreAgent(a, { v: 999 }), false);
  assert.equal(restoreAgent(a, 'garbage'), false);
  assert.equal(restoreAgent(a, { v: 1, baseline: { n: 'x' } }), true); // tolerant fill
});
