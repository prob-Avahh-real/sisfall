import { SisFallAgent } from './core/agent.js';
import { RiskSmoother } from './core/risk.js';
import { DEFAULT_CONFIG } from './core/config.js';
import { poseObservation } from './sources/pose.js';
import { runScenario, interleave, SCENARIOS } from './sources/sim.js';
import { DevicemotionSource, requestMotionPermission } from './sources/devicemotion.js';
import { BleImuSource } from './sources/web-bluetooth.js';
import { ObservationFusion } from './sources/fusion.js';
import { isScheduleDue, isDoseDue, dayKey } from './core/training.js';
import { snapshotAgent, restoreAgent } from './core/persistence.js';
import { ReminderManager } from './core/reminders.js';
import { parseVoiceIntent, admitVoiceIntent } from './core/voice.js';
import { DEFAULT_BPM, clampBpm, breathPhaseAt } from './core/music.js';
import { HeadGestureDetector } from './core/gestures.js';
import { BaduanjinSession, matchScore, aggregateScores } from './core/baduanjin.js';

const $ = (id) => document.getElementById(id);
const ui = {
  video: $('video'), canvas: $('canvas'), empty: $('emptyState'), emptyText: $('emptyText'), live: $('liveBadge'),
  score: $('score'), gaugeBar: $('gaugeBar'), label: $('riskLabel'), signals: $('signals'),
  alert: $('alertBox'), advice: $('alertAdvice'), nudge: $('nudgeBox'), nudgeText: $('nudgeText'),
  toast: $('toast'), camera: $('cameraBtn'), demo: $('demoBtn'), scenario: $('scenario'),
  sound: $('soundBtn'), stateChip: $('stateChip'),
  motion: $('motionBtn'), ble: $('bleBtn'), fusion: $('fusionBtn'),
  askBar: $('askBar'), askText: $('askText'), askYes: $('askYes'), askNo: $('askNo'),
  trainBtn: $('trainBtn'), voiceBtn: $('voiceBtn'), trainingStatus: $('trainingStatus'),
  baduanjinBtn: $('baduanjinBtn'), baduanjinStatus: $('baduanjinStatus'),
  activityCard: $('activityCard'), actTitle: $('actTitle'), actRemain: $('actRemain'),
  actProgress: $('actProgress'), actCue: $('actCue'), actScore: $('actScore'),
  actLegend: $('actLegend'), actStop: $('actStop'),
  scheduleTime: $('scheduleTime'), scheduleClear: $('scheduleClear'), scheduleState: $('scheduleState'),
  medTime1: $('medTime1'), medTime2: $('medTime2'), medClear: $('medClear'), medState: $('medState'),
  musicBtn: $('musicBtn'), musicSeg: $('musicSeg'), bpmDown: $('bpmDown'), bpmUp: $('bpmUp'),
  bpmValue: $('bpmValue'), musicState: $('musicState'),
  careMore: $('careMore'), cameraStopBtn: $('cameraStopBtn'), cameraLabel: $('cameraLabel'),
  motionLabel: $('motionLabel'), bleLabel: $('bleLabel'),
  deck: $('deck'), deckTrack: $('deckTrack'), deckDots: $('deckDots'),
  settingsOpen: $('settingsOpen'), sheetBackdrop: $('sheetBackdrop'), settingsSheet: $('settingsSheet'),
  sheetHandle: $('sheetHandle'), sheetHead: $('sheetHead'), sheetClose: $('sheetClose'),
  careLabel: $('careLabel'), careAdvice: $('careAdvice'), chips: $('checkinChips'),
};

let agent = null;
let smoother = new RiskSmoother();
let mode = 'idle'; // 'idle' | 'camera' | 'sim' | 'motion' | 'ble' | 'fusion'
let running = false;
let demoTimer = null;
let poseLandmarker = null;
let lastVideoTime = -1;
let previousPose = null;
let previousAt = 0;
let sessionStart = 0;
let soundOn = true;
let lastAlarm = 0;
let simQueue = null;
let simIndex = 0;
let displayedStage = null;
let activeSource = null;
let fusion = null; // ObservationFusion, mode==='fusion' 时非空
let lastRenderAt = 0;
let careExpanded = false; // 护理建议是否展开全部

// Latency/battery instrumentation for device modes: per-sample ingest cost
// (p95 budget in config.device) and the effective observation rate.
const perf = {
  ingests: [],
  sampleT: [],
  budgetWarned: false,
  markIngest(ms) {
    this.ingests.push(ms);
    if (this.ingests.length > DEFAULT_CONFIG.ui.perf.bufferSize) this.ingests.shift();
  },
  markSample(t) {
    this.sampleT.push(t);
    if (this.sampleT.length > DEFAULT_CONFIG.ui.perf.bufferSize) this.sampleT.shift();
  },
  stats() {
    const n = this.ingests.length;
    if (n === 0) return { hz: 0, avg: 0, p95: 0 };
    const sorted = [...this.ingests].sort((a, b) => a - b);
    const avg = this.ingests.reduce((sum, value) => sum + value, 0) / n;
    const p95 = sorted[Math.min(n - 1, Math.floor(n * 0.95))];
    const ts = this.sampleT;
    const hz = ts.length > 8 ? (ts.length - 1) / Math.max(1e-6, ts[ts.length - 1] - ts[0]) : 0;
    return { hz, avg, p95 };
  },
};

const SIM_EVENTS_PER_TICK = DEFAULT_CONFIG.ui.sim.eventsPerTick;
const connections = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]];
const FEATURE_NAMES = { torsoLean: '前倾', lateralOffset: '重心偏移', hipDropSpeed: '下坠', kneeAsymmetry: '负重不均' };
const CARE_KINDS = { activity: '活动', environment: '环境', clinical: '就医', monitoring: '监测', care: '照护' };

// 环境行的展示：外部标记（测试/演示注入）优先，其次传感器推断的确认状态。
function environmentText(env = {}) {
  if (env.inferred?.active) return '已确认：湿滑/障碍 · 预警提前';
  if (env.obstacle || env.lowLight) return '外部标记 · 预警提前';
  if (env.pendingQuestion) return '待确认';
  return '正常';
}
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STATE_KEY = 'sisfall-state-v1';
const LEGACY_STATE_KEY = 'sisfall-agent-state-v1'; // pre-rename key; migrated on first save

function persistAgentState() {
  if (!agent) return;
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify({ savedAt: Date.now(), state: snapshotAgent(agent) }));
  } catch {
    /* storage full or unavailable — session keeps running in memory */
  }
}

function loadAgentState(target) {
  try {
    const raw = localStorage.getItem(STATE_KEY) ?? localStorage.getItem(LEGACY_STATE_KEY);
    if (!raw) return;
    const { savedAt, state } = JSON.parse(raw);
    const tShiftSec = Math.max(0, (Date.now() - (savedAt ?? Date.now())) / 1000);
    if (restoreAgent(target, state, { tShiftSec })) {
      showToast('已恢复上次会话的基线、症状与日志。');
    }
  } catch {
    /* corrupt store — start fresh */
  }
}

function startSession() {
  agent = new SisFallAgent();
  loadAgentState(agent);
  smoother = new RiskSmoother();
  displayedStage = null;
  previousPose = null;
  previousAt = 0;
  lastVideoTime = -1;
}

function showToast(text) {
  ui.toast.textContent = text;
  ui.toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => ui.toast.classList.remove('show'), DEFAULT_CONFIG.ui.toastMs);
}

// 触觉反馈（手机/手表震动）：不支持时静默降级
function buzz(pattern = DEFAULT_CONFIG.ui.alarm.buzzDefaultMs) {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try { navigator.vibrate(pattern); } catch { /* 无震动能力 */ }
  }
}

