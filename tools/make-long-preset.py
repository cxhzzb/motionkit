#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把 slopcore 那套视觉语言铺成一条"长预设"（默认 3 分钟）。

  python tools/make-long-preset.py --duration 180 --out presets/slopcore-3min.json
  python tools/make-long-preset.py --duration 60  --out presets/slopcore-1min.json

怎么排的：
  · 全程铺 HUD 底噪（一条 hud-frame 从头到尾）
  · 开场一个标题定格 + 终端面板
  · 中间切成若干段落，每段换一套信息层（宫格大字 / 计数 / 仪表 / 编号卡 / 吊牌 / 注释 / 跑马灯）
    + 段落开头一个转场 + 段落中段一记卡点大字
  · 收尾一记大标题
  · 卡点闪白走"后期特效栈"（跟着拍点闪），不铺十几个图层 —— 省得时间轴被塞满

排版注意（改的时候别踩）：
  · hud-frame 自带上下跑马灯 + 左上角标签，上下各吃掉约 170px；信息层放在 y 0.30~0.66。
  · look-card 默认"每条只显示一个拍"，图层比内容长就会空一大段 —— 这里统一 hold=true。
  · 段落里 4 条信息层首尾叠 45%，保证任何时刻画面上都有东西（脚本末尾会打印空档体检）。
