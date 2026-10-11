// 关键帧 / 蒙版 引擎级自检（Node，不需要浏览器）
// 用法：node tools/keyframe-test.mjs
import {
  Scene, Layer, renderFrame, makeCanvas, clamp, EASINGS, ease, EASING_LABELS,
} from '../engine/core.js';
import {
  evalTrack, valueAt, setKey, removeKey, keyIndexAt, keysOnBeats,
  keyTimes, trackRange, normalizeTrack, keyCount, animatedProps, isExpr,
} from '../engine/keyframes.js';
import { BeatMap } from '../engine/core.js';

let pass = 0, fail = 0;
const checks = {};
function ok(name, cond, extra) {
  checks[name] = !!cond;
  if (cond) { pass++; console.log(`  ok   ${name}${extra !== undefined ? '  ' + fmt(extra) : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${extra !== undefined ? '  ' + fmt(extra) : ''}`); }
}
const fmt = (v) => (typeof v === 'number' ? Math.round(v * 10000) / 10000 : JSON.stringify(v));
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

console.log('\n== 1. 关键帧求值 ==');
{
  const tr = [{ t: 0, v: 0, e: 'linear' }, { t: 2, v: 10 }];
  ok('起点', near(evalTrack(tr, 0), 0));
  ok('中点(线性)', near(evalTrack(tr, 1), 5));
  ok('终点', near(evalTrack(tr, 2), 10));
  ok('终点之后保持', near(evalTrack(tr, 5), 10));
  ok('起点之前不外推', near(evalTrack(tr, -3), 0));

  // 缓动确实改变了中间值，但两端不动
  const eOut = [{ t: 0, v: 0, e: 'outCubic' }, { t: 1, v: 1 }];
  ok('缓出中点 > 线性中点', evalTrack(eOut, 0.5) > 0.5);
  ok('缓出两端仍精确', near(evalTrack(eOut, 0), 0) && near(evalTrack(eOut, 1), 1));
  ok('未知曲线名退回默认', Number.isFinite(evalTrack([{ t: 0, v: 0, e: 'nope' }, { t: 1, v: 1 }], 0.5)));

  // 定值帧（hold）：到下一帧之前不插值
  const hold = [{ t: 0, v: 0 }, { t: 1, v: 1, hold: true }, { t: 2, v: 9 }];
  ok('hold 段内保持', near(evalTrack(hold, 1.5), 1));
  ok('hold 到下一帧之前一直保持', near(evalTrack(hold, 1.99), 1));
  ok('hold 结束后恢复插值', near(evalTrack(hold, 2), 9));
  ok('hold 前一段仍正常插值', near(evalTrack([{ t: 0, v: 0, e: 'linear' }, { t: 1, v: 1, hold: true }, { t: 2, v: 9 }], 0.25), 0.25));
  ok('默认缓动不是线性（第一段走 outCubic）', evalTrack(hold, 0.25) > 0.25);

  // 纯缓动标记不产生新值
  const marker = [{ t: 0, v: 0 }, { t: 0.5, e: 'linear' }, { t: 1, v: 1 }];
  ok('缓动标记不产生值', keyCount({ a: marker }, 'a') === 2);
  ok('缓动标记被采用', near(evalTrack(marker, 0.5), 0.5, 5e-2));

  // 同刻去重：后面的赢（归一化时生效 —— 手写工程 JSON 就靠这一步兜底）
  ok('同刻后写覆盖', near(evalTrack(normalizeTrack([{ t: 1, v: 3 }, { t: 1, v: 7 }]), 1), 7));

  // 表达式
  const ctx = { beatIndex: 6, t: 3, local: 2, progress: 0.5, beatPhase: 0.1, beatProgress: 0.25, frame: 72 };
  ok('@beat 表达式', near(evalTrack([{ t: 0, v: '@beat' }], 0, -1, ctx), 6));
  ok('@t 表达式', near(evalTrack([{ t: 0, v: '@t' }], 0, -1, ctx), 3));
  ok('@local 表达式', near(evalTrack([{ t: 0, v: '@local' }], 0, -1, ctx), 2));
  ok('@progress 表达式', near(evalTrack([{ t: 0, v: '@progress' }], 0, -1, ctx), 0.5));
  ok('未知表达式退回静态值', near(evalTrack([{ t: 0, v: '@zzz' }], 0, 42, ctx), 42));
  ok('@osc 有界', Math.abs(evalTrack([{ t: 0, v: '@osc' }], 0, 0, { local: 0.13 })) <= 1);
  ok('isExpr 认 @', isExpr('@beat') && !isExpr('beat') && !isExpr(3));
}

