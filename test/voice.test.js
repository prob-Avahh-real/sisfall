// 语音指令（core/voice.js）的测试：唤醒词门控、多目标解析、防误触语义、
// 放行判定（唤醒窗口 / 冷却 / 置信度）、与 training.js 兼容封装的一致性。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVoiceIntent, admitVoiceIntent, WAKE_WORDS } from '../core/voice.js';
import { matchVoiceCommand } from '../core/training.js';
import { DEFAULT_CONFIG } from '../core/config.js';

const admit = (parsed, ctx = {}) => admitVoiceIntent(parsed, { nowSec: 100, ...ctx });

test('唤醒词：单独出现只开窗，不产生动作', () => {
  assert.ok(WAKE_WORDS.includes('小安'));
  const wake = parseVoiceIntent('小安');
  assert.equal(wake.intent, 'wake');
  assert.equal(wake.target, null);
  assert.equal(parseVoiceIntent('小安，在吗').intent, 'wake');
  assert.equal(parseVoiceIntent('思安，你好').intent, 'wake');
});

test('开始类指令：解析出目标但默认被唤醒门控拦住，窗口内放行', () => {
  const start = parseVoiceIntent('开始训练');
  assert.equal(start.intent, 'start');
  assert.equal(start.target, 'training');
  assert.equal(start.wake, false);

  const blocked = admit(start);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'needs-wake');

  assert.equal(admit(start, { wakeUntilSec: 105 }).ok, true); // 唤醒窗口内
  assert.equal(admit(start, { wakeUntilSec: 95 }).ok, false); // 窗口已过

  const spoken = parseVoiceIntent('小安，开始八段锦');
  assert.equal(spoken.intent, 'start');
  assert.equal(spoken.target, 'baduanjin');
  assert.equal(admit(spoken).ok, true); // 同一句带唤醒词
});

test('开始类指令：置信度可用时低于门槛拒绝，缺失（0）视为不可用放行', () => {
  const start = parseVoiceIntent('小安，开始节拍');
  assert.equal(start.target, 'music');
  assert.equal(admit(start, { confidence: 0.9 }).ok, true);
  assert.equal(admit(start, { confidence: 0.3 }).reason, 'low-confidence');
  assert.equal(admit(start, { confidence: 0 }).ok, true);
  assert.equal(admit(start, {}).ok, true); // confidence 未提供
});

test('停止类指令：无需唤醒词（安全方向），但需目标词或明确短口令', () => {
  const cases = [
    ['停止训练', 'training'],
    ['结束训练吧', 'training'],
    ['关闭相机', 'camera'],
    ['关掉音乐', 'music'],
    ['关闭语音', 'voice'],
  ];
  for (const [text, target] of cases) {
    const parsed = parseVoiceIntent(text);
    assert.equal(parsed.intent, 'stop', text);
    assert.equal(parsed.target, target, text);
    assert.equal(admit(parsed).ok, true, text);
  }
  // 无目标短口令：停当前进行中的活动
  assert.equal(parseVoiceIntent('不练了').intent, 'stop');
  assert.equal(parseVoiceIntent('不想训练了').target, 'training');
  assert.equal(parseVoiceIntent('停').intent, 'stop');
  assert.equal(parseVoiceIntent('停下来吧').intent, 'stop');
  assert.equal(admit(parseVoiceIntent('停')).ok, true);
});

test('指令冷却只作用开始类：停止/关闭永不因冷却被拦（安全方向）', () => {
  const start = parseVoiceIntent('小安，开始训练');
  const cooled = admit(start, { lastActionSec: 99.5 });
  assert.equal(cooled.ok, false);
  assert.equal(cooled.reason, 'cooldown');
  assert.equal(admit(start, { lastActionSec: 96 }).ok, true);
  assert.equal(admit(parseVoiceIntent('小安'), { lastActionSec: 99.9 }).ok, true); // 唤醒只延长窗口
  // 停止类不受冷却限制（重复执行由状态守卫幂等兜底）
  assert.equal(admit(parseVoiceIntent('停止训练'), { lastActionSec: 99.9 }).ok, true);
  assert.equal(admit(parseVoiceIntent('关闭相机'), { lastActionSec: 99.9 }).ok, true);
});