function alarm() {
  if (!soundOn || Date.now() - lastAlarm < DEFAULT_CONFIG.policy.audioCooldownSec * 1000) return;
  lastAlarm = Date.now();
  const A = DEFAULT_CONFIG.ui.alarm;
  buzz(A.buzzPattern); // 触觉告警（手机/手表）；不支持时静默
  const ctx = new AudioContext();
  A.beepDelaysSec.forEach((delay, i) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = i ? A.beepFrequencies[1] : A.beepFrequencies[0];
    g.gain.setValueAtTime(A.beepGain, ctx.currentTime + delay);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + A.beepRampSec);
    o.connect(g).connect(ctx.destination);
    o.start(ctx.currentTime + delay);
    o.stop(ctx.currentTime + delay + A.beepStopSec);
  });
}

function runActions(actions) {
  for (const action of actions) {
    if (action.kind === 'audio') alarm();
    else if (action.kind === 'instruction' && action.urgency === 'high') {
      ui.alert.style.display = 'block';
      ui.advice.textContent = action.text;
    } else if (action.kind === 'instruction') {
      ui.nudge.style.display = 'block';
      ui.nudgeText.textContent = action.text;
    } else if (action.kind === 'visual') {
      showToast(action.text);
    } else if (action.kind === 'question') {
      showAsk(action);
    }
  }
}

function renderCare(stage, force = false) {
  if (!force && displayedStage && displayedStage.stage === stage.stage && displayedStage.provisional === stage.provisional) return;
  const previous = displayedStage;
  displayedStage = stage;
  const plan = agent.carePlan();
  ui.careLabel.textContent = `${plan.label}${plan.provisional ? ' · 初步' : ''} — ${plan.headline}`;
  const advice = plan.advice;
  ui.careAdvice.innerHTML = advice.map((a) => `<li><b>${CARE_KINDS[a.kind] ?? a.kind}</b>${escapeHtml(a.text)}</li>`).join('');
  const extra = Math.max(0, advice.length - 3);
  ui.careAdvice.classList.toggle('collapsed', extra > 0 && !careExpanded);
  ui.careMore.hidden = extra === 0;
  ui.careMore.textContent = careExpanded ? '收起' : `展开其余 ${extra} 条`;
  if (previous && previous.stage !== stage.stage) showToast(`护理建议已更新：${plan.label}`);
}

function render(step) {
  const score = smoother.add(step.effective.score);
  const level = step.effective.level;
  const copy = {
    stable: ['平稳', '姿态平衡'],
    caution: ['注意', '放慢速度，稳住身体'],
    danger: ['高风险', '立即扶稳或坐下'],
  }[level];
  const color = level === 'danger' ? '#d33' : level === 'caution' ? '#d9822b' : '#2f9e6e';
  ui.score.textContent = score;
  ui.gaugeBar.style.width = `${score}%`;
  ui.gaugeBar.style.background = color;
  ui.label.className = `risk-label ${level}`;
  ui.label.textContent = `${copy[0]} · ${copy[1]}`;

  const stateText = {
    calibrating: '校准中',
    stable: '平稳',
    caution: '注意',
    imminent: '预警',
    danger: '危险',
    recovering: '恢复中',
  }[step.state] ?? step.state;
  ui.stateChip.textContent = stateText;
  ui.stateChip.className = `state-chip ${step.state}`;

  const f = step.features;
  const fc = step.forecast;
  const forecastText = fc.imminent && fc.timeToDangerSec != null
    ? `约 ${fc.timeToDangerSec.toFixed(1)} 秒后危险`
    : fc.projectedLevel === 'danger' ? '趋向危险'
      : fc.projectedLevel === 'caution' ? '风险上升'
        : fc.slope > 4 ? '留意' : '平稳';
  const dev = step.baseline.deviation;
  const fitText = !step.baseline.warm
    ? `正在学习您的基线（${Math.round(step.baseline.progress * 100)}%）`
    : dev.level === 'outside' ? `与平时不同：${FEATURE_NAMES[dev.top[0]] ?? '步态'}`
      : '与平时一致';
  const symptomText = step.symptoms.active.length
    ? step.symptoms.active.map((a) => `${a.label} ${Math.round(a.level * 100)}%`).join(' · ')
    : '无';

  const rows = [
    ['姿态', `${Math.round(f.torsoLean)}° 前倾`],
    ['重心', f.lateralOffset > 1 ? '移出支撑面' : '居中'],
    ['下降', f.hipDropSpeed > DEFAULT_CONFIG.ui.display.hipDropFast ? '快速下坠' : '平稳'],
    ['预测', forecastText],
    ['个人基线', fitText],
    ['症状', symptomText],
    ['环境', environmentText(step.environment)],
  ];
  ui.signals.innerHTML = rows.map(([a, b]) => `<li><span>${a}</span><b>${escapeHtml(String(b))}</b></li>`).join('');

  if (!['caution', 'danger', 'imminent'].includes(step.state)) {
    ui.alert.style.display = 'none';
    ui.nudge.style.display = 'none';
  }
  renderCare(step.stage);
}

// Actions are never throttled (they are edge-triggered and sparse — alarms
// must not drop); only the DOM refresh is capped for high-rate sensor modes.
function handleStep(step, { throttled = false } = {}) {
  runActions(step.actions);
  const now = performance.now();
  if (!throttled || now - lastRenderAt >= DEFAULT_CONFIG.device.renderThrottleMs) {
    lastRenderAt = now;
    render(step);
  }
}

async function loadPoseModel() {
  if (poseLandmarker) return;
  // 本地优先（vendor/mediapipe/，离线可用）；本地缺失时回退 CDN。
  const LOCAL = './vendor/mediapipe';
  const CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304';
  const MODEL_CDN = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
  let vision;
  try {
    vision = await import(`${LOCAL}/tasks-vision.mjs`);
  } catch {
    vision = await import(`${CDN}/+esm`);
  }
  let wasmBase = `${LOCAL}/wasm`;
  try {
    const probe = await fetch(`${wasmBase}/vision_wasm_internal.js`, { method: 'HEAD' });
    if (!probe.ok) throw new Error('local wasm missing');
  } catch {
    wasmBase = `${CDN}/wasm`;
  }
  const fileset = await vision.FilesetResolver.forVisionTasks(wasmBase);
  let modelPath = `${LOCAL}/pose_landmarker_lite.task`;
  try {
    const probe = await fetch(modelPath, { method: 'HEAD' });
    if (!probe.ok) throw new Error('local model missing');
  } catch {
    modelPath = MODEL_CDN;
  }
  poseLandmarker = await vision.PoseLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: modelPath,
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: DEFAULT_CONFIG.ui.poseConfidences.minPoseDetection,
    minTrackingConfidence: DEFAULT_CONFIG.ui.poseConfidences.minTracking,
  });
}

