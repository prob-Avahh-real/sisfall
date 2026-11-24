// 头部手势识别（core/gestures.js）的测试：摇头/点头分类、静止不误触、
// 冷却抑制、参数可覆盖、长时间低头不算点头。
import test from 'node:test';
import assert from 'node:assert/strict';
import { HeadGestureDetector } from '../core/gestures.js';
import { DEFAULT_CONFIG } from '../core/config.js';

test('摇头：窗口内横向多次换向 → shake，冷却内不重复触发', () => {
  const detector = new HeadGestureDetector(DEFAULT_CONFIG);
  let out = null;
  let t = 0;
  for (let i = 0; i < 40 && !out; i += 1) {
    out = detector.push({ t, x: 0.12 * Math.sin((i * Math.PI) / 2.5), y: 0 });
    t += 60;
  }
  assert.equal(out, 'shake');
  assert.equal(detector.push({ t: t + 100, x: 0.2, y: 0 }), null, '冷却内不重复触发');
  assert.equal(detector.push({ t: t + 2000, x: 0.2, y: 0 }), null, '单方向大幅偏移不是摇头');
});

test('点头：下探超过深度后在时限内回正 → nod', () => {
  const detector = new HeadGestureDetector(DEFAULT_CONFIG);
  let out = null;
  let t = 0;
  for (const y of [0, 0.04, 0.12, 0.1, 0.03, 0]) {
    out = detector.push({ t, x: 0, y });
    if (out) break;
    t += 120;
  }
  assert.equal(out, 'nod');
});

test('长时间低头不算点头（超出回正时限）', () => {
  const detector = new HeadGestureDetector(DEFAULT_CONFIG);
  detector.push({ t: 0, x: 0, y: 0.04 });
  detector.push({ t: 120, x: 0, y: 0.15 });
  const out = detector.push({ t: 3000, x: 0, y: 0.15 });
  assert.equal(out, null);
});

test('静止与轻微晃动不触发', () => {
  const detector = new HeadGestureDetector(DEFAULT_CONFIG);
  let out = null;
  let t = 0;
  for (let i = 0; i < 30 && !out; i += 1) {
    out = detector.push({ t, x: 0.01 * Math.sin(i), y: 0.01 * Math.cos(i) });
    t += 60;
  }
  assert.equal(out, null);
});

test('参数可覆盖：提高摇头幅度阈值后同样的摆动不再触发', () => {
  const config = { deck: { ...DEFAULT_CONFIG.deck, shakeAmp: 0.3 } };
  const detector = new HeadGestureDetector(config);
  let out = null;
  let t = 0;
  for (let i = 0; i < 40 && !out; i += 1) {
    out = detector.push({ t, x: 0.12 * Math.sin((i * Math.PI) / 2.5), y: 0 });
    t += 60;
  }
  assert.equal(out, null);
});
