# 交接说明（HANDOFF）

> 写于 **2026-10-06 02:57**，给「下一个接手这个项目的人 / 另一个 AI 会话」看的。
> 这份文件说明：**现在代码是什么状态、这一轮改了什么、下一步该干什么、有哪些坑**。
> 读完这份 + `README.md` 就够开工了；引擎/工作室的详细架构见第 6 节。

---

## 1. 仓库状态（重要）

| 项 | 值 |
| --- | --- |
| 分支 | `main`，与 `origin/main` **完全同步**（`git@github.com:cxhzzb/motionkit.git`） |
| HEAD | `b8c939a` 增加自动字幕、网络视频下载与素材删除清理（2026-10-04） |
| 未推送的提交 | 无 |
| 工作区 | **有一批未提交的改动**（见第 3 节），已改 14 个文件 / 新增 5 个文件 |

**这批改动没有提交，也没有推送。** 接手第一件事就是先决定它怎么处理（见第 5 节）。

新增文件：

```
templates/spectrum.js           雷达扫描 / 波形频谱 / 胶片条
templates/typography2.js        幽灵水印
presets/instrument-demo.json    四款新模板的演示工程（已进 presets/index.json）
tools/ui-instrument-test.js     这批新模板的自检
docs/preview-instruments.png    README 里用的预览图
```

---

## 2. 这一轮干了什么

### 2.1 修了一个环境问题（不然什么都跑不了）

DSH 授权写入工作区时被 Windows 文件权限挡住（根目录缺 `WRITE_OWNER`），
`git` / `node` 一律报 `SetNamedSecurityInfoW failed (Win32 5)`。
已用 DSH 自带脚本修好：给当前用户补一条完全控制权限。**这是机器级的改动，不在仓库里。**

- 报告与备份：`.acl-report/`（已加进 `.gitignore`，不进仓库）
- 单文件沙箱报 `Win32 5` 时，不用再排查代码 —— 是文件权限，不是项目问题

### 2.2 修「下载视频」按钮（原来在这台机器上是坏的）

**病因**：`tools/serve.mjs` 的 `downloadVideoApi` 直接 `spawn('yt-dlp', …)`，
但这台机器上 `yt-dlp` 不在 PATH，只装了 Python 模块（`yt_dlp 2026.07.04`）。
点按钮只会得到 `找不到 yt-dlp: spawn ENOENT`。

**改法**（都在 `tools/serve.mjs`）：

1. 新增 `probeYtDlp()`：先试 `yt-dlp --version`，不行退回 `python -m yt_dlp --version`；
   探到哪个用哪个，结果缓存；spawn 出错时把缓存清掉（下次重新探 → **装完不用重启**）
2. `run()` 新增 `timeout` 选项（探测不能被卡住的进程拖死）
3. 失败时清理 `.part` / `.ytdl` 半成品，`downloads/` 不再越堆越大
4. `/api/agent/status` 新增 `videoDownload` 字段；`studio/agent-panel.js` 环境行显示
   `下载视频 ✓ / ✗（pip install -U yt-dlp）`
5. 弹窗文案不再对用户说"yt-dlp"这个内部名词
6. **版本号 8 → 9**：`tools/serve.mjs` 的 `APP_VERSION` 与 `studio/studio.js` 的 `NEED` **必须一起改**，
   否则页面会误报"本地服务是旧版本"

**验证证据**（当时起在 5199 端口单独测，没动用户的 5178）：

```bash
# 探测到的是哪种装法
curl -s http://127.0.0.1:5199/api/agent/status   # → "videoDownload":"python -m yt_dlp"

# 真实下载 + 走完整 UI 流程（弹窗 → 后端回传 → 载入时间轴）
node tools/shot.mjs \
  --url "http://127.0.0.1:5199/studio/index.html?downloadTestUrl=https%3A%2F%2Ffilesamples.com%2Fsamples%2Fvideo%2Fmp4%2Fsample_640x360.mp4" \
  --js-file tools/ui-download-test.js --out .out/ui-download-fixed.png
# → checks.all = true，videoLoaded = true，页面无报错
```

### 2.3 新增 4 个模板（46 → 50 个）

用户选了三条线（HUD/数据、排版/大字、材质/转场）+「你提方案我来挑」，
所以做了一批「可评审的样本」，四款都带 `position` 参数 → **都能拖到画面里落位**：

