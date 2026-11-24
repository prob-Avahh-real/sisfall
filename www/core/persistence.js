// Cross-session persistence: pure snapshot/restore for the agent's long-lived
// state — journal, personal baseline, symptom check-ins, staging evidence,
// policy, and session stats. Storage itself (localStorage / IndexedDB / file)
// belongs to the caller; this module only converts between live objects and
// JSON-safe data, so it stays deterministic and unit-testable like the rest
// of core/.
//
// Time model: agent timestamps use the per-session observation clock, which
// restarts near zero on every session. `tShiftSec` — wall-clock seconds
// elapsed since the snapshot was taken, supplied by the caller — is subtracted
// from every restored timestamp. Symptom decay, the staging evidence window,
// and policy cooldowns then resume exactly as if the session had continued.

import { FEATURE_KEYS } from './features.js';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const shift = (v, tShiftSec) => (typeof v === 'number' ? v - tShiftSec : v);

/** Plain-JSON snapshot of everything worth surviving a reload. */
export function snapshotAgent(agent) {
  const b = agent.baseline;
  const s = agent.stager;
  const y = agent.symptoms;
  const p = agent.policy;
  return {
    v: 1,
    journal: agent.journal.export(),
    baseline: {
      n: b.n,
      mean: { ...b.mean },
      m2: { ...b.m2 },
      var: { ...b.var },
      fast: { ...b.fast },
      fastInit: { ...b.fastInit },
      outsideHold: b.outsideHold,
      outsideRun: b.outsideRun,
    },
    symptoms: {
      latest: JSON.parse(JSON.stringify(y.latest ?? {})),
      history: (y.history ?? []).map((h) => ({ ...h })),
    },
    stager: {
      frames: s.frames,
      sums: {
        w: s._sumW, boost: s._sumBoost, lean: s._sumLean,
        leanSq: s._sumLeanSq, offset: s._sumOffset, offsetSq: s._sumOffsetSq,
      },
      records: s._records.map((r) => ({ ...r })),
      episodes: [...s.episodes],
      lastSymptoms: s.lastSymptoms ? JSON.parse(JSON.stringify(s.lastSymptoms)) : null,
      lastT: s.lastT,
    },
    policy: {
      state: p.state, since: p.since, recoveringUntil: p.recoveringUntil,
      lastActionAt: { ...p.lastActionAt }, lastReminderAt: { ...p.lastReminderAt },
    },
    stats: { ...agent.stats, episodes: [...agent.stats.episodes] },
    lastStage: agent._lastStage ?? null,
  };
}

/**
 * Restore a snapshot into a fresh agent. `tShiftSec` is subtracted from all
 * observation-clock timestamps (symptom check-ins, staging records/episodes,
 * policy timers, stats.startedAt) so decay windows and cooldowns resume
 * correctly. Journal entries keep their original t — they are historical
 * audit records, not live timers.
 *
 * Returns true on success; malformed snapshots are ignored (returns false)
 * rather than throwing — a corrupt store must never break a session.
 */
export function restoreAgent(agent, snapshot, { tShiftSec = 0 } = {}) {
  try {
    if (!snapshot || snapshot.v !== 1) return false;

    if (snapshot.journal?.entries) {
      agent.journal.entries = snapshot.journal.entries.map((e) => ({ ...e }));
      agent.journal._seq = agent.journal.entries.reduce((m, e) => Math.max(m, e.seq ?? 0), 0);
    }

    const b = snapshot.baseline;
    if (b) {
      agent.baseline.n = num(b.n);
      for (const key of FEATURE_KEYS) {
        agent.baseline.mean[key] = num(b.mean?.[key]);
        agent.baseline.m2[key] = num(b.m2?.[key]);
        agent.baseline.var[key] = num(b.var?.[key]);
        agent.baseline.fast[key] = num(b.fast?.[key]);
        agent.baseline.fastInit[key] = !!b.fastInit?.[key];
      }
      agent.baseline.outsideHold = num(b.outsideHold);
      agent.baseline.outsideRun = num(b.outsideRun);
    }

    const y = snapshot.symptoms;
    if (y) {
      agent.symptoms.latest = {};
      for (const [k, v] of Object.entries(y.latest ?? {})) {
        if (v && typeof v === 'object') {
          agent.symptoms.latest[k] = { ...v, t: shift(num(v.t), tShiftSec) };
        }
      }
      agent.symptoms.history = (y.history ?? []).map((h) => ({ ...h }));
    }

    const s = snapshot.stager;
    if (s) {
      agent.stager.frames = num(s.frames);
      const m = s.sums ?? {};
      agent.stager._sumW = num(m.w); agent.stager._sumBoost = num(m.boost);
      agent.stager._sumLean = num(m.lean); agent.stager._sumLeanSq = num(m.leanSq);
      agent.stager._sumOffset = num(m.offset); agent.stager._sumOffsetSq = num(m.offsetSq);
      agent.stager._records = (s.records ?? []).map((r) => ({ ...r, t: shift(num(r.t), tShiftSec) }));
      agent.stager.episodes = (s.episodes ?? []).map((t) => shift(num(t), tShiftSec));
      agent.stager.lastSymptoms = s.lastSymptoms ? JSON.parse(JSON.stringify(s.lastSymptoms)) : null;
      agent.stager.lastT = shift(num(s.lastT), tShiftSec);
    }

    const p = snapshot.policy;
    if (p) {
      agent.policy.state = typeof p.state === 'string' ? p.state : 'calibrating';
      agent.policy.since = shift(num(p.since), tShiftSec);
      agent.policy.recoveringUntil = shift(num(p.recoveringUntil), tShiftSec);
      agent.policy.lastActionAt = Object.fromEntries(
        Object.entries(p.lastActionAt ?? {}).map(([k, v]) => [k, shift(num(v), tShiftSec)])
      );
      agent.policy.lastReminderAt = Object.fromEntries(
        Object.entries(p.lastReminderAt ?? {}).map(([k, v]) => [k, shift(num(v), tShiftSec)])
      );
    }

    const st = snapshot.stats;
    if (st) {
      agent.stats.frames = num(st.frames);
      agent.stats.maxScore = num(st.maxScore);
      agent.stats.episodes = [...(st.episodes ?? [])];
      agent.stats.actionCounts = { ...(st.actionCounts ?? {}) };
      agent.stats.startedAt = shift(st.startedAt == null ? null : num(st.startedAt), tShiftSec);
    }
    if (snapshot.lastStage != null) agent._lastStage = snapshot.lastStage;
    return true;
  } catch {
    return false;
  }
}