console.log('\n== 2. 关键帧编辑 ==');
{
  let tr = [];
  setKey(tr, 1, 5);
  setKey(tr, 0, 0, 'linear');
  setKey(tr, 2, 9);
  ok('插入后按时间排序', tr.map((k) => k.t).join(',') === '0,1,2');
  ok('就地改值', (setKey(tr, 1, 6), tr[1].v === 6));
  ok('缓动写在对应帧上', tr[0].e === 'linear');
  ok('keyIndexAt 命中', keyIndexAt(tr, 1) === 1);
  ok('keyIndexAt 容差内命中', keyIndexAt(tr, 1 + 1 / 400) === 1);
  ok('removeKey 删掉', (removeKey(tr, 1), tr.length === 2 && keyIndexAt(tr, 1) < 0));
  ok('keyTimes 去重升序', keyTimes({ a: [{ t: 0, v: 1 }, { t: 1, v: 2 }], b: [{ t: 1, v: 3 }] }).join(',') === '0,1');
  ok('trackRange', (() => { const r = trackRange([{ t: 2, v: 1 }, { t: 5, v: 2 }]); return r.from === 2 && r.to === 5; })());
  ok('normalizeTrack 丢掉非法项', normalizeTrack([{ t: 'x', v: 1 }, null, { t: 1 }]) === null);
  ok('normalizeTrack 丢掉尾部纯缓动', (normalizeTrack([{ t: 0, v: 1 }, { t: 2, e: 'linear' }]) || []).length === 1);
  ok('valueAt 无关键帧用静态值', valueAt(null, 'x', 1, 0.25) === 0.25);
}