function drawPose(points) {
  const c = ui.canvas;
  const ctx = c.getContext('2d');
  c.width = ui.video.videoWidth;
  c.height = ui.video.videoHeight;
  ctx.clearRect(0, 0, c.width, c.height);
  // 全身动线：跟练时绘制双腕与髋中最近约 4 秒的轨迹（越旧越淡）
  if (baduanjin) {
    const trails = [
      { list: skeletonTrails.wristL, color: '#3a5a99' },
      { list: skeletonTrails.wristR, color: '#3a5a99' },
      { list: skeletonTrails.hip, color: '#d9822b' },
    ];
    ctx.lineWidth = 3;
    ctx.shadowBlur = 0;
    for (const trail of trails) {
      const list = trail.list;
      if (list.length < 2) continue;
      ctx.strokeStyle = trail.color;
      for (let i = 1; i < list.length; i += 1) {
        ctx.globalAlpha = (i / list.length) * 0.55;
        ctx.beginPath();
        ctx.moveTo(list[i - 1].x * c.width, list[i - 1].y * c.height);
        ctx.lineTo(list[i].x * c.width, list[i].y * c.height);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }

  // 标准轨迹参考骨架（蓝色细线）：按跟练人的坐标锚点（髋中+肩宽）叠加，
  // 与实时骨架重叠对比——蓝线=应该到的姿势，彩色=实际姿势。
  if (baduanjin?.reference) {
    const ref = baduanjin.reference;
    const H = c.height; // 归一化空间（aspect 校正）→ 像素：乘画布高
    ctx.strokeStyle = 'rgba(58, 90, 153, 0.6)';
    ctx.lineWidth = 2.5;
    ctx.shadowBlur = 0;
    ctx.beginPath();
    connections.forEach(([a, b]) => {
      const pa = ref.points[a];
      const pb = ref.points[b];
      if (!pa || !pb) return;
      ctx.moveTo((ref.origin.x + pa.x * ref.scale) * H, (ref.origin.y + pa.y * ref.scale) * H);
      ctx.lineTo((ref.origin.x + pb.x * ref.scale) * H, (ref.origin.y + pb.y * ref.scale) * H);
    });
    ctx.stroke();
    ctx.fillStyle = 'rgba(58, 90, 153, 0.6)';
    for (const p of Object.values(ref.points)) {
      ctx.beginPath();
      ctx.arc((ref.origin.x + p.x * ref.scale) * H, (ref.origin.y + p.y * ref.scale) * H, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 火柴人染色：跟练模式按偏差状态着色（绿=达标/黄=接近/灰=偏离）
  const jointStates = baduanjin?.jointStates ?? null;
  const JOINT_COLORS = { ok: '#2f9e6e', near: '#d9822b', off: '#8a8a8a' };
  const boneColor = (a, b) => {
    if (!jointStates) return '#70e0b7';
    const stateA = jointStates[a];
    const stateB = jointStates[b];
    if (stateA && stateA === stateB) return JOINT_COLORS[stateA];
    if (stateA === 'ok' || stateB === 'ok') return JOINT_COLORS.ok;
    if (stateA || stateB) return JOINT_COLORS[stateA ?? stateB];
    return '#70e0b7';
  };
  ctx.lineWidth = 4;
  ctx.shadowBlur = 10;
  connections.forEach(([a, b]) => {
    const color = boneColor(a, b);
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.beginPath();
    ctx.moveTo(points[a].x * c.width, points[a].y * c.height);
    ctx.lineTo(points[b].x * c.width, points[b].y * c.height);
    ctx.stroke();
  });
  points.forEach((p, index) => {
    ctx.fillStyle = jointStates?.[index] ? JOINT_COLORS[jointStates[index]] : '#effff8';
    ctx.beginPath();
    ctx.arc(p.x * c.width, p.y * c.height, 4, 0, Math.PI * 2);
    ctx.fill();
  });
}

function predictLoop() {
  if ((mode !== 'camera' && mode !== 'fusion') || !running) return;
  if (ui.video.currentTime !== lastVideoTime && ui.video.readyState >= 2) {
    lastVideoTime = ui.video.currentTime;
    const now = performance.now();
    const result = poseLandmarker.detectForVideo(ui.video, now);
    if (result.landmarks?.[0]) {
      const points = result.landmarks[0];
      if (baduanjin) baduanjinTick(points, now / 1000); // 先更新参考骨架，再一并绘制（时钟：秒）
      drawPose(points);
      if (mode === 'camera') headGestureTick(points, now);
      const t = (now - sessionStart) / 1000;
      const dt = previousAt ? (now - previousAt) / 1000 : 1 / 15;
      const observation = poseObservation(points, previousPose, dt, t);
      previousPose = observation.debug;
      previousAt = now;
      if (fusion) {
        fusion.push('pose', observation); // 融合模式：pose 只进融合器，不直接 ingest
      } else {
        const step = agent.ingest(observation);
        handleStep(step);
      }
    }
  }
  requestAnimationFrame(predictLoop);
}

async function startCamera() {
  stopSim();
  stopSensor();
  try {
    ui.camera.disabled = true;
    ui.cameraLabel.textContent = '加载中…';
    await loadPoseModel();
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: DEFAULT_CONFIG.ui.camera.widthIdeal }, height: { ideal: DEFAULT_CONFIG.ui.camera.heightIdeal } },
      audio: false,
    });
    ui.video.srcObject = stream;
    await ui.video.play();
    startSession();
    mode = 'camera';
    running = true;
    sessionStart = performance.now();
    ui.empty.style.display = 'none';
    ui.live.style.display = 'block';
    ui.live.innerHTML = '<i></i> 实时';
    ui.camera.disabled = false;
    ui.cameraLabel.textContent = '已启用';
    ui.camera.classList.add('on');
    ui.cameraStopBtn.hidden = false;
    requestAnimationFrame(predictLoop);
  } catch (e) {
    ui.camera.disabled = false;
    ui.cameraLabel.textContent = '重试';
    ui.emptyText.textContent = e.message?.includes('Permission')
      ? '请允许相机权限后继续。'
      : '相机或模型暂不可用，可先运行演示场景。';
  }
}

function stopCamera() {
  if (fusion) {
    fusion = null;
    activeSource?.stop?.();
    activeSource = null;
    ui.fusionLabel.textContent = '融合';
    ui.fusion.classList.remove('on');
  }
  running = false;
  mode = 'idle';
  if (baduanjin) finishBaduanjin(false); // 跟练依赖相机帧：停相机即停跟练
  ui.video.srcObject?.getTracks().forEach((track) => track.stop());
  ui.video.srcObject = null;
  ui.live.style.display = 'none';
  ui.camera.disabled = false;
  ui.cameraLabel.textContent = '相机';
  ui.camera.classList.remove('on');
  ui.cameraStopBtn.hidden = true;
}

function startSim() {
  if (mode === 'camera') stopCamera();
  stopSensor();
  const name = ui.scenario.value;
  const { observations, checkins } = runScenario(name);
  simQueue = interleave(observations, checkins);
  simIndex = 0;
  startSession();
  mode = 'sim';
  running = true;
  ui.live.style.display = 'block';
  ui.live.innerHTML = `<i></i> 模拟 · ${escapeHtml(SCENARIOS[name].label)}`;
  ui.demo.textContent = '停止场景';
  demoTimer = setInterval(simTick, DEFAULT_CONFIG.ui.timers.simTickMs);
}

function simTick() {
  if (!simQueue) return;
  for (let i = 0; i < SIM_EVENTS_PER_TICK && simIndex < simQueue.length; i += 1) {
    const event = simQueue[simIndex];
    simIndex += 1;
    if (event.kind === 'checkin') {
      const result = agent.ingestCheckin(event.checkin);
      showToast(`${result.label}: ${result.advice}`);
    } else {
      const step = agent.ingest(event.observation);
      handleStep(step);
    }
  }
  if (simIndex >= simQueue.length) stopSim();
}

function stopSim() {
  clearInterval(demoTimer);
  demoTimer = null;
  simQueue = null;
  simIndex = 0;
  if (mode === 'sim') {
    mode = 'idle';
    running = false;
  }
  ui.demo.textContent = '运行场景';
  ui.live.style.display = 'none';
  if (agent) renderCare(agent.stage(), true); // final, established classification
}

function stopSensor() {
  activeSource?.stop?.();
  activeSource = null;
  if (fusion) { fusion = null; ui.fusion.classList.remove('on'); ui.fusionLabel.textContent = '融合'; }
  if (mode === 'fusion') {
    // 融合模式的相机流也要停
    ui.video.srcObject?.getTracks().forEach((track) => track.stop());
    ui.video.srcObject = null;
    running = false;
    mode = 'idle';
    ui.live.style.display = 'none';
    ui.cameraStopBtn.hidden = true;
    ui.camera.classList.remove('on');
  } else if (mode === 'motion' || mode === 'ble') {
    mode = 'idle';
    running = false;
    ui.live.style.display = 'none';
  }
  ui.motionLabel.textContent = '传感器';
  ui.bleLabel.textContent = '手环';
}

function ingestDeviceObservation(observation) {
  if (fusion) {
    fusion.push('imu', observation); // 融合模式：IMU 只进融合器
    return;
  }
  const t0 = performance.now();
  const step = agent.ingest(observation);
  perf.markIngest(performance.now() - t0);
  perf.markSample(observation.t);
  handleStep(step, { throttled: true });
  if (mode !== 'motion' && mode !== 'ble') return;
  const stats = perf.stats();
  const label = mode === 'motion' ? '手机' : '蓝牙';
  ui.live.innerHTML = `<i></i> ${label} · ${stats.hz.toFixed(0)} Hz · ${stats.p95.toFixed(1)} ms`;
  if (!perf.budgetWarned && perf.ingests.length >= DEFAULT_CONFIG.device.budgetMinSamples && stats.p95 > DEFAULT_CONFIG.device.maxIngestP95Ms) {
    perf.budgetWarned = true;
    showToast(`处理延迟 p95 ${stats.p95.toFixed(1)} ms 超出 ${DEFAULT_CONFIG.device.maxIngestP95Ms} ms 预算——请降低界面刷新率或采样率。`);
  }
}

async function startMotion() {
  stopSim();
  stopSensor();
  if (mode === 'camera') stopCamera();
  const permission = await requestMotionPermission();
  if (permission !== 'granted') {
    showToast('未获得运动传感器权限——请在浏览器设置中允许后重试。');
    return;
  }
  startSession();
  const source = new DevicemotionSource({ onObservation: ingestDeviceObservation });
  source.start(window);
  activeSource = source;
  mode = 'motion';
  running = true;
  ui.empty.style.display = 'none';
  ui.live.style.display = 'block';
  ui.live.innerHTML = '<i></i> 手机 · 正在预热';
  ui.motionLabel.textContent = '已启用';
}

async function startBle() {
  stopSim();
  stopSensor();
  if (mode === 'camera') stopCamera();
  startSession();
  const source = new BleImuSource({
    onObservation: ingestDeviceObservation,
    onStatus: (status) => showToast(status),
  });
  try {
    ui.ble.disabled = true;
    ui.bleLabel.textContent = '连接中…';
    await source.connect();
    activeSource = source;
    mode = 'ble';
    running = true;
    ui.empty.style.display = 'none';
    ui.live.style.display = 'block';
    ui.live.innerHTML = '<i></i> 蓝牙 · 已连接';
    ui.bleLabel.textContent = '已连接';
  } catch (e) {
    showToast(`蓝牙连接失败：${e.message}`);
    ui.bleLabel.textContent = '手环';
  } finally {
    ui.ble.disabled = false;
  }
}

// 融合模式：相机 pose + 手机 IMU 同时采集，ObservationFusion 按 feature
// 择优合并后喂 agent。相机负责 kneeAsymmetry/lateralOffset 等视觉特征，
// IMU 在相机遮挡/黑暗时补 torsoLean/lateralOffset/hipDropSpeed。
async function startFusion() {
  stopSim();
  stopSensor();
  if (mode === 'camera') stopCamera();
  try {
    ui.fusion.disabled = true;
    ui.fusionLabel.textContent = '加载中…';
    await loadPoseModel();
    const permission = await requestMotionPermission();
    if (permission !== 'granted') {
      showToast('未获得运动传感器权限——融合模式需要相机+手机传感器同时授权。');
      ui.fusion.disabled = false;
      ui.fusionLabel.textContent = '融合';
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: DEFAULT_CONFIG.ui.camera.widthIdeal }, height: { ideal: DEFAULT_CONFIG.ui.camera.heightIdeal } },
      audio: false,
    });
    ui.video.srcObject = stream;
    await ui.video.play();
    fusion = new ObservationFusion({
      onObservation: (observation) => {
        const t0 = performance.now();
        const step = agent.ingest(observation);
        perf.markIngest(performance.now() - t0);
        perf.markSample(observation.t);
        handleStep(step, { throttled: true });
      },
    });
    const source = new DevicemotionSource({ onObservation: ingestDeviceObservation });
    source.start(window);
    activeSource = source;
    startSession();
    mode = 'fusion';
    running = true;
    sessionStart = performance.now();
    previousPose = null;
    previousAt = null;
    ui.empty.style.display = 'none';
    ui.live.style.display = 'block';
    ui.live.innerHTML = '<i></i> 融合 · 相机+手机';
    ui.fusion.disabled = false;
    ui.fusionLabel.textContent = '已启用';
    ui.fusion.classList.add('on');
    ui.cameraStopBtn.hidden = false;
    requestAnimationFrame(predictLoop);
  } catch (e) {
    fusion = null;
    activeSource?.stop?.();
    activeSource = null;
    ui.fusion.disabled = false;
    ui.fusionLabel.textContent = '重试';
    ui.emptyText.textContent = e.message?.includes('Permission')
      ? '请允许相机和运动传感器权限后继续。'
      : '相机或模型暂不可用。';
  }
}

