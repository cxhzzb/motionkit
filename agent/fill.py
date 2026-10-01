#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
一键铺满 —— 先粗略看一眼素材（亮度 / 运动量 / 镜头切点 / 卡点），
然后按素材时长把整条时间轴铺满图层，你再在这基础上改。

  python agent/fill.py --video clip.mp4 --out projects/fill-1 --json-progress

和 autopilot 的区别：不转写、不叫大模型，纯本地十秒级出结果，
目标是"先把画面铺满，剩下交给人调"。
"""

import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import analyze as AZ  # noqa: E402

# Windows 控制台默认 GBK，输出里带 ✓ 这类字符会直接崩；统一按 UTF-8 输出
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def emit(**o):
    print(json.dumps(o, ensure_ascii=False), flush=True)


def load_json(p, default):
    try:
        return json.load(open(p, encoding="utf-8"))
    except Exception:
        return default


SCHEMA = (load_json(os.path.join(HERE, "schema.json"), {}) or {}).get("templates", {}) or {}
STYLES = (load_json(os.path.join(HERE, "styles.json"), {}) or {}).get("styles", {}) or {}


def only_known(tpl_id, want):
    """只保留这个模板真有的参数，写错 key 也不会白填"""
    keys = {p["key"] for p in (SCHEMA.get(tpl_id) or {}).get("params", [])}
    return {k: v for k, v in want.items() if k in keys}


def merge_shots(shots, min_dur=1.0, max_shots=40):
    """镜头太碎就并起来，不然铺满会生成上百层没法调"""
    out = []
    for sh in shots:
        if out and out[-1]["dur"] < min_dur:
            p = out[-1]
            p["end"] = sh["end"]
            p["dur"] = round(p["end"] - p["start"], 3)
            p["luma"] = round((p["luma"] + sh["luma"]) / 2, 4)
            p["motion"] = max(p["motion"], sh["motion"])
        else:
            out.append(dict(sh))
    if len(out) > 1 and out[-1]["dur"] < min_dur:
        last = out.pop()
        out[-1]["end"] = last["end"]
        out[-1]["dur"] = round(out[-1]["end"] - out[-1]["start"], 3)
    # 还是太多就把最长的那些留着、其余并进邻居
    while len(out) > max_shots:
        i = min(range(len(out) - 1), key=lambda k: out[k]["dur"])
        out[i + 1]["start"] = out[i]["start"]
        out[i + 1]["dur"] = round(out[i + 1]["end"] - out[i + 1]["start"], 3)
        del out[i]
    return out


CORNERS = ["0.06,0.70", "0.80,0.22", "0.06,0.20", "0.80,0.74", "0.06,0.44", "0.80,0.48"]


def pick_for_shot(sh, a, idx, total):
    """按这一段的亮度和运动量挑一个模板（内容驱动的"大概评估"）"""
    dark = sh["luma"] < 0.40
    fast = sh["motion"] > max(0.05, float(a.get("motionMean") or 0.05) * 1.1)
    if idx == 0 and sh["dur"] >= 2.2:
        return "title-mark"
    if sh["dur"] >= 5.5 and not fast:
        return "terminal-prompt"
    if dark and fast:
        return "stat-counter"
    if dark:
        return "param-ticks"
    if fast:
        return "dial-gauge"
    return "shipping-label" if sh["dur"] < 3.2 else "look-card"


def params_for(tpl, sh, a, opts, ink, acc, i, note):
    sh = sh or {"luma": 0.5, "motion": 0.0, "start": 0.0, "end": 0.0, "dur": 0.0}
    pos = CORNERS[i % len(CORNERS)]
    lum = int(round(sh["luma"] * 100))
    mot = int(round(min(1.0, sh["motion"] * 4) * 100))
    common = {"color": ink, "accent": acc}
    if tpl == "title-mark":
        return dict(common, title=opts["title"], kicker=opts["kicker"], note=note,
                    position="0.5,0.5", size=150, rule=True, align="center", fit=True, maxWidth=0.82)
    if tpl == "param-ticks":
        return dict(common, position=pos, width=300, rows=4, live=True, frame=True)
    if tpl == "stat-counter":
        return dict(common, position=pos, label="MOTION", value=mot, suffix="%", size=96, bar=True, roll="count")
    if tpl == "dial-gauge":
        return dict(common, position=pos, label="LUMA", value=lum, radius=96, showValue=True)
    if tpl == "terminal-prompt":
        return dict(common, title="FILL LOG", fill="#0a0a0c", position="0.07,0.34", width=520, size=21,
                    lines=("> scan %s\n> shot %d  luma %d%%  motion %d%%\n> layers auto-placed" % (a["file"], i + 1, lum, mot)))
    if tpl == "look-card":
        return dict(textColor="#111111", accent=acc, position="0.5,0.52", width=520, size=74,
                    title="LOOK", items="LUMA %d%%\nMOTION %d%%\nSHOT %d" % (lum, mot, i + 1))
    if tpl == "shipping-label":
        return dict(accent=acc, position=pos, width=340, rotate=-2,
                    product=opts["title"][:18], sku="SHOT %02d" % (i + 1),
                    care="LUMA %d%%  MOTION %d%%" % (lum, mot))
    if tpl == "kinetic-type":
        return dict(common, position="0.5,0.62", size=120, mode="slam", weight="700",
                    align="center", fit=True, maxWidth=0.8, text=opts["words"][i % len(opts["words"])])
    if tpl == "flash-cut":
        return {"fillColor": "#ffffff", "peak": 0.18 + 0.4 * opts["intensity"], "bar": False, "accent": acc}
    return common


def build(a, style, opts):
    dur = float(a["duration"])
    ink = style.get("ink") or "#efece4"
    acc = style.get("accent") or "#ff5a24"
    layers = []

    def add(tpl, s, e, name, want, seed):
        s = max(0.0, min(float(s), max(0.0, dur - 0.08)))
        e = max(s + 0.08, min(float(e), dur))
        layers.append({
            "template": tpl, "start": round(s, 3), "end": round(e, 3), "opacity": 1,
            "seed": seed, "name": name, "params": only_known(tpl, want),
        })

    shots = merge_shots(a.get("sceneShots") or [])
    bpm = (a.get("beat") or {}).get("bpm")
    note = "%ds · %d 镜头%s" % (round(dur), len(shots), (" · %.0f BPM" % bpm) if bpm else "")

    # ① 全程底噪：这一条就保证"整条时间轴都有东西"
    add("hud-frame", 0, dur, "HUD 全屏框（铺满全程）",
        {"color": ink, "accent": acc, "noise": 0.42, "speed": 0.9, "labelLeft": "FILL", "labelRight": "REC",
         "tickerTop": opts["title"], "tickerBottom": note, "meter": True},
        "fill-hud")

    # ② 逐个镜头铺：按内容挑模板，首尾相接不留空
    for i, sh in enumerate(shots):
        tpl = pick_for_shot(sh, a, i, len(shots))
        add(tpl, sh["start"], sh["end"], "%s · 镜头 %d" % ((SCHEMA.get(tpl) or {}).get("name", tpl), i + 1),
            params_for(tpl, sh, a, opts, ink, acc, i, note), "fill-%02d" % i)

    # ③ 卡点：每 2 小节一个大字、每小节一次闪白（强度越高越密）
    beats = ((a.get("beat") or {}).get("beats") or []) if bpm else []
    step_word = 16 if opts["intensity"] < 0.7 else 8
    step_flash = 8 if opts["intensity"] < 0.7 else 4
    for i, b in enumerate(beats):
        if b < 0.8 or b > dur - 0.6:
            continue
        if i % step_word == 0:
            add("kinetic-type", b, b + 1.6, "卡点大字 · 第 %d 拍" % (i + 1),
                params_for("kinetic-type", shots[min(len(shots) - 1, i // 8)], a, opts, ink, acc, i // step_word, note),
                "fill-word-%d" % i)
        if opts["intensity"] >= 0.35 and i % step_flash == 0:
            add("flash-cut", b, b + 0.26, "闪白 · 落拍", params_for("flash-cut", None, a, opts, ink, acc, i, note),
                "fill-flash-%d" % i)

    # ④ 收尾
    add("title-mark", max(0.0, dur - 3.2), dur, "标题定格 · 收尾",
        dict(params_for("title-mark", shots[-1], a, opts, ink, acc, 0, note),
             title="THAT'S ALL", kicker=opts["kicker"], note=""),
        "fill-end")

    fx = [{"type": "grain", "amount": 0.10}, {"type": "vignette", "amount": 0.40}]
    if style.get("dark"):
        fx.append({"type": "chromatic", "amount": 2.2, "animated": True, "jitter": 0.8})
    if beats and opts["intensity"] >= 0.4:
        fx.append({"type": "flash", "fillColor": "#ffffff", "hits": "beats", "every": 2,
                   "duration": 0.05, "amount": round(0.06 + 0.12 * opts["intensity"], 3)})

    return {
        "name": "fill-" + os.path.splitext(a["file"])[0][:24],
        "width": opts["width"], "height": opts["height"], "fps": opts["fps"],
        "duration": round(dur, 3), "bg": None, "transparent": True,
        "beat": {"bpm": round(float(bpm or 120.0), 3),
                 "offset": round(float((a.get("beat") or {}).get("offset") or 0.0), 4),
                 "duration": round(dur, 3), "source": "audio" if bpm else "manual"},
        "captions": [],
        "layers": layers,
        "fx": fx,
    }, shots


def coverage_gaps(scene):
    """检查整条时间轴有没有漏掉的地方（铺满的意义就在这）"""
    dur = scene["duration"]
    segs = sorted((l["start"], l["end"]) for l in scene["layers"] if l["end"] > l["start"])
    if not segs:
        return [(0.0, dur)]
    gaps, cur = [], 0.0
    for s, e in segs:
        if s > cur + 0.05:
            gaps.append((round(cur, 3), round(s, 3)))
        cur = max(cur, e)
    if cur < dur - 0.05:
        gaps.append((round(cur, 3), round(dur, 3)))
    return gaps


def main():
    ap = argparse.ArgumentParser(description="一键铺满：按素材内容把时间轴铺满")
    ap.add_argument("--video", required=True)
    ap.add_argument("--out", default="")
    ap.add_argument("--title", default="")
    ap.add_argument("--style", default="slopcore")
    ap.add_argument("--intensity", type=float, default=0.6)
    ap.add_argument("--duration", type=float, default=0, help="只铺前 N 秒（0=整段）")
    ap.add_argument("--width", type=int, default=1920)
    ap.add_argument("--height", type=int, default=1080)
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--json-progress", action="store_true")
    args = ap.parse_args()

    t0 = time.time()
    style = STYLES.get(args.style) or STYLES.get("slopcore") or {"ink": "#efece4", "accent": "#ff5a24", "dark": True}
    video = os.path.abspath(args.video)
    if not os.path.isfile(video):
        emit(type="error", msg="找不到视频：%s" % video)
        sys.exit(1)

    emit(type="progress", step="analyze", progress=0.08,
         msg="正在大致评估素材（亮度 / 运动量 / 镜头切点 / 卡点）…")
    a = AZ.analyze(video, limit=(args.duration or None), quiet=False, shot_threshold=0.26)
    emit(type="progress", step="analyze", progress=0.55,
         msg="看完了：%.1f 秒 · %d 个镜头 · 亮度 %.0f%% · 运动 %.0f%%%s"
             % (a["duration"], len(a.get("shots") or []), a["brightness"] * 100, a["motionMean"] * 100,
                (" · %.0f BPM" % a["beat"]["bpm"]) if (a.get("beat") or {}).get("bpm") else ""))

    title = args.title.strip() or os.path.splitext(os.path.basename(video))[0].upper()[:28]
    opts = {
        "title": title, "kicker": "AUTO FILL · " + style.get("name", ""),
        "intensity": max(0.0, min(1.0, args.intensity)),
        "width": args.width, "height": args.height, "fps": args.fps,
        "words": ["GO", "LOUDER", "NEXT", "WATCH", "HOLD", "BREAK", "RUN", "AGAIN"],
    }

    emit(type="progress", step="plan", progress=0.7, msg="正在按镜头铺图层…")
    scene, shots = build(a, style, opts)
    gaps = coverage_gaps(scene)

    outdir = os.path.abspath(args.out or os.path.join(os.path.dirname(HERE), "projects",
                                                      "fill-" + time.strftime("%Y%m%d-%H%M%S")))
    os.makedirs(outdir, exist_ok=True)
    with open(os.path.join(outdir, "analysis.json"), "w", encoding="utf-8") as f:
        json.dump({k: a[k] for k in ("file", "duration", "brightness", "motionMean", "dark",
                                     "cutsPerMinute", "beat", "sceneShots") if k in a},
                  f, ensure_ascii=False, indent=2)
    scene_path = os.path.join(outdir, "scene.json")
    with open(scene_path, "w", encoding="utf-8") as f:
        json.dump(scene, f, ensure_ascii=False, indent=2)

    counts = {}
    for l in scene["layers"]:
        counts[l["template"]] = counts.get(l["template"], 0) + 1
    report = [
        "素材：%s（%.1f 秒 / %d 个镜头 / 亮度 %.0f%% / 运动 %.0f%%）"
        % (a["file"], a["duration"], len(shots), a["brightness"] * 100, a["motionMean"] * 100),
        "铺满结果：%d 个图层，%s" % (len(scene["layers"]), "全程无空隙 ✓" if not gaps else "有 %d 处空隙" % len(gaps)),
        "各模板用量：" + "、".join("%s×%d" % (k, v) for k, v in sorted(counts.items(), key=lambda x: -x[1])),
        "工程：%s" % scene_path,
    ]
    for line in report:
        emit(type="log", msg=line)
    emit(type="progress", step="done", progress=1.0, msg="铺好了，接下来你改就行（用时 %.1f 秒）" % (time.time() - t0))
    emit(type="result", scene=scene, shots=shots, gaps=gaps, outdir=outdir,
         report="\n".join(report), style=args.style)


if __name__ == "__main__":
    main()
