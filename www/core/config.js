// Central, overridable defaults. Every threshold the agent uses lives here so
// behavior can be tuned per deployment (or per test) without touching logic.
//
// Coverage levels and how they enter the score:
//   'measured'    full weight
//   'proxy'       discounted (honest about heuristic inputs)
//   'unavailable' excluded, remaining weights renormalized

export const DEFAULT_CONFIG = {
  risk: {
    // Relative weight per feature in the 0-100 score. Sums to 1 for the
    // originally measured pose feature set; other sets renormalize.
    weights: { torsoLean: 0.31, lateralOffset: 0.29, hipDropSpeed: 0.29, kneeAsymmetry: 0.11 },
    // Maps a raw feature value to a 0..1 "pressure": 0 at `start`, 1 at `full`.
    // `start` is a per-feature dead zone calibrated (2026-10 pass) so that
    // normal walking/standing — including camera-landmark jitter — reads as
    // exactly zero; the score only moves when posture genuinely deteriorates.
    scales: {
      torsoLean: { start: 12, full: 50 },
      lateralOffset: { start: 0.5, full: 2.2 },
      hipDropSpeed: { start: 0.15, full: 0.9 },
      kneeAsymmetry: { start: 0.05, full: 0.2 },
    },
    environment: {
      // Environmental context does NOT add to the posture score: a constant
      // add-on inflated the calm baseline to ~19 and broke the "normal reads
      // ~0" contract. It shortens warning horizons instead — the same
      // sensitivity channel as symptoms, combined with min() in the agent.
      horizonScale: { lowLight: 0.85, obstacle: 0.8 },
      // Sensor-assisted inference: a slip/stub micro-event (drop spike with
      // quick recovery) is a candidate, not a verdict — the agent asks the
      // user (bounded: cooldowns, max asks) and the answer activates the
      // sensitivity channel above. See core/environment.js.
      inference: {
        slipDropThreshold: 0.45,   // drop-proxy peak that suggests a slip/stub
        slipRecoveryDrop: 0.2,     // fall-back below this = recovered micro-event
        slipRecoverWithinSec: 1.2, // recovery must happen this fast after the peak
        eventDebounceSec: 20,      // same-kind events merge within this window
        askCooldownSec: 120,       // minimum gap between questions
        maxEvents: 20,             // rolling event buffer cap
        eventWindowSec: 90,        // events older than this are dropped
        eventExpireSec: 60,        // an event stops being askable after this age
        sustainedGraceSec: 2.5,    // drop persisting this long past peak = real fall, not micro-event
        recoverMarginSec: 1,       // extra quiet time after recovery before asking
        maxAsksPerSession: 3,
        askTimeoutSec: 60,         // unanswered questions expire
        dismissHoldSec: 600,       // "no" answer silences asking this long
        confirmedHoldSec: 1800,    // "yes" answer keeps sensitivity this long
      },
    },
    thresholds: { caution: 42, danger: 72 },
    coverageWeight: { measured: 1, proxy: 0.6, unavailable: 0 },
    driversFloor: 0.22,
  },

  imu: {
    // IMU mapping heuristics (prototype values; tune against field data in M3).
    upRefFrames: 30,     // samples used to capture the "upright" gravity reference
    gravityTau: 0.5,     // s, smoothing of the gravity/tilt estimate (lean signal)
    dropGain: 4,         // 1/s, gain from downward accel to drop-velocity proxy
    dropDecay: 2,        // 1/s, leak on the drop-velocity proxy
    lateralTau: 0.4,     // s, low-pass for lateral correction magnitude
    lateralGain: 0.4,    // g -> lateralOffset proxy scale
    gyroGain: 0.6,       // rad/s -> lateralOffset proxy; gyroscope catches
                         // rotational instability (turning/freezing) that a
                         // pocket accel misses. Prototype value, tune on field data.
    defaultDtSec: 0.02,  // assumed sample interval before first real dt
    minDtSec: 0.001,     // dt clamp floor (implausible jitter guard)
    maxDtSec: 0.2,       // dt clamp ceiling (gap tolerance)
    upRefNormTolerance: 0.15, // |norm(accel)-1| below this counts as "quiet" for up-ref capture
  },

  device: {
    // Phone/band source budgets and UI behavior (surfaced live in the web UI).
    targetHz: 50,          // design sample rate for device sources
    accelG: 9.81,          // m/s^2 per g, DeviceMotion accel -> g conversion
    budgetMinSamples: 120, // min ingest samples before p95 budget warning may fire
    renderThrottleMs: 66,  // UI refresh cap for high-rate sensor modes (~15 fps)
    maxIngestP95Ms: 5,     // budget: warn once if per-sample ingest p95 exceeds this
    ble: {
      // Defaults match common FFE0/FFE1 UART-style BLE modules (ESP32/Arduino
      // prototypes). Override with your band's real GATT UUIDs (discover with
      // nRF Connect or the vendor docs).
      serviceUuid: '0000ffe0-0000-1000-8000-00805f9b34fb',
      characteristicUuid: '0000ffe1-0000-1000-8000-00805f9b34fb',
      packetBytes: 6,      // 3 × int16 LE accelerometer samples
      accelScale: 4096,    // g = raw / accelScale
      gyroScale: 14.375,   // dps = raw / gyroScale (ITG3200 ±2000dps); only used by 6-axis packets
    },
  },

  learned: {
    // Learned risk model (M3) window parameters, shared by training and runtime
    // (the shared vectorizer lives in core/learned.js). The model artifact
    // (models/risk-v1.js) is plugged in via the agent constructor.
    windowSec: 1.0,        // feature window scored by the model
    minWindowSec: 0.6,     // minimum span before a window is scoreable
    bufferSec: 1.5,        // feature-frame buffer horizon inside the agent
  },

  baseline: {
    warmupFrames: 90,      // ~6 s at 15 Hz before personalization is trusted
    ewmaAlpha: 0.0005,     // slow drift of the personal normal (≈minutes, not seconds)
    fastAlpha: 0.06,       // fast smoother for deviation checks (~1 s time constant at 15 Hz)
    outsideHoldFrames: 15, // sustained frames above floor before "outside"
    deviationFloor: 3.0,   // |z| vs personal normal that counts as outside
    zCap: 8,               // z at which deviation strength saturates
    minStd: { torsoLean: 2, lateralOffset: 0.08, hipDropSpeed: 0.05, kneeAsymmetry: 0.01 },
  },

  forecast: {
    windowFrames: 12,        // score window for the trend fit (~0.8 s at 15 Hz)
    minRiseRate: 12,         // score points/second required to call a rise
    minConfidence: 0.35,     // least-squares fit quality gate
    scoreFloor: 25,          // never predict danger from a trivially low score
    imminentHorizonSec: 1.6, // "danger within this" => imminent
    dangerHorizonSec: 4.0,   // looser horizon for the softer forecast tier
    instabilityWindow: 12,
    instabilityFloor: 0.55,  // irregular-correction (staggering) index
    instabilityScoreFloor: 40,
    instabilityMinSamples: 6,   // min offset deltas before burstiness is scored
    instabilityBurstCenter: 0.55, // burstiness value mapped to 0
    instabilityBurstScale: 1.1,   // burstiness range mapped to 0..1
    maxTimeToDangerSec: 10,
  },

  policy: {
    cautionExit: 36,
    dangerExit: 64,
    deviationScoreFloor: 8,   // min absolute score for a personalized nudge (lowered with the 2026-10 dead-zone calibration)
    recoverHoldSec: 2.5,
    audioCooldownSec: 6,      // minimum gap between audible alarms
    cueCooldownSec: 4,        // minimum gap between spoken/text instructions
    reminderIntervalSec: 6,   // re-issue a persisting acute state at this cadence
  },

  symptoms: {
    // Non-motion symptom domain (self-reported check-ins + medication state).
    // Levels decay exponentially from the most recent report; symptoms raise
    // the EFFECTIVE risk (the same posture is more dangerous when dizzy or
    // fatigued) and extend forecast horizons so the agent warns earlier.
    historyCap: 200,         // bounded audit trail length (levelAt reads latest only)
    minLevel: 0.05,          // below this a symptom counts as cleared
    boostCap: 35,            // max points added to the effective score
    labelBoostFloor: 5,      // boost that relabels a caution as symptom-driven
    cautionThreshold: 30,    // caution entry score while a symptom is active (vs 42 normally)
    halfLifeSec: { dizziness: 600, fatigue: 3600, sleepDebt: 21600, medicationOff: 7200 },
    riskBoost: { dizziness: 25, fatigue: 12, sleepDebt: 8, medicationOff: 15 },
    // Forecast horizons multiply by this while the symptom is active (> 1 = warn earlier).
    horizonScale: { dizziness: 1.5, fatigue: 1.25, sleepDebt: 1.1, medicationOff: 1.3 },
  },

  training: {
    // 康复训练（定时提醒 + 语音唤出）。动作库是 PD 最小集（core/training.js，
    // 每项带 evidence）。训练中暂缓"注意"级视觉提示（journal 记 note），
    // 预警/危险级告警绝不降级。服药提醒只是时间闹钟——见 pd-profile 边界。
    exercisesPerSession: 5,
    introSec: 3,
    restSec: 8,
    dampenCaution: true,
    schedule: { enabled: false, time: '09:00' }, // 训练默认计划，UI 可改并持久化
    medication: { enabled: false, times: ['08:00', '20:00'] }, // 仅时间提醒；遵医嘱设置
  },

  pose: {
    // sources/pose.js geometry floors (normalized landmark space).
    minBaseWidth: 0.025, // ankle spread floor so lateralOffset never divides by ~0
    minDtSec: 0.016,     // hip-drop dt floor (~60fps) so speed never divides by ~0
  },

  fusion: {
    // pose+IMU 双源融合（sources/fusion.js）：每 feature 按 priority 顺序取
    // 第一个新鲜且非 unavailable 的源；输出由高频源节流驱动。
    staleMs: 800,          // 对端缓存有效期：超出则其 feature 视为 unavailable
    minIntervalSec: 0.04,  // 最小发射间隔（秒），避免双源叠加冲淡 baseline 帧率
    defaultPriority: ['pose', 'imu'], // 相机姿态为主信号，IMU 补盲区
    priority: {
      // 可按 feature 覆盖 defaultPriority，例如 hipDropSpeed: ['imu','pose']
      // 让口袋 IMU 的跌速代理优先于视频估计。
    },
  },

  baduanjin: {
    // 八段锦跟练（core/baduanjin.js）：每式时长与换式间歇。
    moveSeconds: 30,
    transitionSec: 5,
    // 实时评分：腕/肘关节权重高（动作幅度主要看上肢）；距离阈值单位=肩宽归一化。
    jointWeights: { 15: 2, 16: 2, 13: 1.5, 14: 1.5 },
    scoreTolerance: 0.55,  // 加权平均距离达到此值记 0 分
    okDistance: 0.18,       // 单关节偏差 ≤ 此值 → 达标
    nearDistance: 0.35,     // ≤ 此值 → 接近
  },

  voice: {
    // 语音指令（core/voice.js 的放行参数）：唤醒词「小安」后 window 秒内接受
    // 「开始」类指令；指令冷却防识别重复触发；开始类指令在置信度可用时要求
    // 最低置信度。结束类指令不受唤醒限制（喊停是安全方向）。
    wakeWindowSec: 8,
    commandCooldownSec: 2.5,
    minStartConfidence: 0.55,
    confirmHoldSec: 1.2, // 界面「结束」按钮的长按确认时长（触控防误触）
  },

  deck: {
    // 卡片牌堆交互（UI 层 + core/gestures.js 的手势分类参数）：
    // 滑动距离阈值；摇头＝滑走（下一张），点头＝确认（结束会话 / 询问栏答“是”）。
    swipeSettlePx: 48,
    gestureWindowMs: 1200,   // 手势样本窗口
    shakeAmp: 0.06,          // 摇头的鼻尖横向摆动幅度（肩宽归一化）
    shakeFlips: 4,           // 窗口内方向翻转次数达到即算摇头
    nodDepth: 0.08,          // 点头的鼻尖下探深度（肩宽归一化）
    nodReturnMs: 600,        // 下探后回正时限
    gestureCooldownMs: 1500, // 两次手势间冷却
    nodConfirmWindowSec: 5,  // 点「结束」后可用点头确认的窗口
  },

  staging: {
    // Longitudinal classification of evidence into stages 0-3.
    evidenceWindowSec: 900,  // rolling window used for classification
    minEvidenceSec: 40,      // less than this much observed time => 'provisional'
    weights: { episodes: 0.3, timeInBand: 0.3, steadiness: 0.35, symptoms: 0.05 },
    episodeRateFull: 2,      // episodes per window at which the episode term saturates
    bandWeight: { stable: 0, caution: 0.6, danger: 1, imminent: 1 },
    steadiness: {
      leanCv: { floor: 0.2, full: 0.4 },      // CV = std/mean of torsoLean in window
      offsetCv: { floor: 0.12, full: 0.35 },  // CV of lateralOffset in window
      minMean: { torsoLean: 1, lateralOffset: 0.05 },
    },
    thresholds: { guarded: 25, fragile: 50, high: 75 },
    // Fresh symptoms force a minimum stage regardless of current gait evidence.
    symptomFloors: [
      { symptom: 'dizziness', level: 0.6, minStage: 2 },
      { symptom: 'any', level: 0.5, minStage: 1 },
    ],
  },
  ui: {
    // app.js 呈现层常量（不变量 2：UI 逻辑不含魔法数字）。
    toastMs: 2800,                 // 提示条自动消失时长
    timers: {
      reminderTickMs: 30000,       // 训练/服药提醒轮询
      persistIntervalMs: 30000,    // agent 状态快照落盘间隔
      simTickMs: 66,               // 演示场景推进间隔
      musicTickMs: 40,             // 音乐节拍调度粒度
      musicRenderMs: 500,          // 音乐状态 UI 刷新
      reportedResetMs: 1600,       // 按钮 reported 态复位
    },
    sim: { eventsPerTick: 4 },     // 场景回放每 tick 推进的事件数（~4x 实时）
    perf: { bufferSize: 240 },     // ingest/sample 环形缓冲容量
    camera: { widthIdeal: 1280, heightIdeal: 720 }, // getUserMedia 理想分辨率
    poseConfidences: { minPoseDetection: 0.55, minTracking: 0.55 },
    display: { hipDropFast: 0.35 }, // hipDropSpeed 超过此值显示"快速下坠"
    alarm: {
      buzzPattern: [120, 60, 120], // 触觉告警节奏（ms on/off）
      buzzDefaultMs: 30,           // buzz() 默认单段时长
      beepDelaysSec: [0, 0.18],    // 双音提示的错开延迟
      beepFrequencies: [520, 660], // 双音频率 Hz（低/高）
      beepGain: 0.08,
      beepRampSec: 0.13,           // 增益淡出时长
      beepStopSec: 0.14,           // 振荡器停止时刻
    },
    cue: {
      lowFreq: 392, highFreq: 660, // 语音/动作提示音（上行/下行）
      rampSec: 0.6,
    },
  },
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Deep-merges `overrides` onto a copy of `base` (plain objects only). */
export function mergeConfig(base, overrides = {}) {
  const out = { ...base 
};
  for (const [key, value] of Object.entries(overrides)) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? mergeConfig(base[key], value) : value;
  }
  return out;
}
