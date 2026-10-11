# 交接说明（HANDOFF）

> 更新于 **2026-10-12**，给「下一个接手这个项目的人 / 另一个 AI 会话」看的。
> 这份文件说明：**现在代码是什么状态、最近这一轮改了什么、下一步该干什么、有哪些坑**。
> 读完这份 + `README.md` 就够开工了；引擎/工作室的详细架构见第 5 节。

---

## 1. 仓库状态（重要）

| 项 | 值 |
| --- | --- |
| 分支 | `main`，与 `origin/main` 同步（`git@github.com:cxhzzb/motionkit.git`） |
| 上一轮 HEAD | `4512817` 加 MIT 许可证（2026-10-09） |
| 本轮改动 | **未提交**，见下面第 3 节 |

**⚠️ 仓库路径变了**：项目现在在 `F:\KIMi kit\动效JS插件`，
以前是 `F:\KIMI小工具\动效JS插件`（那个目录现在是**空的**）。
DSH 会话的工作区如果还指向旧路径，会看到"什么都没有" —— 不是项目没了，是路径变了。

---

## 2. 这一轮干了什么：把 README 点名没做的**四项全部补齐**

README 以前自己列了一张缺口清单：**关键帧动画 / 蒙版裁剪 / 画中画圆角描边 / 音频降噪**。
这一轮四项都做完了。分两批提交（第一批关键帧+蒙版，第二批音频降噪）。

### 2.1 关键帧动画（新能力，最大的一块）

以前图层的位移 / 缩放 / 旋转 / 不透明度是**每层一个常数**。现在按时间动起来。

**新文件 `engine/keyframes.js`** —— 关键帧的数据模型与求值，独立于 core.js：

```js
layer.keys = {
  x: [ {t:0, v:-0.3, e:'outBack'}, {t:1.2, v:0}, {t:2.5, v:0.3} ],
  opacity: [ {t:0, v:0}, {t:0.4, v:1, hold:true} ],
}
```

- `{t, v}` 第 t 秒的值是 v；从这一帧到下一帧用 `e` 指定的曲线
- `{t, hold:true}` **定值帧**：值沿用到下一个关键帧（跳变，不插值）
- `{t, e}` 只有缓动的**标记帧**：不产生新值，只改"从这里往后"的缓动
- `t` 是**相对图层起点**的秒数 —— 图层整体挪时间，动画跟着走

**新文件 `engine/easing.js`** —— 把 17 条缓动曲线从 core.js 搬出来独立成文件。
**为什么必须搬**：关键帧模块要求值，core.js 又要 import 关键帧模块，曲线留在 core.js 就是循环依赖。
core.js 开头把 `clamp / lerp / EASINGS / ease …` **原样再导出一次**，所以
`import { clamp } from '../engine/core.js'` 这种老写法全都还能用，模板一个都没改。

**表达式**（值可以直接写字符串，不落成一堆关键帧）：
`@beat`（拍序号）、`@beatPhase`（离拍点秒差）、`@beatProg`、`@t`、`@local`、`@progress`、
`@osc` / `@sin` / `@cos`。求值上下文由 `renderFrame` 构造并传进去。

**API**：`Layer.keys` / `Layer.transformAt(t)` / `Layer.opacityAt(t)` / `Layer.animated`，
core.js 里一并 re-export 了 `setKey / removeKey / moveKey / setKeyEasing / keyIndexAt /
keyTimes / trackRange / animatedProps / keysOnBeats / normalizeKeys / normalizeTrack`。

**界面（studio.js）**：

- 右栏「图层」页新增第三块 **关键帧动画**：自动打帧开关、通道下拉、
  7 颗 ◆（加/删当前时刻的帧，已有关键帧=青色实心、此刻有=亮蓝底）、
  当前帧的缓动下拉、定值帧开关、删这一帧、全部动画通道一览、清掉整层动画、每拍打一帧