test('别名与多目标：练一练/锻炼一下/开启节拍/打开相机', () => {
  assert.equal(parseVoiceIntent('练一练').target, 'training');
  assert.equal(parseVoiceIntent('练一练').intent, 'start');
  assert.equal(parseVoiceIntent('锻炼一下').intent, 'start');
  assert.equal(parseVoiceIntent('我要做八段锦').target, 'baduanjin');
  assert.equal(parseVoiceIntent('打开相机').target, 'camera');
  assert.equal(parseVoiceIntent('开始监测').target, 'camera');
  assert.equal(parseVoiceIntent('小安，开始').target, null); // 唤醒但没目标：UI 提示补目标
  assert.equal(parseVoiceIntent('小安，开始').intent, 'start');
});

test('环境语句不误触：无关句子、疑问句、裸目标词均不产生动作', () => {
  for (const text of ['今天天气不错', '我想吃早饭', '', '八段锦', '结束了吗', '训练']) {
    assert.equal(parseVoiceIntent(text), null, `不应解析：${text}`);
  }
  // 附带目标但未唤醒的句子会解析出 start，但被放行判定拦住（UI 提示补唤醒词）
  const near = parseVoiceIntent('八段锦怎么做');
  assert.equal(near.intent, 'start');
  assert.equal(admit(near).reason, 'needs-wake');
});

test('翻卡导航：需要唤醒词但不受冷却限制（可连续翻卡），不做置信度闸门', () => {
  const next = parseVoiceIntent('下一个');
  assert.equal(next.intent, 'nav');
  assert.equal(next.direction, 'next');
  assert.equal(admit(next).reason, 'needs-wake');
  assert.equal(admit(next, { wakeUntilSec: 105 }).ok, true);
  assert.equal(admit(next, { lastActionSec: 99.5, wakeUntilSec: 105 }).ok, true, '导航不受冷却限制');
  const spoken = parseVoiceIntent('小安，下一个');
  assert.equal(spoken.intent, 'nav');
  assert.equal(admit(spoken, { confidence: 0.2 }).ok, true); // nav 不做置信度闸门
  assert.equal(parseVoiceIntent('小安，上一个').direction, 'prev');
  assert.equal(parseVoiceIntent('返回').intent, 'nav');
  assert.equal(matchVoiceCommand('小安，下一个'), null);
});

test('兼容封装：matchVoiceCommand 只看训练方向，非训练目标返回 null', () => {
  assert.equal(matchVoiceCommand('开始训练'), 'start');
  assert.equal(matchVoiceCommand('我想做康复训练'), 'start');
  assert.equal(matchVoiceCommand('练一练'), 'start');
  assert.equal(matchVoiceCommand('停止训练'), 'stop');
  assert.equal(matchVoiceCommand('结束训练吧'), 'stop');
  assert.equal(matchVoiceCommand('关闭相机'), null);
  assert.equal(matchVoiceCommand('今天天气不错'), null);
  assert.equal(matchVoiceCommand(''), null);
});

test('config.voice 参数生效（可覆盖）', () => {
  const custom = { voice: { ...DEFAULT_CONFIG.voice, minStartConfidence: 0.9 } };
  const start = parseVoiceIntent('开始训练');
  assert.equal(admit(start, { wakeUntilSec: 200, confidence: 0.8, config: custom }).reason, 'low-confidence');
  assert.equal(admit(start, { wakeUntilSec: 200, confidence: 0.95, config: custom }).ok, true);
  assert.equal(DEFAULT_CONFIG.voice.wakeWindowSec, 8);
});
