// ============================================================================
// 关键帧 / 蒙版 界面级自检
//
// 跑法：
//   node tools/shot.mjs --url "studio/index.html" \
//     --js-file tools/ui-keyframe-test.js --out .out/ui-keyframe.png
//
// 这份脚本是**灌进页面里执行的**（不是模块），所以可以有顶层 return，
// 但 `node --check` 会报错，这是正常的（见 HANDOFF.md 第 6 节）。
//
// 验的是"引擎改动真的通到界面上"：
//   1. 关键帧驱动渲染 —— 同一图层在两帧的位置不一样
//   2. 拖动图层 + 自动打帧 —— 真的在时间轴上落了帧（走真实指针事件）
//   3. 右栏「关键帧」那一块的 ◆ 按钮能打帧 / 删帧
//   4. 时间轴上画出了关键帧菱形，且能被命中
//   5. 蒙版真的裁掉了像素（硬边 / 圆角 / 羽化 / 反选 / 描边）
//   6. 关掉动画之后静态值保留（清动画不会把画面弹回去）
// ============================================================================

const MK = window.MotionKit;
const checks = {};
const notes = [];
const ok = (name, cond, extra) => {
  checks[name] = !!cond;
  notes.push((cond ? 'ok   ' : 'FAIL ') + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
  return !!cond;
};

// ---------------------------------------------------------------- 测试用的"实心"模板
//
// 为什么要自己注册一个，而不是随便拿现成的：工作室里绝大多数模板是"细线 HUD"，
// 蒙版覆盖率这类断言需要一块**确定的实心矩形**，否则量的全是线宽和抗锯齿。
//
// 它一律画不透明**中性灰**，于是：
//   * 覆盖率（非透明像素比例）可以直接当"蒙版裁掉多少"来断言
//   * "白色"只可能来自蒙版的描边 —— 白色占比就能证明描边真画出来了
const SOLID = {
  id: '__ui_test_solid',
  name: '实心测试块',
  category: 'other',
  hint: '自检专用：铺满画面的实心方块',
  params: [],
  draw(ctx, env) {
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, env.width, env.height);
  },
};
MK.registerTemplate(SOLID);   // 注意：不能往 MK.templates() 上 push，它返回的是新数组

/** 渲染结果里"不透明白"的比例 —— 只有蒙版描边会是白的 */
function whiteRatio(step) {
  const s = MK.state.scene;
  const cv = document.createElement('canvas');
  cv.width = s.width; cv.height = s.height;
  const cx2 = cv.getContext('2d', { willReadFrequently: true });
  cx2.drawImage(MK.off.canvas, 0, 0);
  const d = cx2.getImageData(0, 0, s.width, s.height).data;
  const n = Math.max(1, Math.round(step || 4));
  let white = 0, total = 0;
  for (let y = 0; y < s.height; y += n) {
    for (let x = 0; x < s.width; x += n) {
      const i = (y * s.width + x) * 4;
      total++;
      if (d[i + 3] > 200 && d[i] > 235 && d[i + 1] > 235 && d[i + 2] > 235) white++;
    }
  }
  return total ? white / total : 0;
}

const nearlyAllWhite = whiteRatio;

const result = { checks, report: notes };