- **自动打帧**：开了之后在预览里拖 / 缩放 / 旋转 / 改不透明度，就在当前时间自动落帧。
  已经在动的通道**不需要重复开**（`shouldKey()`：有动画 or 自动打帧）
- 所有写变换的入口统一走 `setTransformValue()`，打帧时**同时更新静态值**
  —— 这样关掉动画之后画面停在最后摆的位置，不会突然弹回去
- 时间轴上（选中/主选的层）画出**关键帧菱形**，可**拖动改时间**（吸附卡点）、
  **Shift 点=删帧**，命中区存在 `keyDotMap`
- 拖拽 / 选择框 / 命中测试全部改成走 `layerTrAt(L)`（= `L.transformAt(state.t)`），
  否则动起来的图层会"画在这、选择框在那"

### 2.2 蒙版 / 裁剪（含画中画圆角描边）

**`engine/core.js` 新增**：`MASK_SHAPES`、`normalizeMask`、`maskPath`、`maskNeedsAlpha`、
`applyMaskAlpha`、`featherRing`。`Layer.mask` 落盘。

```js
layer.mask = {
  shape: 'rect'|'round'|'ellipse'|'poly',
  x, y, w, h,            // 归一化画布坐标（0..1）
  radius,                // 圆角（占框短边比例）
  feather,               // 边缘羽化
  invert,                // 反选 = 挖洞
  points: [[x,y], …],    // poly 用
  stroke: { width, color },   // 画中画的边框
}
```

**渲染改了两条路，而且只能走一条**（这里踩了个大坑，见第 4 节）：

- 硬边矩形 / 椭圆 / 圆角矩形 → 直接在总画布上 `clip()`
- 有羽化 / 反选 / 多边形 / 描边 → 先画到离屏（`deps.scratch`），
  按蒙版削 alpha，再整体贴回总画布

**界面**：右栏「图层」页第四块 **蒙版 / 裁剪**（形状下拉 + 左/上/宽/高 + 圆角 + 羽化 +
反选 + 描边粗细/颜色 + 铺满画面 / 居中 50% / 去掉蒙版）。

### 2.3 修掉的既有 bug（顺手，但值得单独说）

1. **`MotionKit.setScene()` 不重新渲染** —— 换完工程 canvas 里还是旧画面。
   外部脚本（自检 / 自动化）刚 setScene 就读像素会读到上一份工程。已补 `renderAt + blit`。
2. **`MotionKit` 没导出注册模板的入口** —— 自检没法注册自己的测试模板。
   已加 `MotionKit.registerTemplate`。**注意 `MK.templates()` 每次返回新数组，往它 push 没用。**
3. **覆盖整幅的多边形蒙版会被当成"没蒙版"丢掉** —— `normalizeMask` 用
   `x=0,y=0,w>=1,h>=1` 判断"整幅=没裁"，但一个覆盖整幅的**三角形**同样满足这个条件，
   它是真在裁的。已加 `polyCoversWholeFrame()` 逐边采样区分。

### 2.4 音频降噪（只在导出时生效）

现场收音的三类噪声分开治：**高通**（低频轰鸣/空调）、**低通**（嘶声）、
**门限**（稳定底噪）。

**`engine/audio.js` 新增**：`resolveDenoise`（参数解析 + 全关时返回 null 让调用方跳过整条链路）、
`analyzeNoise`（底噪/信噪比/频谱分析 + 自动建议）、`describeDenoise`、`gateCurve`、
`buildDenoiseChain`、`DENOISE_RANGE`。

**链路**：`src → [高通] → [低通] → [门限] → gain → 目的地`，三个节点按需插入。
挂在音量包络**前面**：先滤波再算音量，淡入淡出才不会被滤波器拖尾污染。

**门限是个真门**（低于阈值直接归零），用 `WaveShaper` 逐样本映射实现。
这里连踩三个坑，都写进第 4 节了。