function stopFusion() {
  fusion = null;
  if (activeSource) { activeSource.stop?.(); activeSource = null; }
  if (mode === 'fusion') {
    stopCamera(); // stops stream + resets running/mode; mode==='fusion' path inside handles it
  }
  ui.fusionLabel.textContent = '融合';
  ui.fusion.classList.remove('on');
}

// --- 环境询问：传感器推断触发的主动询问；用户回答才是环境的真实来源 ------
function showAsk(action) {
  ui.askText.textContent = action.detail ? `${action.text}（${action.detail}）` : action.text;
  ui.askBar.classList.add('open');
  if (speechOn) speak(action.text);
}

function answerEnvironment(yes) {
  ui.askBar.classList.remove('open');
  if (!agent) return;
  const result = agent.ingestEnvironmentAnswer({ t: agent.lastT, yes });
  showToast(result.advice);
}

ui.askYes.onclick = () => answerEnvironment(true);
ui.askNo.onclick = () => answerEnvironment(false);

// --- 康复训练：手动 / 语音唤出 / 定时 -------------------------------------
// 训练按“真实秒”推进（与仿真 4x 时间域解耦）：起点记在 source 时钟上，
// 之后用墙钟推进。仿真加速下 note 里的动作名可能滞后一帧，无碍安全。
let trainTicker = null;
let trainClock = null;
let speechOn = true;

const SCHEDULE_KEY = 'sisfall.trainingSchedule';
const FIRED_KEY = 'sisfall.trainingFiredDay';
const MED_KEY = 'sisfall.medicationSchedule';

function speak(text) {
  if (!speechOn || typeof speechSynthesis === 'undefined') return;
  try {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);
  } catch {
    /* 语音输出失败不影响安全路径 */
  }
}

// 活动卡「结束」：长按直接结束；松手未按满则进入「点头确认」——
// 相机前点头即结束；无相机时再点一次取消，或等窗口超时自动取消。
let stopArmedAt = 0;
let stopArmTimer = null;

function disarmStop() {
  if (stopArmTimer) {
    clearTimeout(stopArmTimer);
    stopArmTimer = null;
  }
  stopArmedAt = 0;
  ui.actStop.classList.remove('armed');
  ui.actStop.textContent = '按住结束';
}

function resetActStop() {
  disarmStop();
  ui.actStop.classList.remove('holding');
}

function executeStop() {
  if (baduanjin) finishBaduanjin(false);
  else if (agent?.training.active) endTraining({ completed: false });
  buzz(30);
}

function confirmArmedStop() {
  if (!stopArmedAt) return;
  disarmStop();
  executeStop();
}

function hideActivity() {
  ui.activityCard.hidden = true;
  ui.actProgress.style.width = '0%';
  resetActStop();
}

function renderTraining(current) {
  if (!current || ['idle', 'done'].includes(current.phase)) return;
  ui.activityCard.hidden = false;
  ui.actLegend.hidden = true;
  ui.actScore.textContent = '';
  if (current.phase === 'exercise') {
    ui.actTitle.textContent = `${current.index + 1}/${current.total} · ${current.exercise.name}`;
    ui.actCue.textContent = `${current.exercise.cue} 注意：${current.exercise.safety}`;
  } else {
    const titles = { intro: '准备', rest: '休息', outro: '完成' };
    ui.actTitle.textContent = titles[current.phase] ?? '';
    ui.actCue.textContent = current.cue ?? '';
  }
  ui.actRemain.textContent = `剩余 ${Math.ceil(current.remaining)} 秒`;
  ui.actProgress.style.width = `${Math.round((current.progress ?? 0) * 100)}%`;
}