// ---------------------------------------------------------------- 1. 关键帧驱动渲染
{
  MK.clearLayers();
  MK.addLayer({ template: SOLID.id, start: 0, end: 4, name: 'kf' });
  MK.setScene(MK.getScene());               // 走一遍序列化再回来，确认 keys 能存能读
  MK.setKeys(0, {
    x: [{ t: 0, v: -0.3, e: 'linear' }, { t: 3, v: 0.3 }],
  });
  const a = MK.valueAt(0, 0).transform;
  const b = MK.valueAt(0, 1.5).transform;
  const c = MK.valueAt(0, 3).transform;
  ok('关键帧求值：起点', a && Math.abs(a.x + 0.3) < 1e-3, a && a.x);
  ok('关键帧求值：中点', b && Math.abs(b.x) < 1e-3, b && b.x);
  ok('关键帧求值：终点', c && Math.abs(c.x - 0.3) < 1e-3, c && c.x);

  // 画面上也真的动了：一块实心矩形整体平移。
  // 注意别用"重心"来判断 —— 平移出画幅之后会被裁掉一部分，重心就不再等于中心了
  // （末尾两帧 maxX 都会钉在 1920）。所以改看左右两个边缘各自的行为：往左移时左边缘出界、
  // 往右移时右边缘出界，这两个事实才是"图层确实在动"的证据。
  const edgesAt = (t) => {
    MK.setTime(t);
    const s = MK.state.scene;
    const cv = document.createElement('canvas');
    cv.width = s.width; cv.height = s.height;
    const cx2 = cv.getContext('2d', { willReadFrequently: true });
    cx2.drawImage(MK.off.canvas, 0, 0);
    const d = cx2.getImageData(0, 0, s.width, s.height).data;
    let minX = 1e9, maxX = -1, n = 0;
    for (let y = 0; y < s.height; y += 4) for (let x = 0; x < s.width; x += 4) {
      if (d[(y * s.width + x) * 4 + 3] > 8) { n++; if (x < minX) minX = x; if (x > maxX) maxX = x; }
    }
    return n ? { minX, maxX, n } : null;
  };
  const e0 = edgesAt(0), e1 = edgesAt(1.5), e2 = edgesAt(3);
  // 中点能看见整块，两端各被画幅裁掉一块 —— 这个"可见面积先增后减"的形状就是它在动的证据
  ok('关键帧让画面真的移动了', !!e0 && !!e1 && !!e2 && e1.n > e0.n && e1.n > e2.n,
    [e0 && e0.n, e1 && e1.n, e2 && e2.n]);
  ok('起点往左溢出（左边缘被裁到 0）且总量变少', e0.minX === 0 && e0.n < e1.n, [e0.minX, e0.n, e1.n]);
  ok('终点往右溢出（右边缘顶到画幅右边）且右边缘确实比起点更靠右',
    e2.maxX >= 1912 && e2.maxX > e0.maxX, [e2.maxX, e0.maxX]);
  ok('终点左边缘在画面内（整块往右挪了）', e2.minX > 400, e2.minX);

  // 序列化能带出去
  const json = MK.getScene();
  ok('keys 进了工程 JSON', !!(json.layers[0].keys && json.layers[0].keys.x), json.layers[0].keys && json.layers[0].keys.x.length);
  MK.setScene(json);
  ok('从 JSON 读回来还能求值', (() => {
    const v = MK.valueAt(0, 1.5);
    return v && v.transform && Math.abs(v.transform.x) < 1e-3;
  })());
}

// ---------------------------------------------------------------- 2. 真实拖动 + 自动打帧
{
  MK.clearLayers();
  MK.autoKey(true);
  const L = MK.addLayer({ template: SOLID.id, start: 0, end: 6, name: 'drag' });
  MK.setTime(0);
  MK.selectLayer(L.id);

  const rect = MK.editRect();
  const el = document.getElementById('editLayer');
  const pd = (type, x, y) => el.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0, buttons: 1, isPrimary: true,
  }));
  const winPd = (type, x, y) => window.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0, buttons: 1, isPrimary: true,
  }));
  const centerOf = () => {
    const b = MK.layerBox(0);
    return { x: rect.x + (b.x + b.w / 2) * rect.w, y: rect.y + (b.y + b.h / 2) * rect.h };
  };

  let c = centerOf();
  pd('pointerdown', c.x, c.y);
  winPd('pointermove', c.x + 60, c.y);
  winPd('pointerup', c.x + 60, c.y);
  const k1 = MK.keys(0);
  ok('拖动 + 自动打帧：落了 x/y 关键帧', !!(k1 && k1.x && k1.x.length === 1 && k1.y && k1.y.length === 1),
    k1 && k1.x && k1.x.map((k) => [k.t, Math.round(k.v * 1000) / 1000]));
  ok('落帧的时间就是播放头（图层内 0s）', !!(k1 && k1.x && k1.x[0].t === 0), k1 && k1.x && k1.x[0].t);
  const x1 = k1.x[0].v;

  // 挪到 2 秒再拖一次 → 应该多出第二个关键帧，且值不一样
  MK.setTime(2);
  c = centerOf();
  pd('pointerdown', c.x, c.y);
  winPd('pointermove', c.x + 60, c.y);
  winPd('pointerup', c.x + 60, c.y);
  const k2 = MK.keys(0);
  ok('第二个时间点再拖 → 第二个关键帧', !!(k2 && k2.x && k2.x.length === 2), k2 && k2.x && k2.x.map((k) => k.t));
  ok('两次拖的 x 值不同（真的记下了变化）',
    !!(k2 && k2.x && Math.abs(k2.x[0].v - k2.x[1].v) > 1e-4),
    k2 && k2.x && k2.x.map((k) => Math.round(k.v * 1000) / 1000));
  ok('关键帧值跟拖动方向一致（往右拖 = x 变大）', k2.x[1].v > x1, [x1, k2.x[1].v]);

  // 静态值也跟着更新（关掉动画之后画面不该弹回去）
  const trNow = MK.state.scene.layers[0].transform;
  ok('打帧时静态值同步更新', !!trNow && Math.abs(trNow.x - k2.x[1].v) < 1e-6, trNow && trNow.x);

  MK.autoKey(false);
}