**界面**：右栏「降噪」块（总强度 / 高通 / 低通 / 门限 / 门限力度 / 补偿增益），
**自动分析**（量出这一段再填好参数）、**听一下这段**（原声 3 秒 → 降噪后 3 秒连着放）。

**为什么不走 ffmpeg 那条路**：导出的 MP4 音轨是前端用 Web Audio 离线渲染 + `AudioEncoder`
编出来的（`engine/mp4.js` 只负责封装），所以降噪放在 Web Audio 链上才是导出时真正生效的地方；
另起一套 ffmpeg 滤镜会变成两条不一致的路径。

### 2.5 自检（累计）

- `tools/keyframe-test.mjs` — **引擎级，59 项，不用浏览器**：
  求值 / 缓动 / 定值帧 / 同刻去重 / 表达式 / 编辑 API / 卡点铺帧 /
  `Layer.transformAt` 以图层起点为 0 / 蒙版归一化与退化 / 缓动表完整性
- `tools/ui-keyframe-test.js` — **界面级，53 项**（跑 `tools/shot.mjs`）：
  真实指针事件拖动 + 自动打帧、◆ 按钮、时间轴菱形、
  蒙版逐形状的**像素覆盖率**（硬边正好 1/4、椭圆 ≈ π/4、反选 ≈ 3/4、三角形 ≈ 1/2）、
  羽化出半透明过渡带、描边出白边且粗细可控、老工程（无 keys/mask）兼容
- `tools/denoise-test.mjs` — **引擎级，41 项**：
  参数解析与缩放、越界夹取、低通/高通互相矛盾的兜底、
  底噪与频谱分析在"干净/带噪/低频轰鸣/高频嘶声/纯静音"五种信号上的判定、
  建议值自洽、Clip 字段落盘与"没开就不落盘"
- `tools/ui-denoise-test.js` — **音频级，31 项**（真跑 `AudioContext`）：
  高通真的砍掉 80Hz、低通真的收掉 9kHz、门限把安静段压到 0 而**响内容一丝不动**、
  门限曲线阈值以上严格恒等且是奇函数、关掉降噪时输出与输入逐样本相同、
  参数落盘读回、右栏面板齐全、自动分析能认出低频轰鸣
- `tools/ui-delete-test.js` — **界面级，26 项**：
  点动效图层之后片段选中必须让位、`Del` 删的到底是谁（两边各验一遍，互相不许误伤）、
  误删之后 `Ctrl+Z` 能把片段救回来、素材缓存在宽限期内不许被抹掉、
  过了宽限期才真回收

---

## 3. 本轮改动清单

**第一批（已提交 `190a83a`）**：关键帧动画 + 图层蒙版 / 裁剪

```
 M README.md                        # 新增「关键帧动画」「蒙版 / 裁剪」两节 + 预览图
 M dist/studio.html                 # 重新打包
 M docs/命令速查.md                  # 关键帧 / 蒙版自检命令
 M engine/core.js                   # keys + mask + renderFrame 两条路 + setScene 修复
 M presets/index.json               # 登记 keyframe-demo
 M studio/studio.css                # 关键帧面板样式（.kf-*）
 M studio/studio.js                 # 关键帧 / 蒙版 UI、自动打帧、时间轴菱形、layerTrAt
?? engine/easing.js                 # 缓动曲线（从 core.js 搬出来，避免循环依赖）
?? engine/keyframes.js              # 关键帧模型 + 求值 + 编辑
?? presets/keyframe-demo.json       # 关键帧 / 蒙版演示工程
?? tools/keyframe-test.mjs          # 引擎级自检（59 项）
?? tools/ui-keyframe-test.js        # 界面级自检（53 项）
?? docs/preview-keyframes.png       # README 预览图
```

**第三批**：修"想删动效却把视频/音频删了"