function startTraining(source = 'manual') {
  if (!agent || !running) {
    showToast('请先启动监测（相机/演示/传感器任一），训练时需要智能体观察姿态。');
    return;
  }
  if (baduanjin) {
    showToast('请先结束八段锦跟练，再开始康复训练。');
    return;
  }
  const result = agent.startTraining(agent.lastT, { source });
  if (!result.ok) {
    showToast(result.reason);
    return;
  }
  const sourceStart = agent.lastT;
  const wallStart = performance.now() / 1000;
  trainClock = () => sourceStart + (performance.now() / 1000 - wallStart);
  ui.trainBtn.classList.add('on');
  ui.trainBtn.setAttribute('aria-pressed', 'true');
  resetActStop();
  renderTraining(result.current);
  speak(`开始康复训练，共 ${result.plan.length} 个动作。${result.plan[0].cue}`);
  let lastExercise = -1;
  clearInterval(trainTicker);
  trainTicker = setInterval(() => {
    const current = agent ? agent.trainingProgress(trainClock()) : null;
    if (!current || current.phase === 'done') {
      endTraining({ completed: true });
      return;
    }
    renderTraining(current);
    if (current.phase === 'exercise' && current.index !== lastExercise) {
      lastExercise = current.index;
      speak(`${current.exercise.name}。${current.exercise.cue} 注意：${current.exercise.safety}`);
      // 音乐疗愈联动：节拍模式跟随当前动作的推荐 BPM（如节拍行走 100）
      if (music.on && music.mode === 'metronome') {
        music.bpm = clampBpm(current.exercise.bpm ?? music.baseBpm);
      }
    }
  }, 1000);
}

function endTraining({ completed }) {
  clearInterval(trainTicker);
  trainTicker = null;
  if (music.on) music.bpm = music.baseBpm; // 训练结束，节拍恢复面板设置
  if (!agent?.training.active) return;
  const t = trainClock ? trainClock() : agent.lastT;
  trainClock = null;
  const summary = agent.finishTraining(t, { completed });
  ui.trainBtn.classList.remove('on');
  ui.trainBtn.setAttribute('aria-pressed', 'false');
  if (!baduanjin) hideActivity();
  if (summary) {
    const minutes = Math.floor(summary.durationSec / 60);
    ui.trainingStatus.textContent = `上次：完成 ${summary.doneExercises}/${summary.totalExercises} · ${minutes} 分 ${summary.durationSec % 60} 秒 · 训练中峰值 ${summary.maxScore}`;
    speak(completed ? '训练完成，很好！' : '训练已结束。');
    if (summary.maxScore >= 72) {
      showToast('训练中出现过高风险姿态，请放慢动作并保持扶稳。');
    }
  }
}

ui.trainBtn.onclick = () => {
  if (agent?.training.active) {
    showToast('训练进行中——用活动卡的「结束」按钮结束。');
    return;
  }
  startTraining('manual');
};

// 结束按钮的按压手势：按住填充进度，满格直接结束；提前松手则挂起「点头确认」。
function setupHoldStop() {
  const holdMs = (DEFAULT_CONFIG.voice?.confirmHoldSec ?? 1.2) * 1000;
  const armWindowMs = (DEFAULT_CONFIG.deck?.nodConfirmWindowSec ?? 5) * 1000;
  ui.actStop.style.setProperty('--hold-ms', `${holdMs}ms`);
  let holdTimer = null;
  let armedOnDown = false;
  const cancelHold = () => {
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    ui.actStop.classList.remove('holding');
  };
  ui.actStop.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    cancelHold();
    armedOnDown = Boolean(stopArmedAt);
    disarmStop();
    ui.actStop.classList.add('holding');
    holdTimer = setTimeout(() => {
      holdTimer = null;
      ui.actStop.classList.remove('holding');
      executeStop(); // 长按直接结束
    }, holdMs);
  });
  ui.actStop.addEventListener('pointerup', () => {
    cancelHold();
    if (armedOnDown) return; // 本次点击用于取消挂起
    // 松手未按满：挂起点头确认（再点一次或超时取消）
    stopArmedAt = performance.now();
    ui.actStop.classList.add('armed');
    ui.actStop.textContent = '点头确认';
    stopArmTimer = setTimeout(disarmStop, armWindowMs);
  });
  ['pointercancel', 'pointerleave'].forEach((type) => ui.actStop.addEventListener(type, cancelHold));
}
setupHoldStop();

// 语音唤出（Web Speech API 识别；关键词规则在 core/voice.js；不支持时自动降级为按钮）。
const SpeechRecognitionImpl = window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
let recognition = null;
let voiceOn = false;

function setVoice(on) {
  if (on && !SpeechRecognitionImpl) {
    showToast('此浏览器不支持语音识别（可用桌面版 Chrome/Edge）。');
    return;
  }
  voiceOn = on;
  ui.voiceBtn.classList.toggle('on', voiceOn);
  ui.voiceBtn.setAttribute('aria-pressed', String(voiceOn));
  if (!voiceOn) {
    recognition?.stop?.();
    recognition = null;
    wakeUntil = 0;
    return;
  }
  recognition = new SpeechRecognitionImpl();
  recognition.lang = 'zh-CN';
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const alternative = event.results[i][0];
      handleVoiceResult(alternative.transcript, alternative.confidence);
    }
  };
  recognition.onend = () => {
    if (voiceOn && recognition) {
      try {
        recognition.start();
      } catch {
        /* 重启失败则等待下一次点击 */
      }
    }
  };
  recognition.onerror = () => {};
  try {
    recognition.start();
    showToast('语音已开启：先说「小安」再下指令。');
  } catch {
    showToast('语音识别启动失败，可改用按钮。');
    setVoice(false);
  }
}

ui.voiceBtn.onclick = () => setVoice(!voiceOn);

// 语音指令 v2：唤醒词门控 + 多目标（训练/八段锦/相机/音乐/语音）。
// 语义与放行规则在 core/voice.js（纯函数、已测）；这里只做浏览器接线。
let wakeUntil = 0;
let lastVoiceAction = -Infinity;

function handleVoiceResult(transcript, confidence) {
  // TTS 回读会被麦克风拾取：说话期间视为回声而非指令（避免自触发）
  if (typeof speechSynthesis !== 'undefined' && (speechSynthesis.speaking || speechSynthesis.pending)) return;
  const parsed = parseVoiceIntent(transcript);
  if (!parsed) return;
  const now = performance.now() / 1000;
  const decision = admitVoiceIntent(parsed, {
    nowSec: now,
    wakeUntilSec: wakeUntil,
    lastActionSec: lastVoiceAction,
    confidence,
    config: DEFAULT_CONFIG,
  });
  if (!decision.ok) {
    if (decision.reason === 'needs-wake') {
      showToast(`听到「${transcript}」——为避免误触，请先说「小安」再下指令。`);
    }
    return;
  }
  if (parsed.intent === 'wake') {
    wakeUntil = now + (DEFAULT_CONFIG.voice?.wakeWindowSec ?? 8);
    chime(true);
    showToast('小安在听——可以说：开始训练 / 开始八段锦 / 关闭相机 / 关闭语音。');
    return;
  }
  lastVoiceAction = now;
  showToast(`语音：${transcript}`);
  dispatchVoiceIntent(parsed);
}

