// 语音指令解析与放行（纯函数；浏览器接线在 app.js，Web Speech API 只在 UI 层）。
//
// 防误触语义（本模块存在的理由）：
// - 「开始/打开」类指令（不安全方向）必须携带唤醒词「小安」，或处在唤醒窗口内
//   （同一句说过唤醒词，或 window 秒内说过）。否则拒绝并给出原因，UI 提示补唤醒词。
// - 「翻卡/导航」类指令（下一个/上一个）与开始类同等门控：需唤醒词——翻卡虽非
//   破坏性动作，但环境对话里「下一个」太常见，必须用唤醒词挡一道。
// - 「停止/结束/关闭」类指令（安全方向）不要求唤醒词——喊停不该被门槛挡住；
//   但仍要求目标词或明确的短口令（「停」「不练了」），避免环境语句误停。
// - 解析与放行都不碰时钟与浏览器 API：时间由调用方注入，可在 Node 中确定性测试。
import { DEFAULT_CONFIG } from './config.js';

export const WAKE_WORDS = ['小安', '思安'];
const WAKE = /(小安|思安)/;
const START = /(开始|启动|开启|打开|播放|进入|要|想|来|做)/;
const ALIAS_START = /(练一练|练练|锻炼一下|动一动|活动一下)/;
const STOP = /(停止|停下|结束|退出|取消|关闭|关掉|关上|关了)/;
const NEGATED = /(不|别)(再|想)?(练|做|继续|训练)/;
const NAV_NEXT = /(下一个|下一页|往后|前进)/;
const NAV_PREV = /(上一个|上一页|往前|后退|返回)/;
const BARE_STOP = /^(停|停下|停下来|停一下|停一停|停止|结束|算了|歇了|关了|关闭|关掉|不练了|别练了)$/;

// 目标词按优先级排列：更具体的先匹配（八段锦/跟练 → 节奏 → 语音 → 相机 → 训练）。
export const VOICE_TARGETS = [
  ['baduanjin', /(八段锦|跟练|八段)/],
  ['music', /(音乐|节拍|呼吸引导|呼吸练习|节拍器)/],
  ['voice', /(语音|麦克风|监听)/],
  ['camera', /(相机|摄像头|镜头|监测|视频)/],
  ['training', /(康复训练|训练|平衡练习|练一练|锻炼)/],
];

function matchTarget(text) {
  for (const [target, pattern] of VOICE_TARGETS) if (pattern.test(text)) return target;
  return null;
}

function isBareStop(text) {
  return BARE_STOP.test(text.replace(/[。！!？?，,、；;：:\s]/g, '').replace(/(吧|啊|呀|呢)$/, ''));
}

/**
 * 解析一条转写文本 → 指令 | null。
 * @returns {{intent:'start'|'stop'|'wake', target:string|null, wake:boolean}|null}
 */
export function parseVoiceIntent(transcript = '') {
  const raw = String(transcript).trim();
  if (!raw) return null;
  const wake = WAKE.test(raw);
  const text = wake ? raw.replace(WAKE, '').trim() : raw;
  if (wake && !text) return { intent: 'wake', target: null, wake: true };
  // 翻卡导航：先于目标词匹配（无目标词冲突），与开始类同样需要唤醒词
  if (NAV_NEXT.test(text)) return { intent: 'nav', direction: 'next', target: null, wake };
  if (NAV_PREV.test(text)) return { intent: 'nav', direction: 'prev', target: null, wake };

  const target = matchTarget(text);
  const stopish = STOP.test(text) || NEGATED.test(text) || isBareStop(text);
  const startish = START.test(text) || ALIAS_START.test(text);

  if (stopish) {
    if (target) return { intent: 'stop', target, wake };
    if (NEGATED.test(text) || isBareStop(text)) return { intent: 'stop', target: null, wake };
    return null; // 「结束了吗」之类无目标的疑问句：不动作
  }
  if (startish && target) return { intent: 'start', target, wake };
  if (wake && target) return { intent: 'start', target, wake }; // 「小安，八段锦」：唤醒即命令
  if (startish && wake) return { intent: 'start', target: null, wake }; // 「小安，开始」：UI 提示补目标
  if (wake) return { intent: 'wake', target: null, wake };
  return null;
}

/**
 * 放行判定：唤醒窗口 +（开始类）指令冷却与置信度闸门。
 * 冷却只作用于「开始」类（防识别重复/连续误触发）；「导航」类只要求唤醒词——
 * 连续翻卡（下一个/上一个）不应被冷却打断；「停止/关闭」类永不因冷却被拦——
 * 喊停是安全方向，重复执行由状态守卫幂等兜底。
 * `confidence === 0 / 非数字` 视为识别不可用（不因缺失置信度拒绝）。
 * @returns {{ok:boolean, reason:'ok'|'none'|'cooldown'|'needs-wake'|'low-confidence'}}
 */
export function admitVoiceIntent(parsed, {
  nowSec = 0,
  wakeUntilSec = 0,
  lastActionSec = -Infinity,
  confidence = null,
  config = DEFAULT_CONFIG,
} = {}) {
  if (!parsed) return { ok: false, reason: 'none' };
  if (parsed.intent === 'wake') return { ok: true, reason: 'ok' }; // 唤醒只延长窗口，不受冷却限制
  const voiceCfg = config.voice ?? {};
  const gated = parsed.intent === 'start' || parsed.intent === 'nav';
  if (gated && !parsed.wake && !(nowSec < wakeUntilSec)) return { ok: false, reason: 'needs-wake' };
  if (parsed.intent === 'start') {
    if (nowSec - lastActionSec < (voiceCfg.commandCooldownSec ?? 2.5)) return { ok: false, reason: 'cooldown' };
    const minConfidence = voiceCfg.minStartConfidence ?? 0.55;
    if (typeof confidence === 'number' && confidence > 0 && confidence < minConfidence) {
      return { ok: false, reason: 'low-confidence' };
    }
  }
  return { ok: true, reason: 'ok' };
}