```
 M README.md                        # 新增「Del 到底会删掉什么」一节
 M HANDOFF.md                       # 这一份（含 4.6 节那三个坑）
 M dist/studio.html                 # 重新打包（761.8 KB / 28 个模块）
 M docs/命令速查.md                  # 删除归属的自检命令
 M studio/studio.js                 # 两种选中互斥、删除前封存历史点、素材 5 分钟宽限期
?? tools/ui-delete-test.js          # 回归自检（26 项）
```

**第二批**：音频降噪

```
 M README.md                        # 新增「音频降噪」一节 + 自检命令
 M HANDOFF.md                       # 这一份
 M dist/studio.html                 # 重新打包（753.6 KB / 28 个模块）
 M docs/命令速查.md                  # 降噪自检命令
 M engine/audio.js                  # resolveDenoise / analyzeNoise / gateCurve / buildDenoiseChain
 M engine/core.js                   # Clip 增加 denoise / highpass / lowpass / gate / gateRatio / audioGain
 M studio/studio.js                 # 降噪面板、自动分析、试听、mixClipAudio 接链、自检接口
?? tools/denoise-test.mjs           # 引擎级自检（41 项）
?? tools/ui-denoise-test.js         # 音频级自检（31 项）
```

**提交前记得 `npm run bundle`**（`dist/studio.html` 是故意留在仓库里的交付物）。
`agent/schema.json` 这两批**都不用重新生成** —— 模板参数没动
（加的是图层级的 keys/mask 和片段级的降噪字段，都不是模板参数）。

---

## 4. 这一轮踩到的坑（省得重新踩）

### 4.1 蒙版静默失效：同一层被画了两遍

`renderFrame` 原来是"总画布上无条件画一遍 + 需要时再在离屏上画一遍"。
于是需要蒙版时，**总画布上已经留了一份没被裁过的像素**，离屏那份再怎么削 alpha 也削不掉它
—— 结果只有硬边裁剪那条路看着是对的，**羽化 / 反选 / 多边形 / 描边全部静默失效**
（静默 = 画面看着"没效果"，不报错）。

改成 `if (useScratch) {…离屏…} else {…直接裁剪…}`，两条路互斥。

### 4.2 `roundRect()` 会夹半径，负 inset 会被吃掉

羽化原来用"一条 createLinearGradient 描边"实现：`maskPath(…, -inset)` 想从外轮廓往内收。
但 canvas 的 `roundRect` 会把半径**夹到 min(w,h)/2**，负 inset 直接把矩形退化了，
描边画到形状外面、再被 `destination-in` 裁掉 —— 又是静默失效。
而且描边只有**一个渐变轴**，跟轴垂直的那两条边永远是硬边。

现在用 `featherRing()`：从边缘往内铺 5 层由内到外逐渐变淡的描边，
每层都 `clip()` 在形状里（羽化不会长到蒙版外面），并把 alpha 乘进 `destination-out`。

### 4.3 `MotionKit.templates()` 返回的是新数组

`listTemplates()` 里是 `[...registry.values()]`，往它上面 `push` **不会**注册模板，
`getTemplate()` 也找不到 → 图层静默不画（`layerBaseBox` 返回 null、`opaqueStats` 全是 0）。
要注册就用新加的 `MK.registerTemplate(def)`。

### 4.4 自检里的两个经典误判

- **别用"非透明像素重心"判断图层在动**：图层平移出画幅之后会被裁掉一块，
  重心就不再等于中心了（末端两帧 `maxX` 都钉在画幅边上）。
  要看边缘 / 可见面积，别看重心。
- **别连续调两次 `setMask` 再读一次统计**：`opaqueStats` / `renderAt` 自己会重新渲染，
  中间那次 `setMask` 会把上一次的结果覆盖掉。一次 `setX` 配一次测量。

### 4.5 噪声门连踩三个坑（都是"听着像没效果/效果不对"，不报错）