function dispatchVoiceIntent(parsed) {
  const { intent, target } = parsed;
  if (intent === 'nav') {
    goToCard(DECK.index + (parsed.direction === 'next' ? 1 : -1));
    return;
  }
  if (intent === 'start') {
    if (target === 'training') return startTraining('voice');
    if (target === 'baduanjin') return startBaduanjin();
    if (target === 'camera') return startCameraFromVoice();
    if (target === 'music') return toggleMusic(true);
    return showToast('请说清楚要开始什么：训练 / 八段锦 / 相机 / 音乐。');
  }
  // intent === 'stop'：安全方向，无需唤醒词
  if (target === 'voice') {
    setVoice(false);
    return showToast('语音已关闭。');
  }
  if (target === 'training') {
    return agent?.training.active ? endTraining({ completed: false }) : showToast('训练未在进行。');
  }
  if (target === 'baduanjin') {
    return baduanjin ? finishBaduanjin(false) : showToast('跟练未在进行。');
  }
  if (target === 'camera') {
    if (mode === 'camera') {
      stopCamera();
      showToast('相机已停止。');
    } else showToast('相机未在运行。');
    return;
  }
  if (target === 'music') return toggleMusic(false);
  // 无目标短口令（停 / 不练了）：停止进行中的训练或跟练；不主动关相机（隐私动作需明确目标）
  if (baduanjin || agent?.training.active) {
    if (baduanjin) finishBaduanjin(false);
    if (agent?.training.active) endTraining({ completed: false });
  } else {
    showToast('当前没有进行中的训练或跟练。');
  }
}

function startCameraFromVoice() {
  if (mode === 'camera') return showToast('相机已在运行。');
  startCamera();
}

// --- 音乐疗愈：Web Audio 合成的节拍/呼吸提示（零音频文件、离线可用）--------
// 节拍用于步态节律提示（RAS 方向）；呼吸引导（4-4-6）为放松辅助。
// 训练中若当前动作带 bpm（如节拍行走 100），节拍自动采用动作节奏。
let audioCtx = null;
const music = { on: false, mode: 'metronome', bpm: DEFAULT_BPM, baseBpm: DEFAULT_BPM, startedAt: 0, nextBeat: 0, lastStageKey: '', ticker: null, render: null };
const BREATH_STAGE_TEXT = { inhale: '吸气', hold: '屏息', exhale: '呼气' };

function ensureAudio() {
  if (!audioCtx) {
    const Impl = window.AudioContext ?? window.webkitAudioContext;
    if (!Impl) return null;
    audioCtx = new Impl();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

function beatSound(accent = false) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = accent ? 1040 : 880;
  gain.gain.setValueAtTime(accent ? 0.09 : 0.06, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0008, ctx.currentTime + 0.07);
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.08);
}

function chime(rising) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'triangle';
  const C = DEFAULT_CONFIG.ui.cue;
  osc.frequency.setValueAtTime(rising ? C.lowFreq : C.highFreq, ctx.currentTime);
  osc.frequency.linearRampToValueAtTime(rising ? C.highFreq : C.lowFreq, ctx.currentTime + C.rampSec);
  gain.gain.setValueAtTime(0.05, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0008, ctx.currentTime + 0.7);
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.75);
}

function musicTick() {
  const now = performance.now() / 1000;
  if (music.mode === 'metronome') {
    const interval = 60 / music.bpm;
    let guard = 8;
    while (music.nextBeat <= now + 0.05 && guard > 0) {
      const index = Math.round((music.nextBeat - music.startedAt) / interval);
      beatSound(index % 4 === 0);
      music.nextBeat += interval;
      guard -= 1;
    }
  } else {
    const phase = breathPhaseAt(now, { startedAt: music.startedAt });
    const key = `${phase.cycleIndex}:${phase.stageIndex}`;
    if (key !== music.lastStageKey) {
      music.lastStageKey = key;
      if (phase.stage === 'inhale') chime(true);
      if (phase.stage === 'exhale') chime(false);
    }
  }
}

function renderMusicState() {
  if (!music.on) {
    ui.musicState.textContent = '音乐未开启';
    return;
  }
  if (music.mode === 'metronome') {
    ui.musicState.textContent = `节拍 ${music.bpm} BPM`;
  } else {
    const phase = breathPhaseAt(performance.now() / 1000, { startedAt: music.startedAt });
    ui.musicState.textContent = `呼吸引导 · ${BREATH_STAGE_TEXT[phase.stage]} ${Math.ceil(phase.remaining)} 秒`;
  }
}

function renderMusicSettingsUI() {
  ui.musicSeg.querySelectorAll('button[data-mode]').forEach((segBtn) => {
    const active = segBtn.dataset.mode === music.mode;
    segBtn.classList.toggle('on', active);
    segBtn.setAttribute('aria-selected', String(active));
  });
  const metronome = music.mode === 'metronome';
  ui.bpmDown.disabled = !metronome;
  ui.bpmUp.disabled = !metronome;
  ui.bpmValue.textContent = String(music.baseBpm);
}

function applyMusicSettings() {
  music.baseBpm = clampBpm(music.baseBpm);
  music.bpm = music.baseBpm;
  music.startedAt = performance.now() / 1000;
  music.nextBeat = music.startedAt;
  music.lastStageKey = '';
  renderMusicSettingsUI();
  renderMusicState();
}

// 音乐开关按钮的视觉状态（启动区）
function renderMusicBtn() {
  ui.musicBtn.classList.toggle('on', music.on);
  ui.musicBtn.setAttribute('aria-pressed', String(music.on));
}

function startMusic() {
  if (!ensureAudio()) {
    showToast('此浏览器不支持音频合成（Web Audio），音乐疗愈不可用。');
    renderMusicBtn();
    return;
  }
  music.on = true;
  clearInterval(music.ticker);
  clearInterval(music.render);
  music.ticker = setInterval(musicTick, DEFAULT_CONFIG.ui.timers.musicTickMs);
  music.render = setInterval(renderMusicState, DEFAULT_CONFIG.ui.timers.musicRenderMs);
  renderMusicState();
}

function stopMusic() {
  music.on = false;
  clearInterval(music.ticker);
  clearInterval(music.render);
  music.ticker = null;
  music.render = null;
  renderMusicState();
}

// 音乐开关（面板按钮 / 语音共用）；模式与速率在设置抽屉里
function toggleMusic(on) {
  if (on) {
    if (music.on) return showToast('音乐已在播放。');
    applyMusicSettings();
    startMusic();
  } else {
    if (!music.on) return showToast('音乐未开启。');
    stopMusic();
    showToast('音乐已关闭。');
  }
  renderMusicBtn();
}
ui.musicBtn.onclick = () => toggleMusic(!music.on);

// 分段控件（节拍/呼吸）与步进器（BPM）——触控控件，替代下拉框
ui.musicSeg.addEventListener('click', (event) => {
  const segBtn = event.target.closest?.('button[data-mode]') ?? event.target;
  if (!segBtn?.dataset?.mode) return;
  music.mode = segBtn.dataset.mode;
  applyMusicSettings();
});
ui.bpmDown.onclick = () => { music.baseBpm = clampBpm(music.baseBpm - 10); applyMusicSettings(); };
ui.bpmUp.onclick = () => { music.baseBpm = clampBpm(music.baseBpm + 10); applyMusicSettings(); };
renderMusicSettingsUI();

// --- 八段锦跟练：火柴人全身跟踪 + 逐帧打分 + 动线轨迹 ----------------------
// 评分反馈（幅度/对称/稳定）不是医疗评估；跟练期间 agent 走 practice
// 语义（暂缓注意级提示，预警/危险不降级）。
let baduanjin = null;
let skeletonTrails = { wristL: [], wristR: [], hip: [] };

function pushTrail(point, list) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
  list.push({ x: point.x, y: point.y });
  if (list.length > 90) list.shift(); // 约 4 秒 @ 22fps
}

