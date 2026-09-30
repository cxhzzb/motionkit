# MotionKit Agent · 丢一段视频进去，出来一份动效工程

它在原来那个"模板 + 时间轴"的基础上，补上了前面最费手的那几件事：
**看素材、挑片段、出字幕、写文案、排图层**。你只在几个关键点上拍板。

```bash
python agent/autopilot.py --video 我的素材.mp4 --out projects/demo
```

![自动生成的动效效果](demo-agent/preview.png)

> 上面这一屏是 `projects/demo-agent/` 里那份工程渲出来的（素材是一支 MV 的第 60~80 秒）。
> 从头到尾没有手工摆过一个图层。

跑完 `projects/demo/` 里会有一份可以直接丢进工作室继续调的 `scene.json`，
以及一份说明它**替你做了哪些决定、为什么**的 `report.md`。

---

## 你只需要做的 5 个选择

界面：工作室顶栏 **✨ AI 助手**。
工作室请用根目录的 `启动工作室.bat` 启动（它是带后端的开发模式，
双击后自动开浏览器；重复双击不会起第二个服务）。

| 选择 | 影响什么 | 建议 |
| --- | --- | --- |
| **配色风格** | 全部图层的颜色、质感、特效构成 | 拿不准就选「自动」，它按画面亮度和运动量挑 |
| **动效幅度** 0~1 | 闪白强度、大字字号、卡点密度、转场激烈程度 | 0.2 克制／0.6 通用／0.9 集锦风 |
| **信息密度** 0~1 | 屏幕上同时挂几样东西（刻度、仪表、编号卡、终端面板） | 0.3 干净／0.55 均衡／0.85 满屏 |
| **字幕** | 要不要自动字幕、用哪种样式 | 有语音素材就开「自动」 |
| **做多长** | 15/30/60 秒，或整段 | 长素材会自动挑"最有事发生"的一段 |

再加一个可选的「补充要求」文本框——这句会直接交给模型，
比如「游戏集锦那种狠的」「标题写 XX」「别闪太白」。

---

## 它到底做了什么

```
素材 → ① 挑片段 → ② 分析 → ③ 转写 → ④ 文案 → ⑤ 排图层 → ⑥ 工程/成片
```

**① 挑片段**　长素材不会从 0 秒开始剪（开头经常是黑场或片头）。
先按 2 次/秒扫全片，用"运动量 + 亮度变化"算出活动曲线，取活动度最高的等长窗口。

**② 分析**（`analyze.py`）

| 算什么 | 怎么算 | 拿来干嘛 |
| --- | --- | --- |
| 拍点 | 分频段谱通量 → 自相关估周期 → 最小二乘精修（复用 `tools/beatmap.py`） | 卡点 |
| 拍点对齐度 | 每个拍点附近是否真有起音峰 | 判断这套拍点能不能信；不信就退化成等间隔网格 |
| 镜头切点 | ffmpeg scene 检测 | 转场只落在"真的切了"的地方 |
| 亮度 / 运动量 | 4 次/秒的 64×36 灰度帧 | 选配色；运动量大就上冲击型动效 |
| 人声段 | 中频段能量的自适应阈值（粗 VAD） | 没字幕时也知道哪里有人在说话 |
| 活动曲线 | 运动 + 响度 + 切点加权平滑 | 挑冲击点、挑片段 |

> 关于"拍点对齐度"：`beatmap.py` 自带的 confidence 是个经验比值，
> 完美对齐的 click track 也只有 25%，音乐上常常只有个位数——拿它当门槛不是
> 误杀就是放过。所以这里改成实测：看每个拍点 ±1 帧内有没有达到局部峰值 42% 的起音。
> 合成 click track 实测 97.7%，一首慢歌的中段 84.4%。

**③ 转写**（`transcribe.py`）　两条路，按可用性自动选：
本机 `faster-whisper`（离线免费），或任何 OpenAI 兼容的 `/v1/audio/transcriptions`。
两条都不通就跳过字幕，其它照做。