1. **拿 DynamicsCompressor 当噪声门是不行的**：压缩器是**按比例**往下压，
   安静处的底噪只能被压小几个 dB（实测安静段 RMS 只降了约 10%，等于没做）。
   而把阈值调低去"够到"底噪，正常内容会被一起压瘪（实测大声段掉了 **60%**）。
   真门需要"低于阈值直接归零"→ 只能用 `WaveShaper` 做逐样本映射。
2. **`WaveShaper.curve` 的定义域只能是 `[-1, 1]`**：它把输入 x 直接按
   `index = (x+1)/2*(N-1)` 取表，**不会**按你给表的"语义范围"去缩放。
   我一开始为了"给超过 0dBFS 留余量"把表铺到 `[-1.2, 1.2]`，
   结果整条曲线被横向拉伸 1.2 倍 —— 恒等段变成 `x * 1.2`，响内容整体偏大 **20%**。
   输入超过 ±1 的部分让 WaveShaper 自己夹就行。
3. **`oversample` 别乱开**：`'2x'` 会额外引入电平偏移（实测约 10%）。
   门限对阈值以上本该**完全透明**，所以宁可不开（这条软膝曲线上的混叠听不出来）。

判断门限对不对，只要问一句："**阈值以上的内容有没有被动过？**"
自检就是这么验的：拿 0.5 / 0.3 两种幅度的正弦过一遍门限，要求 RMS 变化 < 3%。

### 4.6 "想删一个动效，结果把视频/音频整条删掉了"（用户实际报的 bug）

两个各自独立的原因叠在一起，都会造成同一现象：

1. **图层选中和片段选中是两套互不相干的状态**：`state.selection`（图层）和
   `state.clipSel`（素材片段）谁都不清谁。而 Delete 键的判断是
   `if (selectedClip()) deleteSelectedClip(); else deleteSelectedLayers();` ——
   只要有片段选中就**优先删片段**。载入视频/音乐会自动选中新片段，之后用户点一个
   动效图层（`selectLayer()` 只设 `state.selection`），`clipSel` 还留着 →
   按 Delete 删掉的是底下的视频/音频，连素材一起释放。
   **修法**：两种选中做成互斥，全部收敛到 `selectClip()` / `selectClipOnly()` /
   `selectLayer()` 三个函数，任何时刻只有一种东西是"选中"的。

2. **历史会把"删除前"那一版吃掉**：`historyTick()` 默认把 800ms 内的改动并成一条。
   "刚改完就删"时，删除前那一版还没被记录，紧接着的 tick 记录的是删除后的状态，
   Ctrl+Z 只能回到更早的某一点 —— 片段救不回来。
   **修法**：删除前 `historyTick(true)` 强开一条并**封存**（`history.sealed`），
   后续 tick 不再并进它。注意**两个坑**：光 force 开新记录不够（下一次自动 tick
   还会并进去，所以必须一起封存）；而且 force 时不能因为
   `json === history.last` 就 early-return（那一刻栈顶往往还是更早的一版，
   得先把中间版补进去），否则"删之前"这个点根本没落到栈上。

3. **素材缓存被立刻抹掉**：`releaseAssetIfUnused()` 原来判定没人用就立刻
   `idbDel('asset:'+id)`。撤销只还原工程 JSON，素材二进制是单独存的，
   所以"误删 → 撤销"会把片段还原回来、素材却没了，画面是空的。
   **修法**：加 5 分钟宽限期（`pendingAssetPurge`），过了才真回收；
   同时 `restoreHistory()` 补一次 `restoreAssets()` 从 IndexedDB 回读。

回归自检：`tools/ui-delete-test.js`（26 项）。这个 bug 的价值在于 ——
它证明了"自检不能只验功能对不对，还得验**破坏性操作打到了谁**"。

### 4.7 老坑（仍然有效）