function baduanjinTick(points, now) {
  if (!baduanjin) return;
  const current = baduanjin.session.currentAt(now);
  if (current.phase === 'done') {
    finishBaduanjin(true);
    return;
  }
  // 动线采样：双腕与髋中
  pushTrail(points[15], skeletonTrails.wristL);
  pushTrail(points[16], skeletonTrails.wristR);
  const hipL = points[23];
  const hipR = points[24];
  if (hipL && hipR) pushTrail({ x: (hipL.x + hipR.x) / 2, y: (hipL.y + hipR.y) / 2 }, skeletonTrails.hip);

  if (current.phase !== 'move') {
    // 换式/收势：归档上一式的平均分
    if (baduanjin.moveIndex >= 0 && baduanjin.lastMove) {
      baduanjin.moveScores.push({
        id: baduanjin.lastMove.id,
        name: baduanjin.lastMove.name,
        score: baduanjin.current?.smooth ?? null,
      });
      baduanjin.moveIndex = -1;
      baduanjin.lastMove = null;
    }
    renderBaduanjin(current);
    return;
  }
  if (current.index !== baduanjin.moveIndex) {
    baduanjin.moveIndex = current.index;
    baduanjin.lastMove = current.move;
    baduanjin.current = { sum: 0, frames: 0, smooth: null };
    speak(`${current.move.name}。${current.move.cue}`);
  }
  // 与标准轨迹对比：时滞窗口内最佳对齐 → 分数 + 逐关节偏差 + 参考骨架
  const aspect = ui.video.videoWidth && ui.video.videoHeight ? ui.video.videoWidth / ui.video.videoHeight : 16 / 9;
  const result = matchScore(current.move, points, current.progress, { aspect });
  if (result) {
    baduanjin.current.sum += result.score;
    baduanjin.current.frames += 1;
    baduanjin.current.smooth = Math.round(baduanjin.current.sum / baduanjin.current.frames);
    baduanjin.jointStates = result.jointStates;
    baduanjin.reference = { points: result.reference, scale: result.scale, origin: result.origin };
  }
  renderBaduanjin(current);
}

function renderBaduanjin(current) {
  if (!current || !baduanjin || current.phase === 'done') return;
  ui.activityCard.hidden = false;
  ui.actLegend.hidden = false;
  if (current.phase === 'move') {
    ui.actTitle.textContent = `${current.index + 1}/${current.total} · ${current.move.name}`;
    ui.actCue.textContent = current.move.cue;
  } else if (current.phase === 'transition') {
    ui.actTitle.textContent = `${current.index + 1}/${current.total} 已完成`;
    ui.actCue.textContent = current.cue ?? '';
  } else {
    ui.actTitle.textContent = '收势';
    ui.actCue.textContent = current.cue ?? '';
  }
  ui.actRemain.textContent = `剩余 ${Math.ceil(current.remaining ?? 0)} 秒`;
  ui.actProgress.style.width = `${Math.round((current.progress ?? 0) * 100)}%`;
  ui.actScore.textContent = baduanjin?.current?.smooth != null ? `本式得分：${baduanjin.current.smooth}` : '';
}

function startBaduanjin() {
  if (!agent || mode !== 'camera') {
    showToast('八段锦跟练需要开启相机（全身骨骼跟踪）。');
    return;
  }
  if (agent.training.active) {
    showToast('请先结束康复训练，再进行八段锦跟练。');
    return;
  }
  baduanjin = {
    session: new BaduanjinSession({ config: DEFAULT_CONFIG, now: performance.now() / 1000 }),
    moveScores: [],
    moveIndex: -1,
    lastMove: null,
    current: null,
    jointStates: null,
    reference: null,
  };
  skeletonTrails = { wristL: [], wristR: [], hip: [] };
  ui.baduanjinBtn.classList.add('on');
  ui.baduanjinBtn.setAttribute('aria-pressed', 'true');
  resetActStop();
  ui.activityCard.hidden = false;
  ui.actTitle.textContent = '准备 · 八段锦';
  ui.actCue.textContent = '跟随口令，动作缓慢量力而行。';
  ui.actLegend.hidden = false;
  ui.actRemain.textContent = '';
  ui.actScore.textContent = '';
  ui.actProgress.style.width = '0%';
  agent.setPractice(true, '八段锦');
  speak('八段锦跟练开始。请跟随口令，动作缓慢量力而行。');
}

function finishBaduanjin(natural) {
  if (!baduanjin) return;
  if (baduanjin.lastMove && baduanjin.current) {
    baduanjin.moveScores.push({
      id: baduanjin.lastMove.id,
      name: baduanjin.lastMove.name,
      score: baduanjin.current.smooth ?? null,
    });
  }
  const summary = aggregateScores(baduanjin.moveScores);
  hideActivity();
  ui.baduanjinBtn.classList.remove('on');
  ui.baduanjinBtn.setAttribute('aria-pressed', 'false');
  if (summary.total != null) {
    ui.baduanjinStatus.textContent = `上次：总分 ${summary.total} · ${summary.moves
      .map((move) => `${move.name.slice(0, 2)} ${move.score ?? '—'}`)
      .join(' · ')}`;
  } else {
    ui.baduanjinStatus.textContent = '上次：未采集到有效动作帧（请确保全身在画面内）。';
  }
  speak(natural ? `八段锦跟练完成，总分 ${summary.total ?? '—'} 分。` : '跟练已结束。');
  if (agent) {
    agent.setPractice(false);
    agent.journal.record({ t: agent.lastT, type: 'practice', action: 'finish', kind: 'baduanjin', score: summary.total, moves: summary.moves });
  }
  baduanjin = null;
  skeletonTrails = { wristL: [], wristR: [], hip: [] };
}

ui.baduanjinBtn.onclick = () => {
  if (baduanjin) {
    showToast('跟练进行中——用活动卡的「结束」按钮结束。');
    return;
  }
  startBaduanjin();
};

// 定时提醒：状态编排已收进 core/reminders.js（ReminderManager），
// 本层只做 DOM 接线与通知呈现（toast + TTS）。系统级提醒属后续里程碑。
const reminders = new ReminderManager({
  storage: globalThis.localStorage ?? null,
  onNotify: (kind, text, speakText) => {
    showToast(text);
    speak(speakText);
  },
});

function renderScheduleState() {
  const d = reminders.describe();
  ui.scheduleState.textContent = d.schedule === '未启用' ? '未启用' : `${d.schedule}${agent ? '' : '（需先启动监测）'}`;
  ui.medState.textContent = d.medication;
}

ui.scheduleTime.onchange = () => {
  const time = ui.scheduleTime.value;
  reminders.setScheduleTime(time);
  ui.scheduleClear.hidden = !time;
  renderScheduleState();
  showToast('提醒设置已保存。');
};
ui.medTime1.onchange = ui.medTime2.onchange = () => {
  const times = [ui.medTime1.value, ui.medTime2.value].filter(Boolean);
  reminders.setMedicationTimes(times);
  ui.medClear.hidden = !times.length;
  renderScheduleState();
  showToast('提醒设置已保存。');
};
ui.scheduleClear.onclick = () => {
  reminders.clearSchedule();
  ui.scheduleTime.value = '';
  ui.scheduleClear.hidden = true;
  renderScheduleState();
  showToast('训练提醒已关闭。');
};
ui.medClear.onclick = () => {
  reminders.clearMedication();
  ui.medTime1.value = '';
  ui.medTime2.value = '';
  ui.medClear.hidden = true;
  renderScheduleState();
  showToast('服药提醒已关闭。');
};

function scheduleWatch() {
  reminders.tick({ trainingActive: !!agent?.training.active });
}
setInterval(scheduleWatch, DEFAULT_CONFIG.ui.timers.reminderTickMs);
setInterval(persistAgentState, DEFAULT_CONFIG.ui.timers.persistIntervalMs);
window.addEventListener('pagehide', persistAgentState);

// 初始化表单值（ReminderManager 构造时已 load）
ui.scheduleTime.value = reminders.schedule.enabled ? (reminders.schedule.time ?? '') : '';
ui.scheduleClear.hidden = !reminders.schedule.enabled;
ui.medTime1.value = reminders.medication.enabled ? (reminders.medication.times?.[0] ?? '') : '';
ui.medTime2.value = reminders.medication.enabled ? (reminders.medication.times?.[1] ?? '') : '';
ui.medClear.hidden = !reminders.medication.enabled;
renderScheduleState();

