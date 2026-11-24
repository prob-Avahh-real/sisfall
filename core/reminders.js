// 提醒编排：训练定时提醒 + 服药时间提醒的状态机。
//
// 从 app.js 抽出的领域逻辑（修复"UI 层长逻辑"的破口）：
//   - schedule / medication / doseFired / lastScheduleFired 状态持有
//   - localStorage 读写（经注入的 storage 接缝，Node 测试可用 fake）
//   - 30s tick 判定（isScheduleDue / isDoseDue 已是 core/training.js 纯函数）
//   - 通知经注入的 onNotify 回调（UI 层负责 toast + TTS）
//
// 语义与原 app.js 完全一致：选时间即启用，「清除」即关闭；服药只是时间
// 闹钟（pd-profile 边界：不含药名/剂量/调整）。

import { DEFAULT_CONFIG } from './config.js';
import { isScheduleDue, isDoseDue, dayKey } from './training.js';

export const REMINDER_KEYS = {
  schedule: 'sisfall.trainingSchedule',
  fired: 'sisfall.trainingFiredDay',
  medication: 'sisfall.medicationSchedule',
  doseFired: 'sisfall.doseFired',
};

export class ReminderManager {
  /**
   * @param {object} opts
   * @param {{getItem,setItem}|null} opts.storage  localStorage 或 fake；null=纯内存
   * @param {() => Date} opts.now                 时钟注入（可测）
   * @param {(kind:'training'|'medication', text:string, speak:string) => void} opts.onNotify
   * @param {object} opts.config                  DEFAULT_CONFIG 或覆盖
   */
  constructor({ storage = null, now = () => new Date(), onNotify = null, config = DEFAULT_CONFIG } = {}) {
    this.storage = storage;
    this.now = now;
    this.onNotify = onNotify ?? (() => {});
    this.trainingCfg = config.training ?? {};
    this.schedule = { ...(this.trainingCfg.schedule ?? { enabled: false, time: '09:00' }) };
    this.medication = { ...(this.trainingCfg.medication ?? { enabled: false, times: [] }) };
    this.doseFired = {};
    this.lastScheduleFired = null;
    this.load();
  }

  _read(key, fallback) {
    try {
      const raw = this.storage?.getItem(key);
      if (raw == null) return fallback;
      return JSON.parse(raw) ?? fallback;
    } catch {
      return fallback;
    }
  }

  _write(key, value) {
    try {
      this.storage?.setItem(key, JSON.stringify(value));
    } catch {
      /* 隐私模式/配额：内存态照常工作 */
    }
  }

  load() {
    this.schedule = this._read(REMINDER_KEYS.schedule, { ...this.schedule });
    this.medication = this._read(REMINDER_KEYS.medication, { ...this.medication });
    this.lastScheduleFired = this.storage?.getItem(REMINDER_KEYS.fired) ?? null;
    this.doseFired = this._read(REMINDER_KEYS.doseFired, {});
  }

  save() {
    this._write(REMINDER_KEYS.schedule, this.schedule);
    this._write(REMINDER_KEYS.medication, this.medication);
  }

  /** 选时间即启用；传空/清除即关闭。返回当前描述供 UI 渲染。 */
  setScheduleTime(time) {
    if (time) {
      this.schedule = { enabled: true, time };
    } else {
      this.schedule = { ...this.schedule, enabled: false };
    }
    this.save();
    return this.describe();
  }

  setMedicationTimes(times) {
    const list = (times ?? []).filter(Boolean);
    this.medication = list.length ? { enabled: true, times: list } : { ...this.medication, enabled: false };
    this.save();
    return this.describe();
  }

  clearSchedule() {
    this.schedule = { ...this.schedule, enabled: false };
    this.save();
    return this.describe();
  }

  clearMedication() {
    this.medication = { ...this.medication, enabled: false };
    this.save();
    return this.describe();
  }

  /** UI 状态文案：{ schedule, medication } */
  describe() {
    return {
      schedule: this.schedule?.enabled ? `每天 ${this.schedule.time}` : '未启用',
      medication: this.medication?.enabled ? `每天 ${this.medication.times.join(' / ')}` : '未启用',
    };
  }

  /**
   * 周期 tick（UI 每 30s 调用）。trainingActive 时跳过训练提醒
   * （与原 scheduleWatch 的 agent?.training.active 门控一致）。
   */
  tick({ trainingActive = false } = {}) {
    const date = this.now();
    if (this.schedule?.enabled && !trainingActive && isScheduleDue(this.schedule, date, this.lastScheduleFired)) {
      this.lastScheduleFired = dayKey(date);
      try {
        this.storage?.setItem(REMINDER_KEYS.fired, this.lastScheduleFired);
      } catch { /* 同上 */ }
      this.onNotify(
        'training',
        `该做康复训练了（每天 ${this.schedule.time}）。点击“开始训练”。`,
        '该做康复训练了。请点击开始训练。'
      );
    }
    if (this.medication?.enabled) {
      const dueTime = isDoseDue(this.medication.times, date, this.doseFired);
      if (dueTime) {
        this.doseFired[`${dayKey(date)}:${dueTime}`] = true;
        this._write(REMINDER_KEYS.doseFired, this.doseFired);
        this.onNotify(
          'medication',
          `服药时间提醒（${dueTime}）——请遵医嘱服用。`,
          '服药时间到了，请遵医嘱。'
        );
      }
    }
  }
}