- **版本号两处**：`tools/serve.mjs:APP_VERSION` ↔ `studio/studio.js:NEED`，加接口必须同时 +1
- **`dist/studio.html` 必须重新打包**才算改完
- **模板 id / 参数名被硬编码在多处**：`studio.js` 的 `TEXT_SLOT` / `CAPTION_LOOKS` / `BEAT_FX`，
  以及 Python 侧 `agent/director.py` / `agent/fill.py` 各有一份复制的样子池 —— JS + Python 要一起改
- **`agent/schema.json` 是生成物**：改模板参数忘了 `node tools/schema.mjs`，Python 侧会静默丢键
- **正则打包器**：`tools/bundle.mjs` 只认 `import … from '…'`，不支持裸 `import 'x'` /
  `export * from` / 动态 `import()`
- **渲染带副作用**：`renderAt()` 每帧会调 `syncTransitionLayers()` 增删改 `state.scene.layers`
- **`layer.id` 不落盘**（`clip.id` 落盘），重新载入工程后图层 id 全变
- **`file://` 下的单文件版在这台机器上测不了**（路径里有中文，无头 Chrome 初始化超时）——
  这是**既有问题**，不是新引入的；验证单文件版请走 http 起的服务

---

## 5. 架构速查

| 文件 | 干什么 |
| --- | --- |
| `engine/core.js` | 数学 / 节拍图 / Layer·Clip·Scene / `renderFrame` 帧调度 / 蒙版几何 |
| `engine/easing.js` | 17 条缓动曲线 + `EASINGS` + `EASING_LABELS`（UI 下拉直接用） |
| `engine/keyframes.js` | 关键帧模型 / 归一化 / 求值 / 编辑 / 卡点铺帧 / 表达式 |
| `engine/draw.js`·`fx.js`·`audio.js`·`srt.js`·`mp4.js`·`zip.js` | 绘图原语 / 后期特效栈 / 音频分析 / 字幕 / MP4 封装 / zip |
| `studio/studio.js` | 工作室全部逻辑（预览 / 参数 / 时间轴 / 导出 / 关键帧 / 蒙版） |
| `templates/*.js` | 50 个动效模板 |
| `tools/serve.mjs` | 开发服务器 + AI 后端中转 |
| `tools/render.mjs`·`shot.mjs` | 无头渲染 / 截图与自检驱动 |

**渲染一帧的路径**：`renderAt(t)` → `renderFrame(ctx, scene, t, deps)` →
每层取 `layer.transformAt(t)` / `layer.opacityAt(t)` / `layer.mask` → 两条路二选一 → 最后跑 `fxRunner`。

---

## 6. 下一步（四项缺口已经补完，下面是把它们做深的顺序）

1. **给关键帧加曲线编辑器**：现在是"选一条预设曲线"，没有贝塞尔手柄。
2. **蒙版再强一点**：多蒙版叠加 / 布尔运算 / 蒙版路径本身打关键帧（现在蒙版是静态的）。
3. **调色关键帧**：`clip.grade` 还是常量。
4. **降噪再进一步**：现在只有高通 / 低通 / 门限。真·降噪（`afftdn` 那类谱减法）
   需要 FFT 逐帧处理，Web Audio 没有现成节点；如果要做，考虑走
   `AudioWorklet`，或者导出一条 wav 交给 Python 侧的 ffmpeg 再封装。
5. **音频也支持关键帧**：音量现在是片段级的常量包络（淡入/淡出），不能任意画曲线。

---

## 7. 这次会话没做的事（明确记一下）

- **没有在真实成片上验证**关键帧 / 蒙版 / 降噪 —— 只跑了演示预设和自检
  （真实素材 + 长工程下的性能没测：羽化蒙版每帧多一次离屏，层多的时候要留意帧率）
- **没有跑 whisper 转写**（环境只验证到能 import）
- 音频降噪的"听感"只在合成信号上量过电平，**没有用真实带噪素材听过**
  —— 自动分析给的档位可能还需要按真实素材微调