ui.camera.onclick = () => {
  if (mode === 'camera') { showToast('相机已在运行。'); return; }
  startCamera();
};
ui.cameraStopBtn.onclick = () => {
  stopCamera();
  showToast('相机已停止。');
};
ui.demo.onclick = () => { if (mode === 'sim') stopSim(); else startSim(); };
ui.motion.onclick = () => { if (mode !== 'motion') startMotion();
ui.fusion.onclick = () => { if (mode === 'fusion') { stopSensor(); } else { startFusion(); } }; };
ui.ble.onclick = () => { if (mode !== 'ble') startBle(); };
ui.sound.onclick = () => {
  soundOn = !soundOn;
  ui.sound.classList.toggle('on', soundOn);
  ui.sound.setAttribute('aria-pressed', String(soundOn));
};
ui.careMore.onclick = () => {
  careExpanded = !careExpanded;
  if (agent) renderCare(agent.stage(), true);
};

// --- 卡片牌堆：滑动 / 歪头 / 语音 / 圆点翻卡 ---------------------------------
const DECK_CFG = DEFAULT_CONFIG.deck ?? {};
const DECK = { index: 0, count: Math.max(1, ui.deckTrack.querySelectorAll('.card').length || 5) };

function renderDots() {
  ui.deckDots.querySelectorAll('button').forEach((dot, i) => dot.classList.toggle('on', i === DECK.index));
}

function goToCard(index) {
  const target = Math.max(0, Math.min(DECK.count - 1, index));
  if (target === DECK.index) return;
  DECK.index = target;
  ui.deckTrack.style.transform = `translateX(${-target * 100 || 0}%)`;
  renderDots();
}

// 滑动翻卡：在非控件区域左右拖拽
let swipe = null;
ui.deck.addEventListener('pointerdown', (event) => {
  if (event.target.closest?.('button,select,input,a')) return; // 控件点击交给控件
  swipe = { x0: event.clientX, y0: event.clientY, dx: 0, axis: null };
  ui.deck.setPointerCapture?.(event.pointerId);
});
ui.deck.addEventListener('pointermove', (event) => {
  if (!swipe) return;
  const dx = event.clientX - swipe.x0;
  const dy = event.clientY - swipe.y0;
  if (!swipe.axis) {
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
    swipe.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    if (swipe.axis === 'x') ui.deckTrack.classList.add('dragging');
  }
  if (swipe.axis !== 'x') return;
  swipe.dx = dx;
  ui.deckTrack.style.transform = `translateX(calc(${-DECK.index * 100 || 0}% + ${dx}px))`;
  event.preventDefault();
});
function endSwipe() {
  if (!swipe) return;
  const wasHorizontal = swipe.axis === 'x';
  const dx = swipe.dx;
  const width = ui.deck.clientWidth || 1;
  swipe = null;
  ui.deckTrack.classList.remove('dragging');
  if (!wasHorizontal) return;
  const settle = DECK_CFG.swipeSettlePx ?? 48;
  if (dx <= -settle && dx / width <= -0.18) goToCard(DECK.index + 1);
  else if (dx >= settle && dx / width >= 0.18) goToCard(DECK.index - 1);
  else ui.deckTrack.style.transform = `translateX(${-DECK.index * 100 || 0}%)`; // 回弹：goToCard 同卡会早退，需显式复位
}
ui.deck.addEventListener('pointerup', endSwipe);
ui.deck.addEventListener('pointercancel', endSwipe);

// 圆点跳转
ui.deckDots.addEventListener('click', (event) => {
  const dot = event.target.closest?.('button') ?? event.target;
  if (!dot) return;
  const index = [...ui.deckDots.querySelectorAll('button')].indexOf(dot);
  if (index >= 0) goToCard(index);
});
renderDots();

// 头部手势（相机模式、非训练/跟练期间）：摇头＝滑走（下一张），点头＝确认。
// 关键点 → 肩宽归一化偏移在 UI 层换算，分类在 core/gestures.js（纯函数、已测）。
const headGestures = new HeadGestureDetector(DEFAULT_CONFIG);
function headGestureTick(points, nowMs) {
  if (baduanjin || agent?.training.active) {
    headGestures.reset();
    return;
  }
  const nose = points[0];
  const shoulderL = points[11];
  const shoulderR = points[12];
  if (!nose || !shoulderL || !shoulderR) return;
  const shoulderWidth = Math.max(1e-3, Math.abs(shoulderR.x - shoulderL.x));
  const x = (nose.x - (shoulderL.x + shoulderR.x) / 2) / shoulderWidth;
  const y = (nose.y - (shoulderL.y + shoulderR.y) / 2) / shoulderWidth;
  const gesture = headGestures.push({ t: nowMs, x, y });
  if (!gesture) return;
  handleHeadGesture(gesture);
}

function handleHeadGesture(gesture) {
  if (ui.askBar.classList.contains('open')) {
    // 询问栏打开：点头＝是，摇头＝不是（把问题滑走）
    answerEnvironment(gesture === 'nod');
    return;
  }
  if (gesture === 'shake') {
    goToCard(DECK.index + 1);
    showToast('摇头：下一张');
    return;
  }
  if (gesture === 'nod' && stopArmedAt) confirmArmedStop();
}

// --- 设置表单（iOS sheet）：上滑入场、点背景/「完成」/下滑关闭 --------------
function openSheet() {
  ui.sheetBackdrop.hidden = false;
  requestAnimationFrame(() => ui.sheetBackdrop.classList.add('open'));
}
function closeSheet() {
  ui.sheetBackdrop.classList.remove('open');
  ui.settingsSheet.style.transform = '';
  setTimeout(() => {
    if (!ui.sheetBackdrop.classList.contains('open')) ui.sheetBackdrop.hidden = true;
  }, 280);
}
ui.settingsOpen.onclick = openSheet;
ui.sheetClose.onclick = closeSheet;
ui.sheetBackdrop.addEventListener('click', (event) => {
  if (event.target === ui.sheetBackdrop) closeSheet();
});
// 下滑关闭：把手与头部可拖动
let sheetDrag = null;
function startSheetDrag(event) {
  if (event.button !== undefined && event.button !== 0) return;
  sheetDrag = { startY: event.clientY, lastY: event.clientY, moved: false };
  event.preventDefault();
}
function moveSheetDrag(event) {
  if (!sheetDrag) return;
  const dy = Math.max(0, event.clientY - sheetDrag.startY);
  sheetDrag.lastY = event.clientY;
  if (dy > 8) sheetDrag.moved = true;
  ui.settingsSheet.style.transition = 'none';
  ui.settingsSheet.style.transform = `translateY(${dy}px)`;
}
function endSheetDrag() {
  if (!sheetDrag) return;
  const shouldClose = sheetDrag.moved && sheetDrag.lastY - sheetDrag.startY > 90;
  sheetDrag = null;
  ui.settingsSheet.style.transition = '';
  ui.settingsSheet.style.transform = '';
  if (shouldClose) closeSheet();
}
for (const zone of [ui.sheetHandle, ui.sheetHead]) {
  zone.addEventListener('pointerdown', startSheetDrag);
}
ui.settingsSheet.addEventListener('pointermove', moveSheetDrag);
ui.settingsSheet.addEventListener('pointerup', endSheetDrag);
ui.settingsSheet.addEventListener('pointercancel', endSheetDrag);
ui.chips.addEventListener('click', (event) => {
  const button = event.target.closest('[data-symptom]');
  if (!button) return;
  if (!agent || !running) {
    showToast('请先开始监测——症状签到仅对当前会话生效。');
    return;
  }
  const result = agent.ingestCheckin({ t: agent.lastT, symptom: button.dataset.symptom, severity: 0.7 });
  showToast(`${result.label}: ${result.advice}`);
  button.classList.add('reported');
  setTimeout(() => button.classList.remove('reported'), DEFAULT_CONFIG.ui.timers.reportedResetMs);
});

// 会话日志导出：stage 3 建议"带上会话日志"的兑现路径（JSON 下载）。
document.getElementById('journalExport')?.addEventListener('click', () => {
  if (!agent || !agent.journal.size) {
    showToast('当前没有会话日志。');
    return;
  }
  const blob = new Blob([JSON.stringify(agent.journal.export(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sisfall-journal-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`已导出 ${agent.journal.size} 条日志。`);
});