console.log('\n== 3. 图层：关键帧 / 不透明度 / 蒙版 ==');
{
  const L = new Layer({ template: 'x', start: 2, end: 6, opacity: 0.5 });
  ok('无关键帧 transformAt 返回 null（恒等）', L.transformAt(3) === null);
  ok('无关键帧 opacityAt 用静态值', near(L.opacityAt(3), 0.5));

  const K = new Layer({
    template: 'x', start: 2, end: 6, opacity: 1,
    keys: { x: [{ t: 0, v: -1, e: 'linear' }, { t: 4, v: 1 }], opacity: [{ t: 0, v: 0 }, { t: 2, v: 1 }] },
  });
  ok('关键帧以图层起点为 0：t=2 时 local=0', near(K.transformAt(2).x, -1));
  ok('关键帧中点：t=4 时 local=2 → x=0', near(K.transformAt(4).x, 0));
  ok('关键帧末端：t=6 时 local=4 → x=1', near(K.transformAt(6).x, 1));
  ok('不透明度关键帧', near(K.opacityAt(2), 0) && near(K.opacityAt(4), 1));
  ok('图层整体后移，动画跟着走', (() => { K.start = 10; return near(K.transformAt(12).x, 0); })());
  ok('animatedProps 只列有动画的通道', animatedProps(K.keys).join(',') === 'x,opacity');
  ok('挂了关键帧即便算成恒等也返回对象', (() => {
    const L2 = new Layer({ template: 'x', keys: { x: [{ t: 0, v: 0 }, { t: 1, v: 0 }] } });
    const v = L2.transformAt(0.5);
    return v !== null && v.x === 0 && v.scale === 1;
  })());

  const M = new Layer({ template: 'x', mask: { shape: 'round', x: 0.1, y: 0.1, w: 0.4, h: 0.4, radius: 0.2 } });
  ok('蒙版归一化保留圆角', M.mask && M.mask.radius === 0.2 && M.mask.shape === 'round');
  ok('整幅无附加的蒙版不落盘', new Layer({ template: 'x', mask: { shape: 'rect', x: 0, y: 0, w: 1, h: 1 } }).mask === null);
  ok('多边形保点', (() => {
    const m = new Layer({ template: 'x', mask: { shape: 'poly', x: 0, y: 0, w: 0.5, h: 0.5, points: [[0, 0], [1, 0], [0.5, 1]] } }).mask;
    return m && m.shape === 'poly' && m.points.length === 3;
  })());
  ok('覆盖整幅的多边形不会被当成"没蒙版"丢掉', (() => {
    const m = new Layer({
      template: 'x',
      mask: { shape: 'poly', x: 0, y: 0, w: 1, h: 1, points: [[0, 0], [1, 0], [0.5, 1]] },
    }).mask;
    return !!m && m.shape === 'poly' && m.points.length === 3;
  })());
  ok('沿画幅四边走一圈的多边形才算没裁', (() => {
    const m = new Layer({
      template: 'x',
      mask: { shape: 'poly', x: 0, y: 0, w: 1, h: 1, points: [[0, 0], [1, 0], [1, 1], [0, 1]] },
    }).mask;
    return m === null;
  })());
  ok('多边形点不够就退回矩形，且退化成"没蒙版"就不落盘', (() => {
    const m = new Layer({ template: 'x', mask: { shape: 'poly', points: [[0, 0]] } }).mask;
    return m === null;   // 退回整幅矩形 = 没裁，按"不落盘"处理
  })());
  ok('toJSON 带 keys 和 mask', (() => {
    const j = K.toJSON();
    return !!j.keys && !!j.keys.x;
  })());
  ok('无动画图层 toJSON 不带 keys', new Layer({ template: 'x' }).toJSON().keys === undefined);
}

console.log('\n== 4. 卡点铺关键帧 ==');
{
  const beat = new BeatMap({ bpm: 120, offset: 0, duration: 8 });   // 每 0.5 秒一拍
  const tr = keysOnBeats(0, 3, beat, [0, 1], 'ramp');
  ok('0~3 秒铺到拍点上', tr.length === 7, tr.map((k) => k.t));
  ok('时间就是拍点', tr.every((k, i) => near(k.t, i * 0.5)));
  ok('值在两组之间轮换', tr[0].v === 0 && tr[1].v === 1 && tr[2].v === 0);
  const step = keysOnBeats(0, 1, beat, [0, 1], 'step');
  ok('step 模式全是定值帧', step.every((k) => k.hold === true));
}

console.log('\n== 5. 缓动表没丢东西 ==');
{
  const names = Object.keys(EASINGS);
  ok('曲线数量 >= 17', names.length >= 17, names.length);
  ok('EASING_LABELS 都能查到实现', EASING_LABELS.every(([k]) => typeof EASINGS[k] === 'function'));
  ok('每个曲线 f(0)=0 且 f(1)=1（弹性/回弹的端点也精确）',
    names.every((n) => near(EASINGS[n](0), 0, 1e-6) && near(EASINGS[n](1), 1, 1e-6)));
  ok('ease() 未知名字有兜底', Number.isFinite(ease('nope', 0.5)));
}

// 蒙版 / 关键帧的"像素级"验证要真 canvas，放在浏览器里跑：
//   node tools/shot.mjs --url "studio/index.html" --js-file tools/ui-keyframe-test.js --out .out/ui-keyframe.png

console.log(`\n================ ${pass} 通过 / ${fail} 失败 ================`);
console.log('checks.all = ' + (fail === 0));
if (fail) process.exit(1);
