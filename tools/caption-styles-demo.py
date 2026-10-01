#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把一份预设里的字幕按「字幕换装」重铺一遍，生成一份演示工程。

  python tools/caption-styles-demo.py --scene presets/slopcore.json \
         --out presets/slopcore-captionstyles.json --tier mid --seed 3

用的是和 AI 剪辑（agent/director.py）同一套样子池，所以做出来的东西
和「AI 助手」自动生成、以及工作室里点「给每句字幕换模板」是一回事。
工作室里那套在 studio/studio.js 的 CAPTION_LOOKS，加新样子记得两边一起加。
"""

import argparse
import json
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "agent"))

import director  # noqa: E402  （要先把 agent/ 塞进 sys.path）

# 池子的顺序是 [字幕类 ×3, 面板类 ×5, 中强度 ×8, 海报级 ×3]，一共 19 个样子
TIER_KEEP = {"sub": [0, 8], "mid": [0, 16], "poster": [0, 19]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scene", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--tier", default="mid", choices=["sub", "mid", "poster"])
    ap.add_argument("--seed", type=int, default=3)
    ap.add_argument("--ink", default="")
    ap.add_argument("--accent", default="")
    ap.add_argument("--intensity", type=float, default=0.7)
    ap.add_argument("--name", default="")
    a = ap.parse_args()

    scene = json.load(open(a.scene, encoding="utf-8"))
    caps = scene.get("captions") or []
    if not caps:
        raise SystemExit("%s 里没有字幕条，换一个带字幕的预设" % a.scene)

    # 颜色：先看命令行，再看工程里 HUD 用的那套，最后兜底
    inks, accents = [], []
    for L in scene.get("layers", []):
        p = L.get("params") or {}
        for k in ("color", "ink"):
            if isinstance(p.get(k), str) and p[k].startswith("#"):
                inks.append(p[k])
        if isinstance(p.get("accent"), str) and p["accent"].startswith("#"):
            accents.append(p["accent"])
    ink = a.ink or (inks[0] if inks else "#f2ece0")
    accent = a.accent or (accents[0] if accents else "#ff5a24")

    looks = director.caption_looks(scene["width"], scene["height"], ink, accent, a.intensity)
    lo, hi = TIER_KEEP[a.tier]
    looks = looks[lo:min(hi, len(looks))]
    picks = director._plan_looks(caps, looks, random.Random(a.seed))

    # 原工程里的整段字幕层先撤掉，不然和换装的打架
    scene["layers"] = [L for L in scene.get("layers", [])
                       if not (L.get("template") == "subtitle-kinetic" and "卡点字幕" in (L.get("name") or ""))]

    for i, cap in enumerate(caps):
        tid, label, _maxlen, make = looks[picks[i]]
        sub = tid == "subtitle-kinetic"
        scene["layers"].append({
            "template": tid,
            "start": round(max(0.0, cap["start"] - (0 if sub else 0.15)), 3),
            "end": round(min(scene["duration"], cap["end"] + (0 if sub else 0.35)), 3),
            "params": make(cap, i, len(caps)),
            "seed": "cap-%02d" % (i + 1),
            "name": "字幕换装 %02d · %s" % (i + 1, label),
            "opacity": 1, "blend": "source-over", "enabled": True,
            "group": "caption-reskin",
        })

    used = sorted({looks[j][1] for j in picks})
    scene["name"] = a.name or (scene.get("name", "scene") + "-captionstyles")
    json.dump(scene, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print("生成 -> %s" % a.out)
    print("  %d 句字幕 / %d 种样子：%s" % (len(caps), len(used), "、".join(used)))


if __name__ == "__main__":
    main()