**④ 文案**（`llm.py`）　让模型写标题、副标、卡点大字、跑马灯、终端面板、章节标。
**没有 Key 也完全能用**——本地规则会用真实分析数字顶上，
终端面板里打的 `> bpm 126.60  confidence 4%` 是真读数。

**⑤ 排图层**（`director.py`）　这是最像"导演"的一步，也是唯一有脾气的一步：

- **几何全用规则**：什么时候出字、多大、摆哪儿、闪多狠、密度多少。
  交给模型自由发挥的结果是一堆互相打架的图层。
- **占位表避让**：每放一样东西先登记包围盒，后来的自己找空位。
  （踩过的坑：终端面板把开场大标题盖掉一半，看起来像"渲染坏了"；
  章节卡和大字在正中间叠成一团。）
- **变换式转场放最后**：甩镜/推近/震动要快照整帧，必须在图层栈最上面。
- **参数按 schema 校验**：`agent/schema.json` 是从 23 个模板导出的参数表，
  生成的工程逐字段对齐——模板不认识的键丢掉、越界数字钳回来、
  非法选项退回默认值，越界的情况会记进 `report.md`。

**⑥ 落盘**（`autopilot.py --render`）
`overlay-4444-alpha.mov`（带 Alpha，拖到任何剪辑软件都行）、
`cut.mp4`（剪好的片段）、`final.mp4`（烧好动效的成片）。
ProRes 编好之后会清掉中间那堆 PNG 序列，不然 30 秒 1080p 能占两三个 G。

---

## 输出文件

| 文件 | 内容 |
| --- | --- |
| `scene.json` | **MotionKit 工程**，拖进工作室就是完整图层栈 |
| `report.md` | 每个决定 + 理由 + 素材体检 + 调参建议 |
| `analysis.json` | 全部原始数字（拍点、切点、曲线、人声段） |
| `agent-brief.json` | 这次用的选择 + 最终文案 |
| `transcript.json` / `.srt` | 转写结果（有的话） |
| `agent-result.json` | 上面所有东西的合并版，给工作室界面用 |
| `final.mp4` 等 | `--render` 时才产出 |

---

## 配置 LLM 和语音识别（都可选）

复制 `agent/config.example.json` 成 `agent/config.json` 再填，
或者用环境变量（优先级更高）：

```bash
set MK_LLM_BASE=https://api.deepseek.com
set MK_LLM_KEY=sk-xxxx
set MK_LLM_MODEL=deepseek-chat

set MK_ASR_BASE=https://api.siliconflow.cn/v1
set MK_ASR_KEY=sk-xxxx
set MK_ASR_MODEL=FunAudioLLM/SenseVoiceSmall
```

没有 Key 时：动效、卡点、转场、字幕以外的一切都照常工作，只是文案由规则生成。

### 本地字幕（这台机器上已经装好）

```
faster-whisper 1.2.1  +  ctranslate2 4.8.2  +  PyAV 19
模型缓存  C:\Users\<你>\.cache\huggingface\hub\models--Systran--faster-whisper-small  （463 MB）
```

装完就是**全离线、免费、不用 Key**：`provider` 默认 `auto`，有本地模型就优先走本地。
实测这台机器：**20 秒中文人声 → 约 10 秒出结果**（CPU int8 + small，含模型加载）。
再跑第二段就更快了，模型常驻内存。

准确度分两种情况，差别很大：

| 素材 | 表现 |
| --- | --- |
| 说话（访谈、口播、脱口秀） | 很准。实测一段综艺里的"你是真男人嗎 / 我不是真男人"逐字对得上，还带词级时间 |
| 唱词（MV、卡点视频） | **只能算可用**。音乐压着人声，whisper 也没拿唱歌训练过，会漏字、改字。时间轴基本准，文字建议当草稿改 |

几个要知道的点：

