// 传感器融合：把两个 canonical observation 源（默认 pose=相机、imu=手机/手环）
// 合并成一条 observation 喂给 agent。
//
// 设计（全部规则可测、可配置）：
//   - 每个 feature 独立择优：沿 config.fusion.priority 中该 feature 的源顺序，
//     取第一个 coverage 非 'unavailable' 且观测新鲜（age <= staleMs）的源。
//   - 输出由高频源节流驱动：minIntervalSec 内的 push 只刷新缓存不重复发射，
//     避免双源叠加把 baseline 帧率/预热语义冲淡。
//   - 诚实 coverage：对端源观测过期（超出 staleMs）时其 feature 按
//     'unavailable' 处理——绝不把过期读数当新数据。
//   - t/context/debug 取本次发射的那条 observation；feature 值可跨源拼接
//     （每个 feature 仍来自单一源，无混合计算）。

import { FEATURE_KEYS, normalizeCoverage } from '../core/features.js';
import { DEFAULT_CONFIG } from '../core/config.js';

export class ObservationFusion {
  /**
   * @param {object} opts
   * @param {(observation) => void} opts.onObservation  融合输出回调
   * @param {number} opts.staleMs      对端缓存有效期（毫秒，按 observation.t 比较前换算见下）
   * @param {number} opts.minIntervalSec 最小发射间隔（秒）
   * @param {object} opts.priority     { feature: [sourceName, ...] } 覆盖默认
   * @param {object} opts.config       DEFAULT_CONFIG 或覆盖
   */
  constructor({ onObservation = null, staleMs = null, minIntervalSec = null, priority = null, config = DEFAULT_CONFIG } = {}) {
    this.onObservation = onObservation;
    this.cfg = { ...(DEFAULT_CONFIG.fusion ?? {}), ...(config.fusion ?? {}) };
    // observation.t 是秒级 observation clock；staleMs 换算成秒。
    this.staleSec = (staleMs ?? this.cfg.staleMs) / 1000;
    this.minIntervalSec = minIntervalSec ?? this.cfg.minIntervalSec;
    this.priority = priority ?? this.cfg.priority ?? {};
    this.latest = {};   // sourceName -> observation
    this.lastEmitT = -Infinity;
  }

  _orderFor(feature) {
    return this.priority[feature] ?? this.cfg.defaultPriority ?? ['pose', 'imu'];
  }

  /** sourceName: 'pose' | 'imu'（或任意调用方命名）。 */
  push(sourceName, observation) {
    if (!observation || typeof observation.t !== 'number') return null;
    this.latest[sourceName] = observation;

    const nowT = observation.t;
    if (nowT - this.lastEmitT < this.minIntervalSec) return null;

    const merged = this._merge(observation);
    if (!merged) return null;
    this.lastEmitT = nowT;
    this.onObservation?.(merged);
    return merged;
  }

  _freshEnough(obs, t) {
    return obs && typeof obs.t === 'number' && t - obs.t <= this.staleSec && obs.t <= t + 1e-6;
  }

  _merge(primary) {
    const features = {};
    const coverage = {};
    const t = primary.t;

    for (const key of FEATURE_KEYS) {
      let winner = null;
      for (const name of this._orderFor(key)) {
        const obs = this.latest[name];
        if (!this._freshEnough(obs, t)) continue;
        const cov = obs.coverage?.[key];
        const value = obs.features?.[key];
        if (cov === 'unavailable' || typeof value !== 'number' || !Number.isFinite(value)) continue;
        winner = { value, cov };
        break;
      }
      if (winner) {
        features[key] = winner.value;
        coverage[key] = winner.cov;
      } else {
        features[key] = 0;
        coverage[key] = 'unavailable';
      }
    }

    // context 浅合并：本次发射源优先，对端只补缺。
    const context = {};
    for (const name of Object.keys(this.latest)) {
      const obs = this.latest[name];
      if (this._freshEnough(obs, t) && obs.context) Object.assign(context, obs.context);
    }
    if (primary.context) Object.assign(context, primary.context);

    return {
      t,
      features,
      coverage: normalizeCoverage(coverage),
      ...(Object.keys(context).length ? { context } : {}),
      debug: { fusion: { sources: Object.keys(this.latest), primaryT: t } },
    };
  }
}
