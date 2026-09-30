#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
导演：把"素材分析 + 创意文案 + 用户的几个选择"翻译成一份 MotionKit 工程。

设计取向——**判断交给代码，文案和口味交给 LLM**：
  · 什么时候出字、出多大、摆在哪个角、闪多狠、密度多少：全是确定性规则，
    因为这些东西一旦交给模型自由发挥，就会得到一堆互相打架的图层。
  · 标题写什么、砸哪几个词、跑马灯编什么、终端里打什么：这些是品味和文案，
    交给 LLM（没有 LLM 就让分析数字顶上）。

产出的 scene JSON 会逐字段对着 agent/schema.json 校验：模板不认识的键丢掉，
数字越界钳回来，select 取值不在选项里就退回默认值。这样"agent 生成的东西"
和"手调出来的工程"在引擎眼里没有任何区别。

独立使用：
  python agent/director.py --analysis analysis.json --style slopcore --intensity 0.7 --out scene.json
"""

import argparse
import json
import math
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


# ---------------------------------------------------------------- schema
_SCHEMA = None


def load_schema(path=None):
    global _SCHEMA
    if _SCHEMA is None or path:
        p = path or os.path.join(HERE, "schema.json")
        if not os.path.exists(p):
            raise SystemExit("缺少 %s，先跑一次 node tools/schema.mjs" % p)
        with open(p, encoding="utf-8") as f:
            _SCHEMA = json.load(f)
    return _SCHEMA


def load_styles():
    with open(os.path.join(HERE, "styles.json"), encoding="utf-8") as f:
        return json.load(f)["styles"]


def tpl_spec(tid):
    t = load_schema()["templates"].get(tid)
    if not t:
        raise KeyError("没有这个模板：%s" % tid)
    return t


def defaults(tid):
    return {p["key"]: p["default"] for p in tpl_spec(tid)["params"]}


def coerce_params(tid, params, warnings=None):
    """按 schema 校验参数：丢掉不认识的键、钳住越界数字、非法选项退回默认。"""
    spec = {p["key"]: p for p in tpl_spec(tid)["params"]}
    out = {}
    for k, v in (params or {}).items():
        p = spec.get(k)
        if not p:
            if warnings is not None:
                warnings.append("%s 没有参数 %s，已丢弃" % (tid, k))
            continue
        t = p.get("type", "text")
        try:
            if t == "number":
                v = float(v)
                if p.get("min") is not None:
                    v = max(float(p["min"]), v)
                if p.get("max") is not None:
                    v = min(float(p["max"]), v)
                if float(p.get("step") or 1) >= 1 and float(v).is_integer():
                    v = int(v)
            elif t == "bool":
                v = bool(v)
            elif t == "select":
                if v not in (p.get("options") or []):
                    if warnings is not None:
                        warnings.append("%s.%s=%r 不是合法选项，用默认值 %r" % (
                            tid, k, v, p.get("default")))
                    v = p.get("default")
            else:
                v = "" if v is None else str(v)
        except (TypeError, ValueError):
            if warnings is not None:
                warnings.append("%s.%s=%r 类型不对，用默认值" % (tid, k, v))
            v = p.get("default")
        out[k] = v
    return out


# ---------------------------------------------------------------- 时间网格
DEFAULT_BRIEF = {
    "style": "auto",
    "intensity": 0.6,       # 卡点幅度：闪多狠、字多大、转场多猛
    "density": 0.55,        # 信息密度：屏幕上同时挂几样东西
    "captions": "auto",     # auto / off
    "captionStyle": "bar",
    "duration": 30.0,
    "width": 1920,
    "height": 1080,
    "fps": 30,
    "lang": "zh",
    "notes": "",
}


def normalize_brief(b):
    out = dict(DEFAULT_BRIEF)
    out.update({k: v for k, v in (b or {}).items() if v is not None})
    out["intensity"] = min(1.0, max(0.0, float(out["intensity"])))
    out["density"] = min(1.0, max(0.0, float(out["density"])))
    out["duration"] = max(1.0, float(out["duration"]))
    out["width"] = int(out["width"])
    out["height"] = int(out["height"])
    out["fps"] = int(out["fps"])
    return out


def pick_style(analysis, brief, styles, creative=None):
    """style=auto 时替用户选一套配色，并把理由写进报告。"""
    if brief["style"] and brief["style"] != "auto" and brief["style"] in styles:
        return brief["style"], "用户指定"
    if creative and creative.get("style") in styles:
        return creative["style"], "LLM 按素材与补充要求挑选"

    dark = analysis.get("dark", True)
    motion = analysis.get("motionMean", 0.05)
    cpm = analysis.get("cutsPerMinute", 0)
    text = (brief.get("notes") or "").lower()

    if any(w in text for w in ("赛博", "霓虹", "科技", "cyber", "neon")):
        return "neon", "补充要求里提到霓虹/科技"
    if any(w in text for w in ("纪录片", "电影", "胶片", "film", "cinema")):
        return "cinema", "补充要求里提到电影感"
    if any(w in text for w in ("报告", "说明", "教程", "清单", "paper")):
        return "paper", "补充要求里提到说明/清单"
    if motion > 0.16 or cpm > 24:
        return "punch", "运动量 %.3f / 每分钟 %d 个镜头，素材本身很躁" % (motion, cpm)
    if not dark and motion <= 0.06 and cpm <= 8:
        return "paper", "画面又亮又稳（亮度 %.2f、运动 %.3f），白底卡片最清楚" % (
            analysis.get("brightness", 0.5), motion)
    if not dark:
        # 亮但不稳的素材：白底卡片会被花背景吃掉，标题和 HUD 细线也读不出来。
        # 深色墨反而在亮暗两种背景上都立得住。
        return "slopcore", "画面偏亮但一直在动（运动 %.3f、%d 个镜头/分），深色墨比白底稳" % (motion, cpm)
    if cpm >= 8:
        return "slopcore", "镜头切换中等，终端 HUD 这种克制的叠层最稳"
    return "cinema", "画面安静（运动 %.3f、%d 个切点），适合电影感的少量大字" % (motion, cpm)


def beat_grid(analysis, brief):
    """拿拍点。置信度太低就退化成等间隔网格，别硬用错拍子。"""
    beat = analysis.get("beat") or {}
    beats = [float(b) for b in (beat.get("beats") or [])]
    conf = float(beat.get("confidence") or 0.0)
    align = float(beat.get("align") or 0.0)
    duration = float(analysis.get("duration") or brief["duration"])
    usable = len(beats) >= 6 and (align >= 0.50 or (align >= 0.32 and conf >= 0.12))
    if usable:
        grid = [b for b in beats if 0 <= b <= duration]
        src = "音频分析（BPM %.1f，拍点对齐度 %.0f%%）" % (beat.get("bpm", 0), align * 100)
    else:
        bpm = float(beat.get("bpm") or 120.0)
        if bpm < 60 or bpm > 200:
            bpm = 120.0
        period = 60.0 / bpm
        grid = [round(i * period, 4) for i in range(int(duration / period) + 1)]
        src = "等间隔网格（拍点对齐度只有 %.0f%%，不敢用它的相位）" % (align * 100)
    downbeats = grid[::4]
    return grid, downbeats, src, usable


# ---------------------------------------------------------------- 曲线取样
def _curve(analysis, name):
    return (analysis.get("curve") or {}).get(name) or []


def _sample(analysis, name, t, window=0.45):
    arr = _curve(analysis, name)
    rate = float((analysis.get("curve") or {}).get("rate") or 4.0)
    if not arr:
        return 0.0
    a = max(0, int((t - window) * rate))
    b = min(len(arr), int((t + window) * rate) + 1)
    if b <= a:
        return 0.0
    seg = arr[a:b]
    return float(sum(seg) / len(seg))


def _cut_near(analysis, t, tol=0.35):
    for c in analysis.get("shots") or []:
        if abs(float(c["t"]) - t) <= tol:
            return c
    return None


# ---------------------------------------------------------------- 文案兜底
def _clean_name(path_or_name):
    s = os.path.basename(str(path_or_name or "")).rsplit(".", 1)[0]
    s = re.sub(r"[\[（(【][^\]）)】]{0,40}[\]）)】]", " ", s)   # 去掉 [aegp3h0yUt0] 这类 ID
    s = re.sub(r"[\[\]（）()【】]", " ", s)
    s = re.sub(r"[_\-]+", " ", s).strip()
    return s or "UNTITLED"


def _keywords(text, n=6):
    """从字幕里挑几个像"重点词"的：中文两字以上 / 英文大写词。"""
    words = re.findall(r"[\u4e00-\u9fa5]{2,4}|[A-Za-z][A-Za-z'\-]{3,}", text or "")
    seen, out = set(), []
    for w in words:
        k = w.lower()
        if k in seen:
            continue
        seen.add(k)
        out.append(w)
        if len(out) >= n:
            break
    return out


def fallback_creative(analysis, brief, style, transcript=None):
    """没有 LLM 时的文案兜底。尽量用真实分析数字，读起来像"系统在汇报"。"""
    name = _clean_name(analysis.get("file"))
    # 别在这里硬截断：模板有 maxWidth + fit 会自动缩字，
    # 截断只会得到一个"看起来渲染坏了"的半截标题。〔40 字是保险丝〕
    title = name.upper()[:40]
    beat = analysis.get("beat") or {}
    dur = float(analysis.get("duration") or 0)
    cuts = len(analysis.get("shots") or [])
    bright = analysis.get("brightness", 0.5)
    speech_text = " ".join(s.get("text", "") for s in (transcript or []))
    kws = _keywords(speech_text, 4)

    hooks = [h.upper() for h in (style.get("hooks") or [])]
    if kws:
        hooks = [k.upper() for k in kws] + hooks

    bpm = float(beat.get("bpm") or 0)
    conf = float(beat.get("confidence") or 0)
    src_res = "%dx%d" % (analysis.get("width") or 0, analysis.get("height") or 0)
    return {
        "source": "rule",
        "title": title,
        "kicker": "%s · %s" % (style["name"].upper(), src_res),
        "note": "%d 个镜头 · %.0f 秒 · BPM %.0f" % (cuts, dur, bpm) if bpm else "%d 个镜头 · %.0f 秒" % (cuts, dur),
        "hooks": hooks,
        "tickers": {
            "top": "%s   %s   %s" % (title, style["name"].upper(), name.upper()),
            "bottom": "BPM %.1f  CONF %.0f%%  SHOTS %d  LUMA %.2f" % (bpm, conf * 100, cuts, bright),
        },
        "terminal": [
            "> source %s" % name[:28],
            "> %.2fs / %d shots / %d fps" % (dur, cuts, analysis.get("fps", 0)),
            "> bpm %.2f  confidence %.0f%%" % (bpm, conf * 100),
            "> luma %.2f  motion %.3f" % (bright, analysis.get("motionMean", 0)),
            "> status: %s" % ("BEAT LOCKED" if conf >= 0.10 else "GRID FALLBACK"),
        ],
        # 没有转写也没有 LLM 时，别硬编"OPENING/MIDDLE"这种假章节名——
        # 纯数字的场次标记既有排版上的作用，又不会说谎
        "chapters": [k.upper() for k in kws[:3]] or ["01", "02", "03"],
    }


# ---------------------------------------------------------------- 主规划
SAFE_POSITIONS = [
    ("0.5,0.46", "center"),
    ("0.74,0.26", "right"),
    ("0.26,0.32", "left"),
    ("0.5,0.20", "center"),
    ("0.28,0.60", "left"),
    ("0.72,0.58", "right"),
]


def text_box(pos, align, bw, bh):
    """把"锚点 + 对齐"换算成归一化包围盒，用来判断两块内容会不会叠在一起。"""
    px, py = [float(v) for v in str(pos).split(",")[:2]]
    if align == "center":
        x0 = px - bw / 2
    elif align == "right":
        x0 = px - bw
    else:
        x0 = px
    return (x0, py - bh / 2, x0 + bw, py + bh / 2)


class Layout:
    """占位表：谁在什么时间占了屏幕哪一块。

    之前踩的坑：终端面板和开场大标题同时铺在左半边，面板直接把标题盖掉一半，
    看起来像"标题渲染坏了"。全屏大标题还会和章节卡、卡点大字在正中间打架。
    所以每放一样东西之前先登记包围盒，后来的自己找空位。
    """

    def __init__(self):
        self.items = []

    def add(self, t0, t1, box):
        self.items.append((float(t0), float(t1), tuple(box)))

    def _overlap_area(self, box, other):
        ix = min(box[2], other[2]) - max(box[0], other[0])
        iy = min(box[3], other[3]) - max(box[1], other[1])
        return ix * iy if ix > 0 and iy > 0 else 0.0

    def clash(self, t0, t1, box, pad=0.012):
        b = (box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad)
        for a, e, c in self.items:
            if t1 <= a or t0 >= e:
                continue
            if self._overlap_area(b, c) > 0:
                return True
        return False

    def pick(self, t0, t1, options, boxes):
        """options 里挑第一个不撞的；全都撞就挑撞得最少的那个。"""
        best, best_cost = None, None
        for i, opt in enumerate(options):
            box = boxes[i]
            cost = 0.0
            for a, e, c in self.items:
                if t1 <= a or t0 >= e:
                    continue
                cost += self._overlap_area(box, c)
            if cost <= 0:
                return i, box
            if best_cost is None or cost < best_cost:
                best, best_cost = i, cost
        return (best if best is not None else 0), boxes[best if best is not None else 0]


def fit_line(text, width_px, size_px, cjk_ratio=1.0):
    """按显示宽度粗略截断一行（等宽面板用），超了加省略号。

    终端面板的宽度是固定的，而文件名/标题长度不可控；不截断的话文字会直接
    冲出面板的黑色底，看起来像是渲染错误。
    """
    s = str(text or "").replace("\n", " ")
    if not s:
        return s
    per_char = size_px * (0.62 * (1.0 if cjk_ratio == 1.0 else cjk_ratio))
    limit = max(6, int(width_px / max(1.0, per_char)) - 1)
    if len(s) <= limit:
        return s
    return s[: max(1, limit - 1)] + "…"


def build_scene(analysis, brief, creative, styles=None, warnings=None):
    warnings = [] if warnings is None else warnings
    styles = styles or load_styles()
    brief = normalize_brief(brief)
    duration = round(min(float(analysis.get("duration") or brief["duration"]), brief["duration"]), 4)
    W, H, FPS = brief["width"], brief["height"], brief["fps"]

    style_id, style_why = pick_style(analysis, brief, styles, creative)
    style = styles[style_id]
    ink, accent, plate = style["ink"], style["accent"], style["plate"]
    k = brief["intensity"]
    dens = brief["density"]

    beats, downbeats, grid_src, grid_ok = beat_grid(analysis, brief)
    decisions = [
        {"stage": "配色", "what": "%s（%s）" % (style["name"], style_id), "why": style_why},
        {"stage": "卡点网格", "what": "BPM %.2f / %d 个拍点" % (
            (analysis.get("beat") or {}).get("bpm", 0), len(beats)), "why": grid_src},
    ]

    layers = []
    seq = [0]

    def add(tid, start, end, params, name):
        start = max(0.0, round(float(start), 4))
        end = min(duration, round(float(end), 4))
        if end - start < 0.12:
            return None
        seq[0] += 1
        clean = coerce_params(tid, params, warnings)
        L = {
            "template": tid, "start": start, "end": end,
            "params": clean, "seed": "agent-%s-%d" % (tid, seq[0]),
            "name": name or tid, "opacity": 1, "blend": "source-over", "enabled": True,
        }
        layers.append(L)
        return L

    layout = Layout()

    # ---- 1. 全片打底：HUD 框
    add("hud-frame", 0, duration, {
        "inset": max(30, round(min(W, H) * 0.032)),
        "tickLen": round(min(W, H) * 0.033 * (0.7 + 0.6 * k)),
        "corners": True, "rulers": k >= 0.35, "timecode": True,
        "tickerTop": creative["tickers"]["top"],
        "tickerBottom": creative["tickers"]["bottom"],
        "labelLeft": style["name"].split()[0] if style["name"] else "SIGNAL",
        "labelRight": "REC",
        "meter": k >= 0.45,
        "noise": round(0.18 + 0.5 * k, 3),
        "color": ink, "accent": accent,
        "speed": round(0.7 + 0.7 * k, 3),
    }, "HUD 全屏框")
    # 上下跑马灯是全宽的，先把这两条横带登记成"占用"，别的东西就别往那儿放
    layout.add(0, duration, (0.0, 0.0, 1.0, 0.115))
    layout.add(0, duration, (0.0, 0.885, 1.0, 1.0))
    decisions.append({"stage": "打底", "what": "hud-frame 铺满全片",
                      "why": "细线框负责把整段画面「框」成一个整体，比逐层加更省事也更稳"})

    # ---- 2. 开头标题
    # 短素材别让标题吃掉整段：3 秒的片子挂 2.2 秒标题就没内容了
    title_end = min(duration - 0.4, max(min(2.2, duration * 0.5), min(3.6, duration * 0.22)))
    if title_end > 1.0:
        t_start = min(0.35, duration * 0.04)
        t_size = round(min(W * 0.085, 190) * (0.75 + 0.45 * k))
        # 大标题默认压在下三分之一。正中间最省事，但正中间通常就是人脸
        title_opts = ["0.5,0.72", "0.5,0.30"]
        tb = [text_box(p, "center", 0.86, min(0.24, t_size * 1.6 / H)) for p in title_opts]
        ti_, title_box = layout.pick(t_start, title_end, title_opts, tb)
        title_pos = title_opts[ti_]
        # 亮素材上不垫底的大字读不出来 —— 给标题铺一块底色（深素材不用，留白更透气）
        title_plate = plate if not analysis.get("dark", True) else ""
        add("title-mark", t_start, title_end, {
            "title": creative["title"], "kicker": creative["kicker"], "note": creative["note"],
            "position": title_pos,
            "size": t_size,
            "maxWidth": 0.84, "fit": True, "rule": True, "align": "center",
            "plate": title_plate,
            "color": ink, "accent": accent,
        }, "标题定格")
        layout.add(t_start, title_end, title_box)

    # ---- 3. 终端面板（密度够就上，交代"系统在读这段素材"）
    if dens >= 0.3 and duration > 7:
        ts = min(1.1, duration * 0.1)
        te = min(duration - 0.5, 4.8)
        tsize = round(min(W, H) * 0.021)
        tw_ = round(min(W * 0.26, 640))
        lines = [fit_line(l, tw_ - 40, tsize) for l in creative["terminal"][:5]]
        th_ = (34 + len(lines) * tsize * 1.7 + 16) / H
        term_opts = ["0.03,0.10", "0.03,0.62", "0.62,0.72"]
        tboxes = [(float(p.split(",")[0]), float(p.split(",")[1]),
                   float(p.split(",")[0]) + tw_ / W, float(p.split(",")[1]) + th_)
                  for p in term_opts]
        ti2, _ = layout.pick(ts, te, term_opts, tboxes)
        term_pos = term_opts[ti2]
        add("terminal-prompt", ts, te, {
            "title": "ANALYSIS",
            "lines": "\n".join(lines),
            "position": term_pos,
            "width": tw_,
            "size": tsize,
            "lineHeight": 1.7, "charDelay": round(0.03 - 0.018 * k, 4),
            "cursor": True, "chrome": True,
            "fill": plate, "color": ink, "accent": accent,
        }, "终端面板")
        layout.add(ts, te, tboxes[ti2])

    # ---- 4. 卡点冲击点
    hooks = [h for h in (creative.get("hooks") or []) if h] or ["LOOK"]
    # 候选点：正常用强拍；素材短、强拍太少时退而用所有拍点（否则会一个卡点都没有）
    pool_beats = downbeats if len(downbeats) >= 3 else beats
    cands = []
    for d in pool_beats:
        if d < title_end + 0.2 or d > duration - 0.35:
            continue
        score = _sample(analysis, "activity", d) * 1.0
        score += 0.35 * _sample(analysis, "low", d)
        cut = _cut_near(analysis, d, 0.32)
        if cut:
            score += 0.45
        cands.append((score, d, bool(cut)))
    if not grid_ok:
        # 网格不可信时，改用"真正的镜头切点 + 活动峰值"当冲击点
        for c in analysis.get("shots") or []:
            t = float(c["t"])
            if title_end + 0.2 < t < duration - 0.35:
                cands.append((_sample(analysis, "activity", t) + 0.35, t, True))
        cands.sort(key=lambda x: -x[0])

    min_gap = max(1.5, 3.4 - 2.2 * k)
    want = max(1, int(round(duration / max(2.2, 7.5 - 4.5 * k))))
    if duration >= 3.0:
        want = max(2, want)
    picked = []
    for score, t, on_cut in sorted(cands, key=lambda x: -x[0]):
        if len(picked) >= want:
            break
        if all(abs(t - p[1]) >= min_gap for p in picked):
            picked.append((score, t, on_cut))
    picked.sort(key=lambda x: x[1])

    kinetic_layers = []
    for i, (score, t, on_cut) in enumerate(picked):
        nxt = picked[i + 1][1] if i + 1 < len(picked) else duration
        hold = min(max(0.9, min_gap * 0.8), nxt - t - 0.08)
        # 摆哪儿由占位表决定：优先用候选里第一个不撞的位置
        order = [SAFE_POSITIONS[(i + j) % len(SAFE_POSITIONS)] for j in range(len(SAFE_POSITIONS))]
        boxes = [text_box(p, a, 0.5 if a != "center" else 0.8, 0.2) for p, a in order]
        bi, box = layout.pick(t - 0.05, t + max(0.8, hold), order, boxes)
        pos, align = order[bi]
        mode = "slam" if k >= 0.55 else ("cut" if k >= 0.3 else "typewriter")
        ksize = round(min(W, H) * (0.075 + 0.075 * k))
        L = add("kinetic-type", t - 0.05, t + max(0.8, hold), {
            "text": hooks[i % len(hooks)],
            "mode": mode,
            "position": pos, "align": align,
            "size": ksize,
            "weight": style["type"].get("weight", "700"),
            "tracking": style["type"].get("tracking", -0.02),
            "plate": plate if dens >= 0.4 else "",
            "color": ink, "accent": accent,
            "ghost": k >= 0.6, "fit": True,
            "maxWidth": 0.5 if align != "center" else 0.8,
            "beatSync": True, "beatsPerStep": 1,
        }, "卡点大字 %d" % (i + 1))
        if L:
            kinetic_layers.append((t, t + max(0.8, hold)))
            layout.add(L["start"], L["end"],
                       text_box(pos, align, 0.5 if align != "center" else 0.8,
                                max(0.2, ksize * 1.5 / H)))
    decisions.append({"stage": "卡点", "what": "%d 个冲击点，间距 ≥ %.1fs" % (
        len(picked), min_gap),
        "why": "取活动曲线 + 低频能量 + 是否正好有镜头切点，综合分高的强拍；"
               "幅度 %.2f 决定间隔和字号" % k})

    # ---- 5. 切点转场（变换式转场必须放最上层，所以先存着最后加）
    trans = []
    if analysis.get("shots"):
        pool = {
            0: ["flash-cut"],
            1: ["flash-cut", "zoom-punch", "scan-wipe"],
            2: ["zoom-punch", "glitch-burst", "flash-cut", "cam-shake", "shutter-wipe"],
        }[2 if k >= 0.7 else (1 if k >= 0.4 else 0)]
        last_t = -99
        ti = 0
        max_trans = max(2, int(duration / 6.0))     # 转场是重手法，别撒豆子（30s 最多 5 个）
        for c in analysis.get("shots") or []:
            t = float(c["t"])
            if ti >= max_trans or t < 1.2 or t > duration - 0.5 or t - last_t < 2.2:
                continue
            near = min(beats, key=lambda b: abs(b - t)) if beats else None
            on_beat = near is not None and abs(near - t) <= 0.30
            if not on_beat and k < 0.5:
                continue
            tid = pool[ti % len(pool)]
            ti += 1
            last_t = t
            params = {
                # 亮素材上闪白要给得轻一点，不然整帧糊成一片白
                "flash-cut": {"fillColor": "#ffffff",
                              "peak": round((0.3 + 0.45 * k) * (0.62 if not analysis.get("dark", True) else 1.0), 3),
                              "fadeIn": round(0.5 - 0.25 * k, 3), "bar": False, "accent": accent},
                "zoom-punch": {"amount": round(0.16 + 0.42 * k, 3), "rotate": round(0.6 + 1.4 * k, 3),
                               "blur": round(6 + 14 * k, 2), "streaks": k >= 0.5, "flash": True},
                "scan-wipe": {"fillColor": plate, "band": round(150 + 240 * k),
                              "direction": "down", "glowColor": accent, "readout": True},
                "glitch-burst": {"amount": round(0.5 + 0.8 * k, 3), "slices": round(12 + 22 * k),
                                 "shift": round(50 + 110 * k), "rgb": 1, "flashes": 3, "blockColor": accent},
                "cam-shake": {"amount": round(12 + 34 * k, 2), "freq": 26,
                              "decay": round(2.8 - 1.0 * k, 3), "roll": round(0.4 + 0.9 * k, 3)},
                "shutter-wipe": {"rows": round(7 + 10 * k), "fillColor": plate,
                                 "accent": True, "accent": accent},
            }[tid]
            span = 0.34 if tid in ("flash-cut", "zoom-punch", "cam-shake") else 0.55
            trans.append((tid, round(t - 0.06, 4), round(min(duration, t + span), 4), params))
    decisions.append({"stage": "转场", "what": "%d 个切点转场" % len(trans),
                      "why": "只挑「镜头真的切了、时间上又踩在拍点附近」的位置；"
                             "幅度低时干脆只在卡点上闪一下"})

    # ---- 6. 空隙补内容
    occupied = [(0, title_end + 0.2)] + kinetic_layers
    if duration > 4.8:
        occupied.append((min(1.1, duration * 0.1), min(duration - 0.5, 4.8)))
    occupied.sort()
    merged = []
    for a, b in occupied:
        if merged and a <= merged[-1][1] + 0.35:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    gaps = []
    cursor = 0.5
    for a, b in merged:
        if a - cursor >= 4.2:
            gaps.append((cursor, a))
        cursor = max(cursor, b)
    if duration - 0.4 - cursor >= 4.2:
        gaps.append((cursor, duration - 0.4))

    filler_pool = []
    if dens >= 0.3:
        filler_pool.append(("param-ticks", ["0.04,0.62", "0.04,0.30"], {}))
    if dens >= 0.45:
        filler_pool.append(("stat-counter", ["0.66,0.20", "0.30,0.20"], {}))
    if dens >= 0.6:
        filler_pool.append(("dial-gauge", ["0.86,0.72", "0.14,0.74"], {}))
    if dens >= 0.7:
        filler_pool.append(("look-card", ["0.06,0.24", "0.60,0.24"], {}))
    if dens >= 0.85:
        filler_pool.append(("note-bubble", ["0.62,0.66", "0.22,0.70"], {}))

    fillers = []
    for i, (a, b) in enumerate(gaps):
        if not filler_pool:
            break
        tid, poss, extra = filler_pool[i % len(filler_pool)]
        span = min(4.6, b - a - 0.4)
        if span < 1.6:
            continue
        # 尺寸先定下来，才能拿它去占位表里比
        if tid == "param-ticks":
            fbox_w, fbox_h = min(W * 0.15, 330) / W, 0.17
        elif tid == "stat-counter":
            fbox_w, fbox_h = 0.22, 0.20
        elif tid == "dial-gauge":
            fbox_w, fbox_h = 0.16, 0.20
        elif tid == "look-card":
            fbox_w, fbox_h = min(W * 0.2, 380) / W, 0.26
        else:
            fbox_w, fbox_h = 0.18, 0.18
        cand = [poss[(i + j) % len(poss)] for j in range(len(poss))]
        if tid in ("param-ticks", "look-card", "note-bubble"):
            fboxes = [(float(p.split(",")[0]), float(p.split(",")[1]),
                       float(p.split(",")[0]) + fbox_w, float(p.split(",")[1]) + fbox_h)
                      for p in cand]
        else:
            fboxes = [text_box(p, "center", fbox_w, fbox_h) for p in cand]
        fi_, _fbox = layout.pick(a + 0.35, a + 0.35 + span, cand, fboxes)
        pos = cand[fi_]
        if tid == "param-ticks":
            params = dict(position=pos, width=round(min(W * 0.15, 330)), rows=4 if dens < 0.6 else 5,
                          live=True, frame=True, color=ink, accent=accent)
        elif tid == "stat-counter":
            params = dict(position=pos, value=round(60 + 40 * k), from_=None, suffix="%",
                          label=(creative.get("hooks") or ["SIGNAL"])[i % len(creative.get("hooks") or ["SIGNAL"])].upper(),
                          size=round(min(W, H) * 0.10), bar=True, roll="count",
                          color=ink, accent=accent, beatSync=True, beatsPerStep=1)
            params.pop("from_", None)
            params["from"] = 0
        elif tid == "dial-gauge":
            params = dict(position=pos, value=round(0.35 + 0.5 * k, 3), radius=round(min(W, H) * 0.055),
                          label="INTENSITY", showValue=True, sweep=True, color=ink, accent=accent)
        elif tid == "look-card":
            items = (creative.get("chapters") or ["ONE", "TWO", "THREE"])[:3]
            params = dict(title="NOTES", items="\n".join(items), position=pos,
                          width=round(min(W * 0.2, 380)), size=round(min(W, H) * 0.022),
                          startIndex=1, stagger=2, fill=plate, textColor=ink, accent=accent)
        else:
            params = dict(text="\n".join((creative.get("terminal") or ["note"])[:3]),
                          position=pos, width=round(min(W * 0.18, 340)),
                          size=round(min(W, H) * 0.019), fill=plate, tail=True,
                          color=ink, accent=accent)
        L = add(tid, a + 0.35, a + 0.35 + span, params, "补白 · %s" % tid)
        if L:
            fillers.append((tid, L["start"], L["end"]))
            layout.add(L["start"], L["end"], fboxes[fi_])
    decisions.append({"stage": "补白", "what": "%d 个辅助层" % len(fillers),
                      "why": "把超过 4.2 秒的空白段填上读数类小面板；密度 %.2f 决定能开几种" % dens})

    # ---- 7. 章节卡
    chapters = [c for c in (creative.get("chapters") or []) if c]
    if chapters and duration >= 16:
        step = max(12.0, duration / max(2, min(4, len(chapters))))
        i = 0
        t = title_end + 2.0
        while t < duration - 4.0 and i < len(chapters):
            ch_size = round(min(W, H) * 0.06 * (0.8 + 0.4 * k))
            ch_opts = ["0.5,0.26", "0.5,0.74", "0.5,0.5"]
            ch_boxes = [text_box(p, "center", 0.62, min(0.2, ch_size * 1.6 / H)) for p in ch_opts]
            ci, ch_box = layout.pick(t, t + 2.0, ch_opts, ch_boxes)
            is_number = re.fullmatch(r"\d{1,2}", str(chapters[i]).strip()) is not None
            add("title-mark", t, t + 2.0, {
                "title": chapters[i],
                "kicker": "" if is_number else "PART %02d" % (i + 1),
                "note": "",
                "position": ch_opts[ci], "size": ch_size,
                "maxWidth": 0.6, "fit": True, "rule": True, "align": "center",
                "plate": plate if not analysis.get("dark", True) else "",
                "color": ink, "accent": accent, "boxed": False,
            }, "章节卡 %d" % (i + 1))
            layout.add(t, t + 2.0, ch_box)
            i += 1
            t += step

    # ---- 8. 字幕
    captions = []
    transcript = analysis.get("transcript") or []
    if brief["captions"] != "off" and transcript and k >= 0:
        for seg in transcript:
            s = max(0.0, float(seg.get("start", 0)))
            e = min(duration, float(seg.get("end", 0)))
            text = (seg.get("text") or "").strip()
            if not text or e - s < 0.25:
                continue
            for piece in split_caption_text(text):
                captions.append({"start": round(s, 4), "end": round(e, 4),
                                 "text": piece, "style": brief["captionStyle"]})
        if captions:
            cstyle = brief["captionStyle"]
            add("subtitle-kinetic", captions[0]["start"] - 0.1, captions[-1]["end"] + 0.3, {
                "style": cstyle, "position": "0.5,0.86",
                "size": round(min(W, H) * (0.036 + 0.012 * k)),
                "maxWidth": 0.78, "plate": cstyle in ("bar", "mono"),
                "uppercase": False, "pop": True, "color": ink, "accent": accent,
            }, "卡点字幕")
        decisions.append({"stage": "字幕", "what": "%d 条（%s）" % (len(captions), brief["captionStyle"]),
                          "why": "来自语音识别的时间轴，按标点切成短句"})
    elif brief["captions"] != "off":
        asr = analysis.get("asr") or {}
        if asr.get("provider"):
            why = ("语音识别跑完了（%s）但这段没识别出人声 —— 可能是纯器乐、环境音，"
                   "或者整段都是唱词（唱歌常被判成非语音）" % asr["provider"])
        elif asr.get("error"):
            why = "没有可用的语音识别：%s" % asr["error"]
        else:
            why = "没拿到语音转写（素材里没检测到人声，或者这一版没开字幕）"
        decisions.append({"stage": "字幕", "what": "没上字幕", "why": why})

    # ---- 9. 全局特效
    fx = []
    fxconf = style.get("fx") or {}
    for name, amount in fxconf.items():
        if name == "grain" and amount:
            fx.append({"type": "grain", "amount": round(amount * (0.6 + 0.8 * k), 4)})
        elif name == "scanlines" and amount:
            fx.append({"type": "scanlines", "amount": round(amount * (0.6 + 0.8 * k), 4), "step": 3})
        elif name == "vignette" and amount:
            fx.append({"type": "vignette", "amount": round(amount, 4)})
        elif name == "chromatic" and amount:
            fx.append({"type": "chromatic", "amount": round(amount * (0.6 + 0.9 * k), 3),
                       "animated": True, "jitter": round(amount * 0.4, 3)})
    if grid_ok and k >= 0.25:
        fx.append({"type": "flash", "fillColor": "#ffffff", "hits": "beats",
                   "duration": 0.055, "amount": round(0.06 + 0.2 * k, 4)})

    # ---- 10. 变换式转场最后加（它们会快照整帧，必须在最上层）
    for tid, s, e, params in trans:
        add(tid, s, e, params, "转场 · %s" % tid)

    scene = {
        "name": "agent-%s" % style_id,
        "width": W, "height": H, "fps": FPS,
        "duration": duration,
        "bg": None, "transparent": True,
        "beat": {
            "bpm": round(float((analysis.get("beat") or {}).get("bpm") or 120.0), 4),
            "offset": round(beats[0] if beats else 0.0, 4),
            "duration": duration,
            "source": "agent",
            "beats": [round(b, 4) for b in beats],
        },
        "captions": captions,
        "layers": layers,
        "fx": fx,
    }

    report = {
        "style": style_id,
        "styleName": style["name"],
        "duration": duration,
        "size": "%dx%d@%d" % (W, H, FPS),
        "creativeSource": creative.get("source", "llm"),
        "decisions": decisions,
        "layers": [{"template": L["template"], "start": L["start"], "end": L["end"], "name": L["name"]}
                   for L in layers],
        "counts": {
            "layers": len(layers), "captions": len(captions), "fx": len(fx),
            "beats": len(beats), "impacts": len(picked), "transitions": len(trans),
            "fillers": len(fillers),
        },
        "warnings": warnings,
        "tuning": [
            "整段更躁：--intensity 0.8~1.0（闪白更狠、字更大、卡点更密）",
            "整段更安静：--intensity 0.2~0.35（只在最重的拍子上出字）",
            "屏幕上东西太多：--density 0.3；太空：--density 0.8",
            "换配色：--style %s" % " / ".join(sorted(styles.keys())),
            "标题/大字文案：--brief \"...\" 里写清楚要什么词，或者开 --llm 让它自己编",
        ],
    }
    return scene, report


def split_caption_text(text, max_chars=14):
    """把一条字幕切成适合一屏的短句：中文按标点+长度，英文按词。"""
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    if not text:
        return []
    parts = re.split(r"(?<=[。！？!?；;，,])", text)
    out, buf = [], ""
    for p in parts:
        if not p:
            continue
        cand = (buf + p).strip()
        if len(cand) > max_chars and buf:
            out.append(buf.strip())
            buf = p
        else:
            buf = cand
        while len(buf) > max_chars * 1.6:
            out.append(buf[:max_chars].strip())
            buf = buf[max_chars:]
    if buf.strip():
        out.append(buf.strip())
    return out


def report_markdown(report, analysis=None):
    lines = []
    lines.append("# 自动动效方案")
    lines.append("")
    lines.append("- 配色风格：**%s**（`%s`）" % (report["styleName"], report["style"]))
    lines.append("- 工程规格：%s，时长 %.2fs" % (report["size"], report["duration"]))
    lines.append("- 图层 %d · 字幕 %d 条 · 特效 %d 个 · 卡点冲击 %d 处 · 转场 %d 处"
                 % (report["counts"]["layers"], report["counts"]["captions"], report["counts"]["fx"],
                    report["counts"]["impacts"], report["counts"]["transitions"]))
    lines.append("- 文案来源：%s" % ("LLM" if report["creativeSource"] == "llm" else "本地规则（没用 LLM）"))
    lines.append("")
    lines.append("## 我替你做的决定")
    lines.append("")
    for d in report["decisions"]:
        lines.append("- **%s** — %s" % (d["stage"], d["what"]))
        lines.append("  - %s" % d["why"])
    if analysis:
        lines.append("")
        lines.append("## 素材体检")
        lines.append("")
        lines.append("- 时长 %.2fs / %dx%d / %.2ffps，音轨：%s"
                     % (analysis.get("duration", 0), analysis.get("width", 0),
                        analysis.get("height", 0), analysis.get("fps", 0),
                        "有" if analysis.get("hasAudio") else "无"))
        lines.append("- 亮度 %.2f（%s）· 运动量 %.3f · 镜头 %d 个（%.1f 次/分）"
                     % (analysis.get("brightness", 0),
                        "偏暗" if analysis.get("dark") else "偏亮",
                        analysis.get("motionMean", 0), len(analysis.get("shots") or []),
                        analysis.get("cutsPerMinute", 0)))
        b = analysis.get("beat") or {}
        lines.append("- BPM %.2f（置信度 %.0f%%）· 拍点 %d 个 · 检测到人声段 %d 处"
                     % (b.get("bpm", 0), float(b.get("confidence") or 0) * 100,
                        len(b.get("beats") or []), len(analysis.get("speech") or [])))
    if report.get("warnings"):
        lines.append("")
        lines.append("## 参数校验（schema 兜底）")
        lines.append("")
        for w in report["warnings"][:20]:
            lines.append("- %s" % w)
    lines.append("")
    lines.append("## 想改的话")
    lines.append("")
    for t in report["tuning"]:
        lines.append("- %s" % t)
    lines.append("")
    return "\n".join(lines)


def plan(analysis, brief, creative=None, styles=None):
    styles = styles or load_styles()
    brief_n = normalize_brief(brief)
    if creative is None:
        sid = pick_style(analysis, brief_n, styles)[0]
        creative = fallback_creative(analysis, brief_n, styles[sid], analysis.get("transcript"))
    return build_scene(analysis, brief_n, creative, styles)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--analysis", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--report", default=None)
    ap.add_argument("--style", default="auto")
    ap.add_argument("--intensity", type=float, default=0.6)
    ap.add_argument("--density", type=float, default=0.55)
    ap.add_argument("--captions", default="auto", choices=["auto", "off"])
    ap.add_argument("--caption-style", default="bar")
    ap.add_argument("--width", type=int, default=1920)
    ap.add_argument("--height", type=int, default=1080)
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--notes", default="")
    args = ap.parse_args()

    with open(args.analysis, encoding="utf-8") as f:
        analysis = json.load(f)
    brief = {
        "style": args.style, "intensity": args.intensity, "density": args.density,
        "captions": args.captions, "captionStyle": args.caption_style,
        "duration": analysis.get("duration", 30), "width": args.width,
        "height": args.height, "fps": args.fps, "notes": args.notes,
    }
    scene, report = plan(analysis, brief)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(scene, f, ensure_ascii=False, indent=1)
    if args.report:
        with open(args.report, "w", encoding="utf-8") as f:
            f.write(report_markdown(report, analysis))
    print("工程 -> %s（%d 层 / %d 字幕 / %d 特效）" % (
        args.out, len(scene["layers"]), len(scene["captions"]), len(scene["fx"])))
    for d in report["decisions"]:
        print("  · %s：%s" % (d["stage"], d["what"]))


if __name__ == "__main__":
    main()
