// 头部手势识别（纯函数）：摇头（横向往复）与点头（俯仰下探再回正）。
//
// 语义映射（UI 层约定，见 app.js）：
// - 摇头 = 滑走：卡片牌堆翻到下一张；询问栏打开时答「不是」（把问题滑走）。
// - 点头 = 确认：结束按钮进入待确认状态后点头即结束；询问栏打开时答「是」。
//
// 输入为归一化鼻尖偏移样本 { t, x, y }：x = (鼻尖.x - 肩线中点.x) / 肩宽，
// y = (鼻尖.y - 肩线中点.y) / 肩宽。时间 t 由调用方注入（相机帧时间），
// 不碰 wall clock——可在 Node 中确定性测试。
import { DEFAULT_CONFIG } from './config.js';

export class HeadGestureDetector {
  constructor(config = DEFAULT_CONFIG) {
    this.cfg = config.deck ?? {};
    this.history = [];
    this.emaX = null; // 慢基线（去中心化：低头/转身不误判）
    this.emaY = null;
    this.lastFlips = [];
    this.lastNodPeak = null;
    this.lastGestureAt = -Infinity;
  }

  /** 清空内部状态（会话/模式切换时调用）。 */
  reset() {
    this.history = [];
    this.emaX = null;
    this.emaY = null;
    this.lastFlips = [];
    this.lastNodPeak = null;
  }

  /** 喂入一个样本，返回 'shake' | 'nod' | null。 */
  push(sample) {
    const t = sample.t;
    this.history.push(sample);
    const windowMs = this.cfg.gestureWindowMs ?? 1200;
    while (this.history.length && t - this.history[0].t > windowMs) this.history.shift();

    if (this.emaX === null) {
      this.emaX = sample.x;
      this.emaY = sample.y;
    } else {
      const alpha = 0.1;
      this.emaX += alpha * (sample.x - this.emaX);
      this.emaY += alpha * (sample.y - this.emaY);
    }
    const sx = sample.x - this.emaX;
    const sy = sample.y - this.emaY;

    const cooldownMs = this.cfg.gestureCooldownMs ?? 1500;
    if (t - this.lastGestureAt < cooldownMs) return null;

    const gesture = this._classify(sx, sy, t);
    if (gesture) this.lastGestureAt = t;
    return gesture;
  }

  _classify(sx, sy, t) {
    const windowMs = this.cfg.gestureWindowMs ?? 1200;
    // 摇头：窗口内横向信号多次换向（幅度超过 shakeAmp 才计数）
    const amp = this.cfg.shakeAmp ?? 0.06;
    if (Math.abs(sx) > amp) {
      const sign = sx > 0 ? 1 : -1;
      const last = this.lastFlips[this.lastFlips.length - 1];
      if (!last || last.sign !== sign) {
        this.lastFlips.push({ sign, t });
        while (this.lastFlips.length && t - this.lastFlips[0].t > windowMs) this.lastFlips.shift();
        if (this.lastFlips.length >= (this.cfg.shakeFlips ?? 4)) {
          this.lastFlips = [];
          return 'shake';
        }
      }
    }
    // 点头：下探超过深度后，在 nodReturnMs 内回正（长时间低头不算点头）
    const depth = this.cfg.nodDepth ?? 0.08;
    const returnMs = this.cfg.nodReturnMs ?? 600;
    if (sy > depth && !this.lastNodPeak) {
      this.lastNodPeak = { t };
    } else if (this.lastNodPeak) {
      if (sy < depth * 0.4) {
        const ok = t - this.lastNodPeak.t <= returnMs;
        this.lastNodPeak = null;
        if (ok) return 'nod';
      } else if (t - this.lastNodPeak.t > returnMs * 3) {
        this.lastNodPeak = null; // 长时间低头：不是点头
      }
    }
    return null;
  }
}