// ---------------------------------------------------------------- 3. 右栏 ◆ 按钮
{
  const L = MK.state.scene.layers[0];
  MK.selectLayer(L.id);
  MK.setTime(4);
  const before = MK.keyCount(0, 'rot');
  const added = MK.toggleKey(0, 'rot');
  ok('◆ 按钮能补关键帧', added.count === before + 1, [before, added.count]);
  ok('补的帧就在播放头处', MK.keyAtPlayhead(0, 'rot') === true);
  const removed = MK.toggleKey(0, 'rot');
  ok('再点一下删掉', removed.count === before, [before, removed.count]);

  // 界面里真有那一排按钮
  const dots = document.querySelectorAll('.kf-dot');
  ok('右栏渲染出 7 颗 ◆（7 个通道）', dots.length === 7, dots.length);
  ok('有动画的通道标成 has', !!document.querySelector('.kf-dot.has'));
  ok('时间轴提示文案在', !!document.querySelector('.kf-list .kf-row'));
}

// ---------------------------------------------------------------- 4. 时间轴菱形
{
  MK.setTime(0);
  const dots = MK.keyDots();
  ok('时间轴画出了关键帧菱形', dots.length >= 2, dots.length);
  ok('菱形带命中半径', dots.every((d) => d.r > 2));
  ok('菱形分布在不同的 x 上（不是叠在一起）',
    new Set(dots.map((d) => Math.round(d.x))).size >= 2, new Set(dots.map((d) => Math.round(d.x))).size);
}