| 事 | 说明 |
| --- | --- |
| 模型大小 | `tiny` 39MB / `base` 74MB / `small` 244MB / `medium` 769MB / `large-v3` ~1.5GB。中文 `small` 够用，想更准换 `medium`（慢 2~3 倍） |
| 走显卡 | 你有 NVIDIA 卡，但缺 CUDA 运行库（cuBLAS），所以现在跑的是 CPU。装好 CUDA 12 运行库后把 `device` 改成 `cuda` 能快好几倍 |
| 换模型 | 改 `agent/config.json` 里的 `asr.model`，脚本里用 `--asr local` + 配置即可 |
| 下载慢 | 首次下模型走 HuggingFace 可能很慢，可以先设 `HF_ENDPOINT=https://hf-mirror.com` 再跑 |
| GPU 报错 | 如果看到 `Library cublas64_12.dll is not found`，那是缺 CUDA 运行库——代码会自动回落到 CPU，不影响使用 |
| 唱歌出不来字幕 | Silero 的静音检测是按"说话"训练的，**唱词经常被整段判成非语音**。默认是 `vad: "auto"`：一旦一段都没识别到就自动关掉 VAD 重跑。想直接不用 VAD 就设 `vad: false` |

> 为什么本地转写是把音频读成 numpy 数组再喂进去，而不是直接给文件路径：
> faster-whisper 1.2.1 内部调 `av.open(..., metadata_errors="ignore")`，
> 而 PyAV 19 已经删掉了这个参数，走文件路径会直接 `TypeError`。
> 我们本来就已经解过一次音频，喂数组顺带还省掉一遍解码。

### 自检

没网也能验证链路：`agent/_mock_api.py` 是个本地假接口，
同时假装聊天补全和语音识别两个端点。

```bash
python agent/_mock_api.py 8788
set MK_LLM_BASE=http://127.0.0.1:8788
set MK_LLM_KEY=test
set MK_ASR_BASE=http://127.0.0.1:8788
set MK_ASR_KEY=test
python agent/autopilot.py --video 素材.mp4 --out projects/mock
```

---

## 命令行参数

```
--video PATH          素材（视频或音频都行）
--out DIR             输出目录
--style ID           auto / slopcore / neon / cinema / paper / punch / cooltech
--intensity 0~1       动效幅度（默认 0.6）
--density 0~1         信息密度（默认 0.55）
--captions auto|off   字幕开关
--caption-style       bar / mono / hero / karaoke
--target 秒           目标时长（默认 30）
--clip auto|full|秒:秒  取哪一段（默认 auto；full=整段）
--width/--height/--fps  工程规格
--lang zh/en           转写语言
--notes "..."          补充要求，会喂给模型
--asr local|api|auto
--llm / --no-llm       是否用 LLM 写文案
--render               顺便渲染成片（慢）
--json-progress        NDJSON 进度，给工作室界面用
```

### 单独跑某一步

```bash
python agent/analyze.py    --video in.mp4 --start 60 --limit 30 --out analysis.json
python agent/transcribe.py --video in.mp4 --start 60 --duration 30 --out subs.srt
python agent/director.py   --analysis analysis.json --style neon --intensity 0.8 --out scene.json --report r.md
node   tools/schema.mjs     # 模板参数变了之后重新导出 schema
```

---

## 调参 / 排错

| 现象 | 怎么办 |
| --- | --- |
| 卡点全落在错的地方 | 看 `report.md` 里的「卡点网格」那条：对齐度低说明拍点不可信，此时排布会退化成等间隔网格 |
| 屏幕上东西太多 / 太空 | 调 `--density`（不是 `--intensity`） |
| 不够狠 / 太狠 | 调 `--intensity`；它管闪白强度、字号和冲击点密度 |
| 标题盖住人脸 | 大标题默认放在下三分之一，且会和终端面板避让；素材特殊就改 `scene.json` 里 title-mark 的 `position` |
| 字幕没出来 | `report.md` 里「字幕」那条会写明原因（没装模型 / 没配接口 / 素材里没人声） |
| 渲染很慢或没出 final.mp4 | 渲染要开无头浏览器；`--render` 失败时报告里会带 ffmpeg 的原始报错 |
| 生成的工程想手改 | 直接在工作室里拖，或者改 `scene.json` 再用 `node tools/render.mjs --scene ...` 重渲 |