| id | 名称 | category | 文件 | 说明 |
| --- | --- | --- | --- | --- |
| `radar-sweep` | 雷达扫描 | `overlay` | spectrum.js | 同心圈 + 十字刻度 + 扫描线 + 余晖残影，目标点随扫描角点亮，带方位角读数 |
| `waveform-panel` | 波形 / 频谱 | `overlay` | spectrum.js | 柱状 / 折线 / 面积三种；**有音频用真波形，没有就退回稳定伪波形**（缩略图也有东西） |
| `film-strip` | 胶片条 | `overlay` | spectrum.js | 上下带齿孔的半透黑条 + 滚动帧号 |
| `ghost-mark` | 幽灵水印 | `typography` | typography2.js | 描边大字 + 四角括号 + 方向箭头 |

**踩到并修掉的坑**：`ghost-mark` 原本默认白色，而工作室画布是浅灰的 —— 拖进去像没画出来。
已改成默认墨黑（深色素材让用户切白）。**新模板定默认色时，按"浅色画布上也看得见"来定。**

配套：

- `templates/index.js` 注册（`spectrum` 排在 hud 之后，`typography2` 排在 type 之后）
- **`node tools/schema.mjs` 重生成 `agent/schema.json`**（现在是 50 个；Python 侧依赖它）
- **`node tools/bundle.mjs` 重新打包 `dist/studio.html`**（现在 26 个模块 / 670.7 KB）
- 新预设 `presets/instrument-demo.json`，已登记进 `presets/index.json`
- 新自检 `tools/ui-instrument-test.js`（按**非透明像素数**验证每个模板真的画出了东西，
  因为模板 `draw()` 抛错时引擎只 `console.error` 不中断 —— 静默画个空是看不出问题的）
- README / docs/命令速查 同步

顺手修的文档漂移：`templates/index.js`、`tools/schema.mjs`、`engine/core.js`、`studio/studio.js`、
`agent/README.md` 里"**23 个模板**"的旧注释，以及 README 里一直没跟上的"模板多到 **39** 个"。

---

## 3. 未提交的改动清单

```
 M .gitignore                      # 加 .acl-report/
 M README.md                       # 50 个模板、新模板表格、仪器面板预览图、新自检、下载视频需要 yt-dlp
 M agent/README.md                 # 23 → 50
 M agent/schema.json               # 重生成（50 个模板）
 M dist/studio.html                # 重新打包
 M docs/命令速查.md                 # 下载视频 / 自动字幕 / 仪器面板 三段自检命令
 M engine/core.js                  # 23 → 50（注释）
 M presets/index.json              # 登记 instrument-demo
 M studio/agent-panel.js           # 环境行加"下载视频 ✓/✗"
 M studio/index.html               # 下载弹窗文案
 M studio/studio.js                # NEED 9、弹窗文案、注释 23 → 50
 M templates/index.js              # 注册两个新文件
 M tools/schema.mjs                # 23 → 50
 M tools/serve.mjs                 # yt-dlp 探测/回退/清理 + APP_VERSION 9
?? docs/preview-instruments.png
?? presets/instrument-demo.json
?? templates/spectrum.js
?? templates/typography2.js
?? tools/ui-instrument-test.js
```

---

## 4. 环境事实（这台机器）

| 项 | 值 |
| --- | --- |
| Node | v24.19.0 |
| Python | 3.14.7（`ctranslate2 4.8.2` / `onnxruntime 1.28.0` 都能 import，whisper 栈可用） |
| Chrome | `C:/Program Files/Google/Chrome/Application/chrome.exe` |
| yt-dlp | **不在 PATH**；只有 Python 模块 `yt_dlp 2026.07.04` → 走 `python -m yt_dlp` 回退 |
| ffmpeg | 有（`imageio_ffmpeg`） |
| **开发服务** | **5178 端口上那个还是旧版 v8**（用户开着的工作室窗口）。源码已是 v9，刷新会提示"本地服务是旧版本"；**Ctrl+C 关掉再双击 `启动工作室.bat`** 即可（启动器会自己换掉旧的） |

---

## 5. 下一步（按优先级）

1. **先处理未提交的改动**：用户还没决定提交。仓库里的是**代码**，
   `projects/` 整块被忽略（体积/版权/隐私），所以提交是安全的。
   项目自己的入口是工作室顶栏 **⇅ 同步**（提交并上传 / 拉取），也可以直接
   `git add -A && git commit -m "…"`。**提交前记得 `npm run bundle`**，
   因为 `dist/studio.html` 是故意留在仓库里的交付物（改了 `studio/` 源码就必须重打包，
   不然两台机器会来回覆盖它）。
2. **让用户评审这 4 个模板**：它们是"提一批、你来挑"的样本。
   大概率会发生的事：改配色 / 改参数默认值 / 删掉不喜欢的。用户挑完可能要**再补一批**。
   如果要补，方向已经在对话里定过：HUD/数据面板、排版/大字、材质/转场。