参数名会拿 agent/schema.json 过滤一遍，写错了也不会白填。
"""

import argparse
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SCHEMA = {}
try:
    SCHEMA = json.load(open(os.path.join(ROOT, "agent", "schema.json"), encoding="utf-8"))["templates"]
except Exception:
    pass


def only_known(tpl, want):
    keys = {p["key"] for p in (SCHEMA.get(tpl) or {}).get("params", [])}
    return {k: v for k, v in want.items() if k in keys} if keys else dict(want)


# 段落：名字 / 宫格大字要打的词 / 段落开头的转场 / 段落里 4 条信息层
SECTIONS = [
    ("SIGNAL TRACKING", "ESCAPE VELOCITY PERMANENT UNDERCLASS LOCK IN",
     "glitch-burst", ["word-grid", "stat-counter", "param-ticks", "note-bubble"]),
    ("SYSTEM DRIFT", "ZERO-DAY STARGATE LOOK 06 HANDSHAKE",
     "shutter-wipe", ["dial-gauge", "look-card", "note-bubble", "terminal-prompt"]),
    ("DVR REVIEW", "RECORDED BAYOU DUSK NO BOUNTY SIGNAL LOST",
     "halftone-rise", ["terminal-prompt", "ticker-strip", "param-ticks", "look-card"]),
    ("HARD LOCK", "LOCKED IN NO EXIT STAY DOWN FINAL CALL",
     "scan-wipe", ["stat-counter", "dial-gauge", "shipping-label", "word-grid"]),
    ("ZERO-DAY", "ZERO-DAY PROTOCOL BREACH SILENT RUN",
     "rgb-split", ["look-card", "stat-counter", "note-bubble", "ticker-strip"]),
    ("ESCAPE VELOCITY", "ESCAPE VELOCITY RUN FASTER BEYOND CONTROL",
     "zoom-punch", ["word-grid", "ticker-strip", "dial-gauge", "shipping-label"]),
]

# 锚点：tl/tr/bl/br 四角。除了圆盘仪表（给圆心）和跑马灯条（给 X,Y,W），其余都是左上角。
CORNER_ORDER = ["tl", "tr", "bl", "br"]
PANEL_POS = {"tl": "0.07,0.30", "tr": "0.63,0.34", "bl": "0.07,0.58", "br": "0.61,0.62"}
BIG_POS = {"tl": "0.07,0.30", "tr": "0.65,0.31", "bl": "0.07,0.57", "br": "0.63,0.59"}
DIAL_POS = {"tl": "0.17,0.43", "tr": "0.81,0.46", "bl": "0.17,0.72", "br": "0.81,0.74"}
TICKER_POS = "0.08,0.81,0.84"


def build(duration, bpm, width, height, fps, title):
    beat = 60.0 / bpm
    layers = []

    def add(tpl, s, e, name, want=None):
        s = max(0.0, min(float(s), duration - 0.1))
        e = max(s + 0.1, min(float(e), duration))
        layers.append({
            "template": tpl, "start": round(s, 3), "end": round(e, 3), "opacity": 1,
            "seed": "%s-%02d" % (tpl, len(layers)), "name": name,
            "params": only_known(tpl, want or {}),
        })

    # ① 全程 HUD 底噪
    add("hud-frame", 0, duration, "HUD 全屏框（铺满全程）",
        {"color": "#efece4", "accent": "#ff5a24", "noise": 0.6, "speed": 0.9, "inset": 46,
         "labelLeft": "SIGNAL", "labelRight": "REC", "meter": True, "rulers": True,
         "tickerTop": title + "  11.2 KM/S  PERMANENT UNDERCLASS  ZERO-DAY  NO EXIT",
         "tickerBottom": "SIGNAL LOCKED  AGENT ONLINE  TOKENS BURNED  NVIDIA GTC  129 BILLION"})

    # ② 开场
    add("title-mark", 0.15, 6.4, "标题定格 · 开场",
        {"title": title, "kicker": "SLOPCORE / TRANSMISSION 01", "note": "MADE IN SAN FRANCISCO",
         "position": "0.5,0.50", "size": 168, "fit": True, "maxWidth": 0.86, "rule": True})
    add("terminal-prompt", 1.2, 7.0, "终端面板 · 开机",
        {"title": "PROMPT", "position": "0.06,0.62", "width": 520, "size": 21, "lineHeight": 1.7,
         "charDelay": 0.03, "fill": "#0a0a0b", "color": "#efece4", "accent": "#ff5a24",
         "lines": "> recording %dx%d %dp\n> audio 48k stereo\n> duration %ds\n> status: SIGNAL LOCKED"
                  % (width, height, fps, duration)})

    # ③ 段落
    intro, outro = 7.0, 9.0
    span = (duration - intro - outro) / len(SECTIONS)
    slot = span / 4.0            # 每条信息层占一个槽位，再往后叠 45%，保证整段不断档
    for i, (name, words, trans, infos) in enumerate(SECTIONS):
        s0 = intro + span * i
        s1 = s0 + span
        # 段落开头的转场
        add(trans, s0, s0 + 0.45, "转场 · " + name, {})
        # 段落里的卡点大字（压在画面中间，白字带残影）
        add("kinetic-type", s0 + 0.45, s0 + 0.45 + min(7.0, span * 0.3), "卡点大字 · " + name,
            {"text": name + "\n" + " ".join(words.split()[:2]),
             "mode": "slam", "position": "0.5,0.52", "size": 150, "align": "center",
             "fit": True, "maxWidth": 0.8, "ghost": True, "beatsPerStep": 2})
        # 信息层：4 条首尾叠 45%，铺满整段
        for k, tpl in enumerate(infos):
            corner = CORNER_ORDER[(i + k) % 4]
            a = s0 + 0.6 + slot * k
            b = min(s1 - 0.05, a + slot * 1.45)
            want = {"color": "#efece4", "accent": "#ff5a24"}
            if tpl == "word-grid":
                want.update({"text": words + " " + name, "position": "0.5,0.47",
                             "fontSize": 40, "cols": 4, "cellW": 300, "cellH": 84, "beatsPerStep": 1})
                b = min(s1 - 0.05, a + slot * 2.6)
            elif tpl == "stat-counter":
                want.update({"position": BIG_POS[corner], "label": "SIGNAL " + name.split()[0],
                             "value": 60 + i * 7, "suffix": "%", "size": 104, "bar": True})
            elif tpl == "dial-gauge":
                want.update({"position": DIAL_POS[corner], "label": name.split()[0],
                             "value": 0.4 + i * 0.09, "radius": 96, "showValue": True})
            elif tpl == "param-ticks":
                want.update({"position": PANEL_POS[corner], "width": 330, "rows": 4,
                             "live": True, "frame": True})
            elif tpl == "look-card":
                want.update({"title": "LOOK", "startIndex": 6 + i * 3, "position": PANEL_POS[corner],
                             "width": 460, "size": 22, "stagger": 2, "hold": True,
                             "items": "%s\nSEQUENCE %02d\nNO EXIT" % (name, i + 1)})
            elif tpl == "note-bubble":
                want.update({"text": "> " + words.split()[0].lower() + "\n> " + name.lower(),
                             "position": PANEL_POS[corner], "width": 420, "size": 19})
            elif tpl == "ticker-strip":
                want.update({"position": TICKER_POS, "size": 15, "speed": 1.0, "height": 34,
                             "text": name + "  ·  " + words.replace(" ", "  ·  ")})
            elif tpl == "shipping-label":
                want.update({"product": title, "sku": "%s-%02d" % (name.split()[0], i + 1),
                             "care": "DO NOT PANIC / KEEP MOVING", "width": 340, "rotate": -2})
            elif tpl == "terminal-prompt":
                want.update({"title": "DVR LOG", "position": PANEL_POS[corner], "width": 500,
                             "size": 20, "fill": "#0a0a0b", "color": "#efece4", "accent": "#ff5a24",
                             "lines": "> segment %02d\n> %s\n> signal locked" % (i + 1, name)})
            add(tpl, a, b, "%s · %s" % (SCHEMA.get(tpl, {}).get("name", tpl), name), want)

    # ④ 收尾
    add("title-mark", duration - 9.0, duration, "标题定格 · 收尾",
        {"title": "ESCAPE\nVELOCITY", "kicker": "END OF TRANSMISSION",
         "note": "%d BPM · %d:%02d · SIGNAL LOCKED" % (round(bpm), duration // 60, duration % 60),
         "position": "0.5,0.50",
         "size": 150, "fit": True, "maxWidth": 0.8})

    # ④ 卡点闪白走特效栈（比铺几十个图层省地方）
    fx = [
        {"type": "grain", "amount": 0.12},
        {"type": "scanlines", "amount": 0.14, "step": 3},
        {"type": "chromatic", "amount": 3, "animated": True, "jitter": 1.5},
        {"type": "vignette", "amount": 0.5},
        {"type": "flash", "fillColor": "#ffffff", "hits": "beats", "every": 2, "duration": 0.06, "amount": 0.18},
    ]
    return {
        "name": "slopcore-%ds" % duration,
        "width": width, "height": height, "fps": fps, "duration": duration,
        "bg": None, "transparent": True,
        "beat": {"bpm": bpm, "offset": 0, "duration": duration, "source": "manual"},
        "captions": [],
        "layers": layers,
        "fx": fx,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--duration", type=int, default=180)
    ap.add_argument("--bpm", type=float, default=128)
    ap.add_argument("--width", type=int, default=1920)
    ap.add_argument("--height", type=int, default=1080)
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--title", default="ESCAPE VELOCITY")
    ap.add_argument("--out", default="")
    a = ap.parse_args()
    out = a.out or os.path.join(ROOT, "presets", "slopcore-%ds.json" % a.duration)
    scene = build(a.duration, a.bpm, a.width, a.height, a.fps, a.title)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(scene, f, ensure_ascii=False, indent=2)
    counts = {}
    for l in scene["layers"]:
        counts[l["template"]] = counts.get(l["template"], 0) + 1
    print("生成 -> %s" % out)
    print("  %d 秒 / %d 图层 / %d 个模板" % (a.duration, len(scene["layers"]), len(counts)))
    print("  用量：" + "、".join("%s×%d" % (k, v) for k, v in sorted(counts.items(), key=lambda x: -x[1])))
    # 空档体检：每 1 秒看一次有几条图层活着（hud-frame 铺满全程，所以只有 1 条 = 空档）
    holes = [sec for sec in range(a.duration)
             if sum(1 for l in scene["layers"] if l["start"] <= sec + 0.5 < l["end"]) <= 1]
    print("  空档体检：%s" % ("没有空档" if not holes else "%d 秒只有 HUD：%s" % (len(holes), holes[:12])))


if __name__ == "__main__":
    main()