// ---------------------------------------------------------------- 5. 蒙版
{
  MK.clearLayers();
  MK.addLayer({ template: SOLID.id, start: 0, end: 4, name: 'mask' });
  MK.setTime(1);
  const full = MK.opaqueStats(8);
  ok('无蒙版：实心块画满整幅', full.ratio > 0.97, Math.round(full.ratio * 1000) / 1000);

  // 每一处都用"相对 100% 的比例"来断言，比绝对值好读，也不受抽样步长影响
  // 硬边矩形是"像素级确定"的，所以给它严格断言；其余形状会去走离屏 alpha，
  // 那一步的合成顺序错了会**静默退化成整幅**（数值正好是 1.0），靠下面这些对照来抓。
  const ratio = (mask) => { MK.setMask(0, mask); return MK.opaqueStats(8).ratio; };

  const hard = ratio({ shape: 'rect', x: 0, y: 0, w: 0.5, h: 0.5 });
  ok('硬边矩形正好留下 1/4', Math.abs(hard - 0.25) < 0.01, Math.round(hard * 1000) / 1000);

  const round = ratio({ shape: 'round', x: 0.25, y: 0.25, w: 0.5, h: 0.5, radius: 0.25 });
  ok('圆角矩形比直角小一点', round > 0.20 && round < 0.25, Math.round(round * 1000) / 1000);

  const ell = ratio({ shape: 'ellipse', x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
  ok('椭圆面积 ≈ π/4 × 框（约 0.196）', Math.abs(ell - 0.196) < 0.02, Math.round(ell * 1000) / 1000);

  const inv = ratio({ shape: 'rect', x: 0.25, y: 0.25, w: 0.5, h: 0.5, invert: true });
  ok('反选：留下约 3/4', Math.abs(inv - 0.75) < 0.01, Math.round(inv * 1000) / 1000);
  ok('反选蒙版没被跳过（不是整幅）', inv < 0.95, Math.round(inv * 1000) / 1000);

  const poly = ratio({ shape: 'poly', x: 0, y: 0, w: 1, h: 1, points: [[0, 0], [1, 0], [0.5, 1]] });
  ok('多边形（三角形）留下约 1/2', Math.abs(poly - 0.5) < 0.03, Math.round(poly * 1000) / 1000);
  ok('多边形蒙版没被跳过（不是整幅）', poly < 0.95, Math.round(poly * 1000) / 1000);

  // 羽化：同样的框，羽化之后出现半透明过渡带（硬边是没有的）
  MK.setMask(0, { shape: 'rect', x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
  const hardStats = MK.opaqueStats(4);
  MK.setMask(0, { shape: 'rect', x: 0.25, y: 0.25, w: 0.5, h: 0.5, feather: 0.15 });
  // 只读一次：MK.opaqueStats 自己会重新渲染，再调一次 setMask 会覆盖掉这次的结果
  const softStats = MK.opaqueStats(4);
  ok('硬边蒙版几乎没有半透明像素', hardStats.partial < 200, hardStats.partial);
  ok('羽化蒙版出现半透明过渡带', softStats.partial > 500, softStats.partial);
  ok('羽化蒙版没被跳过（不是整幅）', softStats.ratio < 0.4 && softStats.partial > 500,
    [Math.round(softStats.ratio * 1000) / 1000, softStats.partial]);

  // 描边：白边真的画出来了（模板是灰的，白只可能来自描边）
  MK.setMask(0, { shape: 'round', x: 0.2, y: 0.2, w: 0.6, h: 0.6, radius: 0.1 });
  const noStroke = whiteRatio(4);
  MK.setMask(0, { shape: 'round', x: 0.2, y: 0.2, w: 0.6, h: 0.6, radius: 0.1, stroke: { width: 0.03, color: '#ffffff' } });
  const withStroke = whiteRatio(4);
  const strokeStats = MK.opaqueStats(4);
  ok('描边蒙版仍然画出了东西', strokeStats.ratio > 0.3, Math.round(strokeStats.ratio * 1000) / 1000);
  ok('没描边时画面里没有白', noStroke < 0.002, noStroke);
  ok('加了描边就出现白边', withStroke > noStroke + 0.005, [noStroke, withStroke]);
  ok('描边细一点白边也细一点', (() => {
    MK.setMask(0, { shape: 'round', x: 0.2, y: 0.2, w: 0.6, h: 0.6, radius: 0.1, stroke: { width: 0.008, color: '#ffffff' } });
    const thin = whiteRatio(4);
    return thin > noStroke && thin < withStroke;
  })());

  // 蒙版要能落盘 / 读回来
  MK.setMask(0, { shape: 'round', x: 0.2, y: 0.2, w: 0.6, h: 0.6, radius: 0.1, stroke: { width: 0.03, color: '#ffffff' } });
  const j = MK.getScene();
  ok('mask 进了工程 JSON', !!(j.layers[0].mask && j.layers[0].mask.shape === 'round'), j.layers[0].mask);
  MK.setScene(j);
  ok('mask 从 JSON 读回来还在', !!(MK.getMask(0) && MK.getMask(0).stroke), MK.getMask(0));
  ok('读回来之后仍然裁得对', (() => { MK.setMask(0, { shape: 'rect', x: 0, y: 0, w: 0.5, h: 0.5 }); return Math.abs(MK.opaqueStats(8).ratio - 0.25) < 0.01; })());

  // 界面里那两块面板在。
  // 注意：选图层用的是**图层 id**，不是下标（`MK.layerBox(0)` 那种才收下标）。
  MK.setMask(0, { shape: 'round', x: 0.2, y: 0.2, w: 0.6, h: 0.6, radius: 0.1, stroke: { width: 0.03, color: '#ffffff' } });
  MK.selectLayer(MK.state.scene.layers[0].id);
  const titles = [...document.querySelectorAll('.group h4')].map((e) => e.textContent);
  ok('右栏有「蒙版 / 裁剪」这一块', titles.includes('蒙版 / 裁剪'), titles);
  ok('右栏有「关键帧动画」这一块', titles.includes('关键帧动画'), titles);
  const labels = [...document.querySelectorAll('.field label')].map((e) => e.textContent);
  ok('蒙版面板给出了形状 / 宽 / 高 / 圆角 / 描边',
    ['形状', '宽', '高', '圆角', '描边粗细', '羽化'].every((k) => labels.includes(k)), labels);
  ok('蒙版面板里形状下拉停在 round',
    (() => {
      const f = [...document.querySelectorAll('.field')].find((d) => d.querySelector('label') && d.querySelector('label').textContent === '形状');
      const s = f && f.querySelector('select');
      return !!s && s.value === 'round' && [...s.options].some((o) => o.value === 'poly');
    })());
  ok('关掉蒙版之后面板回到"还没蒙版"的样子',
    (() => {
      MK.setMask(0, null);
      const f = [...document.querySelectorAll('.field')].find((d) => d.querySelector('label') && d.querySelector('label').textContent === '形状');
      const s = f && f.querySelector('select');
      return !!s && s.value === '';
    })());
}

// ---------------------------------------------------------------- 6. 清动画保留静态值
{
  MK.clearLayers();
  const L = MK.addLayer({ template: SOLID.id, start: 0, end: 4, name: 'clear' });
  MK.setKeys(0, { x: [{ t: 0, v: -0.3, e: 'linear' }, { t: 2, v: 0.3 }] });
  MK.setTime(2);
  const mid = MK.valueAt(0).transform.x;
  // 走界面那条路：清掉整层动画
  MK.selectLayer(L.id);
  const btnClear = [...document.querySelectorAll('button')].find((b) => /清掉整层动画/.test(b.textContent || ''));
  ok('找得到「清掉整层动画」按钮', !!btnClear);
  window.confirm = () => true;
  if (btnClear) btnClear.click();
  ok('动画清掉了', MK.keys(0) === null, MK.keys(0));
  const after = MK.valueAt(0).transform;
  ok('静态值保留了这一刻的位置', after && Math.abs(after.x - mid) < 1e-3, [mid, after && after.x]);
}

// ---------------------------------------------------------------- 7. 旧工程兼容
{
  // 没有 keys / mask 的老工程 JSON 必须照常能读
  const old = {
    name: 'legacy', width: 1920, height: 1080, fps: 24, duration: 5, transparent: true,
    beat: { bpm: 120, offset: 0, duration: 5, source: 'bpm' },
    layers: [{ template: SOLID.id, start: 0, end: 2, params: {}, seed: 's', opacity: 1, blend: 'source-over', enabled: true, name: 'old', transform: { x: 0.1, y: 0, scale: 1, rot: 0, px: 0.5, py: 0.5 } }],
    captions: [], clips: [], fx: [],
  };
  const s = MK.setScene(old);
  const L = MK.state.scene.layers[0];
  ok('老工程读进来：keys 是 null', L.keys === null || L.keys === undefined);
  ok('老工程读进来：mask 是 null', L.mask === null || L.mask === undefined);
  ok('老工程读进来：静态变换还在', (() => { const v = MK.valueAt(0, 1); return v && v.transform && Math.abs(v.transform.x - 0.1) < 1e-6; })());
  MK.setTime(1);
  const st = MK.opaqueStats(8);
  ok('老工程照样渲染出画面', st.ratio > 0.8, Math.round(st.ratio * 1000) / 1000);
  const out = MK.getScene();
  ok('再存出去不带多余的 keys/mask', out.layers[0].keys === undefined && out.layers[0].mask === undefined);
}

result.checks.all = Object.values(checks).every(Boolean);
window.__mkReport = result;
return result;