3. 用户明确说过「加新动效模板」是当前主线。**已存在但没做的大功能**（README 第 483 行自己列的）：
   关键帧动画、蒙版/裁剪、画中画圆角描边、降噪这类音频处理。

---

## 6. 项目约定与坑（省得重新踩）

### 加一个模板（最短路径，不用动引擎）

1. 写 `templates/xxx.js`：`export const myTpl = { id, name, category, hint, params[], draw(ctx, env) }`
   - `id` **必填**（`registerTemplate` 会校验），`name` / `category` / `params` / `draw` 也是必需的
   - `params` 的 `type` 只能是 `number | bool | color | select | multiline | string`
   - **想要"拖到画面里落位"，必须有 `position` 参数**（格式 `"x,y"` 或 `"x,y,w"`）——
     `placeParamsAt()` 只认这个键；`focus-box` 那种用 `region` 的就不落位（拖进去只是加层）
   - 底色类参数名要包含 `plate|fill|bg|paper|backdrop`，右栏才会出现那个**透明**勾选框
2. `templates/index.js` import + 塞进 `ALL`
3. 新分类才要动 `templates/index.js` 的 `CATEGORIES` + `studio.js` 的 `CAT_LABEL`/`CAT_COLOR`（三处）
4. `node tools/schema.mjs` → `node tools/bundle.mjs`
5. 自检：`node tools/render.mjs --template <id> --duration 3 --out .out/x`
   （**注意**：透明 PNG 叠在白底上是看不出来的 —— 白色元素一定要加 `--bg '#141414'` 再看，
   否则会误判成"没画出来"）

### 会咬人的地方

- **版本号两处**：`tools/serve.mjs:APP_VERSION` ↔ `studio/studio.js:NEED`，加接口必须同时 +1
- **`dist/studio.html` 必须重新打包**才算改完（它是 `file://` 双击即用的交付物）
- **模板 id / 参数名被硬编码在多处**：`studio.js` 的 `TEXT_SLOT` / `CAPTION_LOOKS` / `BEAT_FX`，
  **以及 Python 侧 `agent/director.py` / `agent/fill.py` 各有一份复制的样子池** ——
  改 id 或参数名要 **JS + Python 一起改**，否则 AI 生成会静默失效（`coerce_params` 只丢键不报错）
- **`agent/schema.json` 是生成物**：改模板参数忘了重生成，Python 侧会静默丢键
- **渲染带副作用**：`renderAt()` 每帧会调 `syncTransitionLayers()` 增删改 `state.scene.layers`，
  所以"渲染一帧顺便存快照"的逻辑（撤销 / 自动保存轮询）可能捕捉到中间态
- **`layer.id` 不落盘**（`clip.id` 落盘），重新载入工程后图层 id 全变
- **正则打包器**：`tools/bundle.mjs` 只认 `import … from '…'`，
  **不支持**裸 `import 'x'`、`export * from`、动态 `import()`
- **`filesamples.com` / `blender.org` 这类站点**：后者会回 Cloudflare 403（yt-dlp 需要 impersonation），
  测下载用前者那种直链更稳

### 自检怎么写

`tools/ui-*.test.js` 是被 `tools/shot.mjs` 灌进页面执行的一段脚本（**不是模块**，
所以可以有顶层 `return`，但 `node --check` 会报错，这是正常的）：

```bash
node tools/shot.mjs --url "studio/index.html?preset=instrument-demo.json" \
  --js-file tools/ui-instrument-test.js --out .out/ui-instrument.png
```

脚本里用 `window.MotionKit` 那套 API，结果挂 `window.__mkReport`（或直接 return），
`shot.mjs` 会打印 `脚本结果: {...}`。**注意：`shot.mjs` 不会断言 `checks.all`**，
只有页面抛未捕获异常/console.error 才 `exit 2` —— 所以要看输出里的 `"all": false`。

`window.MotionKit.state` 是**可写的属性**（`setScene` 会替换它），
所以自检里 `MK.state.scene.template = id` 这种玩法不生效，**要每次都 `MK.setScene({...})`**。

---

## 7. 这次会话没做的事（明确记一下）

- **没有提交、没有推送**任何东西（第 5 节第 1 条）
- **没有做**关键帧 / 蒙版 / 圆角描边 / 降噪
- **没有验证过**用户真实的 YouTube 链接（只验证了机制：探测 + 回退 + 真实 MP4 下载 + UI 载入）
- **没有跑** whisper 转写（环境只验证到 `ctranslate2` / `onnxruntime` 能 import）
