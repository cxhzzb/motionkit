#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
跟着音乐自动剪片 —— 把一堆素材按歌的节拍剪成一条片子。

  # 看它打算怎么剪（不落盘）
  python tools/autocut.py --music song.mp3 --clips D:\\clips --dry-run

  # 真剪：按拍点切素材 → 拼起来 → 配上这首歌
  python tools/autocut.py --music song.mp3 --clips D:\\clips --out projects/rock-auto

  # 顺便生成摇滚风格的叠加层工程（可以在工作室里接着调）
  python tools/autocut.py --music song.mp3 --clips D:\\clips --scene-only

  # 连叠加层一起烧进成片（会调用 render.mjs + encode.py，慢）
  python tools/autocut.py --music song.mp3 --clips D:\\clips --overlay

怎么决定"哪里切"：分频段谱通量求拍点（和工作室里那套是同一个算法），
按每小节 4 拍归一到强拍网格，再看每一段的能量档位给剪辑密度：
安静段 4 拍一刀、中间 2 拍、爆点 1 拍。落在拍点上的切点还会做 ±90ms 的
起音峰吸附，避免"看着对、听着一顿"。
"""

import argparse
import json
import math
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import beatmap as bm  # noqa: E402  复用已有的卡点分析

VIDEO_EXT = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".mpg", ".mpeg", ".flv", ".wmv"}


# ---------------------------------------------------------------- 小工具
def ffmpeg_path():
    p = bm.find_ffmpeg()
    if not p:
        raise SystemExit("找不到 ffmpeg：pip install imageio-ffmpeg")
    return p


def run(cmd, quiet=True):
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        msg = (r.stderr or b"").decode("utf-8", "ignore").strip().splitlines()
        tail = "\n".join(msg[-4:]) if msg else ""
        raise RuntimeError("命令失败：%s\n%s" % (" ".join(map(str, cmd[:6])), tail))
    return r


def probe_duration(ff, path):
    """不装 ffprobe 也能拿到时长：解析 ffmpeg -i 的 stderr"""
    r = subprocess.run([ff, "-hide_banner", "-i", path], capture_output=True)
    txt = (r.stderr or b"").decode("utf-8", "ignore")
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", txt)
    if not m:
        return 0.0
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))


# ---------------------------------------------------------------- 分析
def analyze(music, bpm_min=70, bpm_max=180, refine_ms=90):
    """→ 拍点、每拍能量、段落档位"""
    x, sr = bm.load_audio(music)
    dur = len(x) / float(sr)
    onset, env_rate, low, env_off = bm.onset_envelope(x, sr)
    bpm, conf, lag = bm.estimate_tempo(onset, env_rate, bpm_min, bpm_max)
    phase = bm.estimate_phase(onset, low, lag)
    period = 60.0 / bpm

    # 网格拍点（从 0 之前半拍起步，保证覆盖整首歌）
    first = phase / env_rate + env_off
    while first - period >= 0:
        first -= period
    grid = []
    t = first
    while t < dur + 0.05:
        grid.append(t)
        t += period

    # 吸附到最近的起音峰（±refine_ms）
    win = int(round(refine_ms / 1000.0 * env_rate))
    beats = []
    for g in grid:
        fi = int(round((g - env_off) * env_rate))
        a, b = max(0, fi - win), min(len(onset), fi + win + 1)
        if b > a:
            k = a + int(np.argmax(onset[a:b]))
            t2 = k / env_rate + env_off
            if abs(t2 - g) <= refine_ms / 1000.0:
                g = t2
        beats.append(round(max(0.0, g), 4))
    beats = sorted(set(beats))

    # 每一拍的能量（RMS，用它判断段落强弱）
    energy = []
    for i, b in enumerate(beats):
        b2 = beats[i + 1] if i + 1 < len(beats) else min(dur, b + period)
        s, e = int(b * sr), int(max(b + 0.02, b2) * sr)
        seg = x[max(0, s):min(len(x), e)]
        energy.append(float(np.sqrt(np.mean(seg ** 2))) if seg.size else 0.0)
    energy = np.array(energy, dtype=np.float32)

    # 平滑一点再分档：低 / 中 / 高
    k = 5
    sm = np.convolve(energy, np.ones(k) / k, mode="same")
    lo, hi = np.percentile(sm, 38), np.percentile(sm, 72)
    levels = np.where(sm <= lo, 0, np.where(sm >= hi, 2, 1)).astype(int)
    # 再按"多数票"平滑一次：逐拍的档位抖来抖去的话，段落会被切得稀碎
    levels = smooth_levels(levels, 9)

    return {
        "duration": dur, "sr": sr, "bpm": bpm, "confidence": conf,
        "period": period, "beats": beats, "energy": sm.tolist(), "levels": levels.tolist(),
    }


def smooth_levels(levels, win=9):
    """多数票平滑：窗口内哪个档位多就算哪个"""
    n = len(levels)
    if n == 0:
        return levels
    out = np.zeros(n, dtype=int)
    half = max(1, win // 2)
    for i in range(n):
        seg = levels[max(0, i - half):min(n, i + half + 1)]
        out[i] = int(np.bincount(seg, minlength=3).argmax())
    return out


def sections_from_levels(beats, levels, min_len=5.0):
    """把连续的"同档位"拍合成段落，太短的并到前一段"""
    secs = []
    for i, lv in enumerate(levels):
        t = beats[i]
        if secs and secs[-1]["level"] == lv:
            secs[-1]["end"] = t
            secs[-1]["beats"].append(i)
        else:
            secs.append({"level": int(lv), "start": t, "end": t, "beats": [i]})
    for s in secs:
        s["end"] = min(s["end"] + (beats[1] - beats[0] if len(beats) > 1 else 0.5), beats[-1] + 0.5)
    # 合并过短的段
    merged = []
    for s in secs:
        if merged and (s["end"] - s["start"]) < min_len:
            merged[-1]["end"] = s["end"]
            merged[-1]["beats"] += s["beats"]
        else:
            merged.append(dict(s))
    for i, s in enumerate(merged):
        s["index"] = i
        s["dur"] = round(s["end"] - s["start"], 3)
    return merged


def plan_cuts(beats, levels, sections, density=1.0, min_shot=0.35, max_dur=None):
    """每一段按档位决定"几拍一刀"，产出镜头列表"""
    per_shot = {0: 4, 1: 2, 2: 1}          # 安静 4 拍 / 中间 2 拍 / 爆点 1 拍
    cuts = [0]
    i = 1
    while i < len(beats):
        lv = levels[i]
        step = max(1, int(round(per_shot[lv] / max(0.25, density))))
        # 尽量落在 4 拍强拍网格上，2 拍以上时才优先对齐
        if step >= 2:
            j = i
            while j < len(beats) and j % 4 != 0 and (beats[j] - beats[i - 1 if cuts else 0]) < 0.4:
                j += 1
            if j < len(beats) and j % 4 == 0 and j - i <= 1:
                i = j
        nxt = min(len(beats) - 1, i + step)
        # 最短镜头：宁可少切几刀
        while nxt < len(beats) - 1 and (beats[nxt] - beats[cuts[-1]]) < min_shot:
            nxt += 1
        if (beats[nxt] - beats[cuts[-1]]) < min_shot and len(cuts) > 1:
            nxt = len(beats) - 1
        cuts.append(nxt)
        i = nxt + 1
        if nxt >= len(beats) - 1:
            break

    shots = []
    for idx, (a, b) in enumerate(zip(cuts[:-1], cuts[1:])):
        # 第一个镜头从 0 开始：整条片子的时间轴起点就是 0，
        # 否则开头会多出"到第一拍"的那段空白，后面全部错位
        t0, t1 = (0.0 if idx == 0 else beats[a]), beats[b]
        a2 = a if idx else 0
        if max_dur and t0 >= max_dur:
            break
        if max_dur:
            t1 = min(t1, max_dur)
        if t1 - t0 < 0.06:
            continue
        lv = levels[min(a2, len(levels) - 1)]
        sec = next((s["index"] for s in sections if s["start"] <= t0 <= s["end"]), 0)
        shots.append({"t0": round(t0, 4), "dur": round(t1 - t0, 4), "beat": a2, "level": int(lv), "section": sec})
    return shots


def list_clips(paths):
    out = []
    for p in paths:
        if os.path.isdir(p):
            for root, _dirs, files in os.walk(p):
                for f in files:
                    if os.path.splitext(f)[1].lower() in VIDEO_EXT:
                        out.append(os.path.join(root, f))
        elif os.path.isfile(p) and os.path.splitext(p)[1].lower() in VIDEO_EXT:
            out.append(p)
    return sorted(set(out))


def assign_clips(shots, clips, durs=None, seed=7):
    """给每个镜头配素材：同一个素材不连着用，取用点回绕，别取到没有画面"""
    rnd = random.Random(seed)
    order = clips[:]
    rnd.shuffle(order)
    durs = durs or {}
    cursors = {c: rnd.uniform(0.0, 2.0) for c in order}
    looped = set()
    for i, s in enumerate(shots):
        c = order[i % len(order)]
        if i and len(order) > 1 and s.get("_last") == c:
            c = order[(i + 1) % len(order)]
        s["_last"] = c
        s["clip"] = c
        cd = durs.get(c, 0.0)
        # 可用区间：保证 in + 镜头时长 不超出素材
        limit = cd - s["dur"] - 0.05 if cd else 0.0
        if limit > 0.1:
            s["in"] = round(cursors[c] % limit, 3)
            cursors[c] = cursors[c] + s["dur"] + rnd.uniform(0.4, 1.8)
        else:
            # 素材比镜头还短：从头取，交给 ffmpeg 循环补齐（总比黑屏强）
            s["in"] = 0.0
            s["loop"] = True
            looped.add(c)
    for s in shots:
        s.pop("_last", None)
    return shots, sorted(looped)


# ---------------------------------------------------------------- 剪 + 拼
def cut_one(ff, shot, out_path, size, fps):
    w, h = size
    vf = ("scale=%d:%d:force_original_aspect_ratio=decrease,"
          "pad=%d:%d:(ow-iw)/2:(oh-ih)/2:color=black,fps=%d,setsar=1" % (w, h, w, h, fps))
    cmd = [ff, "-y", "-hide_banner", "-loglevel", "error"]
    if shot.get("loop"):
        cmd += ["-stream_loop", "-1"]
    cmd += ["-ss", "%.3f" % shot["in"], "-i", shot["clip"], "-t", "%.3f" % shot["dur"],
            "-an", "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
            "-pix_fmt", "yuv420p", out_path]
    run(cmd)


def render_segments(ff, shots, tmpdir, size, fps, workers=4, log=None):
    os.makedirs(tmpdir, exist_ok=True)
    paths = [os.path.join(tmpdir, "seg_%04d.mp4" % i) for i in range(len(shots))]
    done = [0]

    def job(i):
        cut_one(ff, shots[i], paths[i], size, fps)
        done[0] += 1
        if log and (done[0] % 10 == 0 or done[0] == len(shots)):
            log("  剪好了 %d/%d 个镜头" % (done[0], len(shots)))

    with ThreadPoolExecutor(max_workers=max(1, workers)) as ex:
        list(ex.map(job, range(len(shots))))
    return paths


def concat_segments(ff, paths, out_path):
    lst = out_path + ".txt"
    with open(lst, "w", encoding="utf-8") as f:
        for p in paths:
            f.write("file '%s'\n" % os.path.abspath(p).replace("\\", "/"))
    try:
        run([ff, "-y", "-hide_banner", "-loglevel", "error",
             "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", out_path])
    finally:
        try:
            os.remove(lst)
        except Exception:
            pass


def mux_music(ff, video, music, out_path):
    run([ff, "-y", "-hide_banner", "-loglevel", "error",
         "-i", video, "-i", music,
         "-map", "0:v:0", "-map", "1:a:0",
         "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", out_path])


# ---------------------------------------------------------------- 摇滚叠加层工程
NAME_BY_LEVEL = {0: "VERSE", 1: "BUILD", 2: "CHORUS"}


def build_scene(analysis, sections, duration, title="", style="rock"):
    """生成一份可以直接在工作室里打开的叠加层工程"""
    period = analysis["period"]
    offset = analysis["beats"][0] if analysis["beats"] else 0.0
    layers = []

    def add(tpl, start, end, name, params, seed):
        if start >= duration:
            return
        layers.append({
            "template": tpl, "start": round(start, 3), "end": round(min(end, duration), 3),
            "opacity": 1, "seed": seed, "name": name, "params": params,
        })

    # 开场：大字标题
    add("rock-title", 0.35, min(6.5, duration), "摇滚大标题",
        {"text": (title or "ROCK\nIT").upper(),
         "sub": "AUTO CUT · %d BPM" % round(analysis["bpm"]),
         "tag": "SIDE A", "size": 170, "maxWidth": 0.8},
        "rock-open")

    # 每个段落：胶带标签报段落名；爆点段落再补一记大字
    counts = {0: 0, 1: 0, 2: 0}
    for s in sections:
        lv = s["level"]
        counts[lv] += 1
        label = "%s %d" % (NAME_BY_LEVEL[lv], counts[lv])
        if s["start"] > 1.0:
            add("tape-label", s["start"] + 0.06, s["start"] + 2.8, "胶带标签 · " + label,
                {"label": label, "note": "%d BPM" % round(analysis["bpm"]), "size": 44,
                 "position": "0.5,0.22", "angle": -5},
                "tape-%d" % s["index"])
        if lv == 2 and counts[2] <= 3:
            add("rock-title", s["start"] + 0.15, s["start"] + 4.2, "摇滚大标题 · " + label,
                {"text": ["TURN IT UP", "LOUDER", "NO SURRENDER"][min(2, counts[2] - 1)],
                 "sub": label, "tag": "CHORUS", "size": 176, "maxWidth": 0.78},
                "rock-%d" % s["index"])

    # 收尾
    if duration > 6:
        add("rock-title", max(0.0, duration - 5.2), duration - 0.4, "摇滚大标题 · 收尾",
            {"text": "THAT'S ALL", "sub": "THANKS FOR WATCHING", "tag": "SIDE B",
             "size": 132, "maxWidth": 0.7},
            "rock-end")

    return {
        "name": "autocut-" + style,
        "width": 1920, "height": 1080, "fps": 30, "duration": round(duration, 3),
        "bg": None, "transparent": True,
        "beat": {"bpm": round(analysis["bpm"], 3), "offset": round(offset, 4),
                 "duration": round(duration, 3), "source": "auto"},
        "captions": [],
        "layers": layers,
        "fx": [
            {"type": "grain", "amount": 0.10},
            {"type": "vignette", "amount": 0.42},
            {"type": "chromatic", "amount": 2.2, "animated": True, "jitter": 0.8},
            {"type": "flash", "fillColor": "#ffffff", "hits": "beats", "every": 2,
             "duration": 0.05, "amount": 0.10},
        ],
    }


# ---------------------------------------------------------------- 命令行
def main():
    ap = argparse.ArgumentParser(description="跟着音乐自动剪片（卡点剪辑）")
    ap.add_argument("--music", required=True, help="音乐文件（mp3/wav/m4a 都行）")
    ap.add_argument("--clips", default="", help="素材：文件夹，或逗号分隔的多个视频")
    ap.add_argument("--out", default="", help="输出目录（默认 projects/autocut-<时间>）")
    ap.add_argument("--duration", type=float, default=0, help="只做前 N 秒（0=整首）")
    ap.add_argument("--density", type=float, default=1.0, help="剪辑密度倍率，1.0 是默认，1.5 更碎")
    ap.add_argument("--min-shot", type=float, default=0.35, help="最短镜头秒数")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--size", default="1920x1080", help="输出分辨率，如 1920x1080")
    ap.add_argument("--title", default="", help="开场大标题（默认用歌名）")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--jobs", type=int, default=4, help="同时剪几个镜头")
    ap.add_argument("--dry-run", action="store_true", help="只打印剪辑方案，不落盘")
    ap.add_argument("--scene-only", action="store_true", help="只生成叠加层工程（不剪片）")
    ap.add_argument("--no-scene", action="store_true", help="不生成叠加层工程")
    ap.add_argument("--overlay", action="store_true", help="把叠加层烧进成片（慢）")
    args = ap.parse_args()

    def log(s):
        print(s, flush=True)

    w, h = (int(x) for x in args.size.lower().split("x"))
    music = os.path.abspath(args.music)
    if not os.path.isfile(music):
        raise SystemExit("找不到音乐文件：%s" % music)

    log("· 分析节拍…")
    a = analyze(music)
    total = args.duration if args.duration > 0 else a["duration"]
    total = min(total, a["duration"])
    log("  BPM %.2f（置信度 %.0f%%）· 共 %d 拍 · 时长 %.1f 秒"
        % (a["bpm"], a["confidence"] * 100, len(a["beats"]), a["duration"]))

    secs = sections_from_levels(a["beats"], a["levels"])
    shots = plan_cuts(a["beats"], a["levels"], secs, args.density, args.min_shot, max_dur=total)
    if not shots:
        raise SystemExit("没规划出镜头，检查一下音乐是不是太短")
    avg = sum(s["dur"] for s in shots) / len(shots)
    log("  段落 %d 个 · 镜头 %d 个 · 平均每个 %.2f 秒" % (len(secs), len(shots), avg))
    for s in secs[:14]:
        log("    %6.1f–%6.1f  %s" % (s["start"], s["end"], ["安静", "中段", "爆点"][s["level"]]))

    scenes_dir = os.path.abspath(args.out or os.path.join("projects", "autocut-" + time.strftime("%Y%m%d-%H%M%S")))
    scene = None if args.no_scene else build_scene(a, secs, total, args.title, "rock")

    if args.dry_run:
        log("\n· 前 12 个镜头（不落盘）：")
        for s in shots[:12]:
            log("    %6.2fs  时长 %.2fs  第 %d 拍  %s" % (s["t0"], s["dur"], s["beat"], ["静", "中", "爆"][s["level"]]))
        if scene:
            log("\n· 叠加层会用到这些模板：" + ", ".join(sorted({l["template"] for l in scene["layers"]}))
                + "（共 %d 层）" % len(scene["layers"]))
        return

    os.makedirs(scenes_dir, exist_ok=True)
    with open(os.path.join(scenes_dir, "analysis.json"), "w", encoding="utf-8") as f:
        json.dump({"bpm": a["bpm"], "confidence": a["confidence"], "duration": a["duration"],
                   "beats": a["beats"], "sections": secs}, f, ensure_ascii=False, indent=2)
    with open(os.path.join(scenes_dir, "beats.txt"), "w", encoding="utf-8") as f:
        for i, b in enumerate(a["beats"]):
            f.write("%.4f\tBEAT %03d\n" % (b, i + 1))
    if scene:
        with open(os.path.join(scenes_dir, "overlay-scene.json"), "w", encoding="utf-8") as f:
            json.dump(scene, f, ensure_ascii=False, indent=2)
        log("· 叠加层工程 → %s" % os.path.join(scenes_dir, "overlay-scene.json"))

    if args.scene_only:
        log("· 只生成工程，没剪片（--scene-only）")
        log("  在工作室里：打开工程 → 选这个 overlay-scene.json，就能接着调")
        return

    clips = list_clips([p.strip() for p in args.clips.split(",") if p.strip()])
    if not clips:
        raise SystemExit("没找到素材视频：--clips 给个文件夹或者视频文件")
    ff = ffmpeg_path()
    durs = {}
    for c in clips:
        durs[c] = probe_duration(ff, c)
    log("· 素材 %d 个（总长 %.1f 秒）" % (len(clips), sum(durs.values())))
    shots, looped = assign_clips(shots, clips, durs, args.seed)
    if looped:
        log("  ⚠ 有素材比镜头还短，会被循环使用：" + ", ".join(os.path.basename(x) for x in looped))

    with open(os.path.join(scenes_dir, "plan.json"), "w", encoding="utf-8") as f:
        json.dump({"music": music, "size": [w, h], "fps": args.fps,
                   "shots": [{"t0": s["t0"], "dur": s["dur"], "beat": s["beat"],
                              "level": s["level"], "clip": s["clip"], "in": s["in"]} for s in shots]},
                  f, ensure_ascii=False, indent=2)

    tmp = os.path.join(scenes_dir, "_segs")
    log("· 剪镜头（%d 个，%d 路并行）…" % (len(shots), args.jobs))
    t0 = time.time()
    paths = render_segments(ff, shots, tmp, (w, h), args.fps, args.jobs, log)
    log("· 拼接…")
    silent = os.path.join(scenes_dir, "_silent.mp4")
    concat_segments(ff, paths, silent)
    final = os.path.join(scenes_dir, "cut.mp4")
    log("· 配上音乐…")
    mux_music(ff, silent, music, final)
    shutil.rmtree(tmp, ignore_errors=True)
    try:
        os.remove(silent)
    except Exception:
        pass
    log("✓ 成片 → %s（用时 %.1f 秒）" % (final, time.time() - t0))

    if scene:
        log("")
        log("· 想加摇滚叠加层，两个办法：")
        log("  ① 工作室里打开工程 → overlay-scene.json → 调好参数后导出叠加层，再叠到 cut.mp4 上")
        log("  ② 命令行一条龙：")
        log("     node tools/render.mjs --scene \"%s\" --out .out/auto-overlay"
            % os.path.join(scenes_dir, "overlay-scene.json"))
        log("     python tools/encode.py --in .out/auto-overlay --out \"%s\" --codec h264 --overlay \"%s\" --fps %d"
            % (os.path.join(scenes_dir, "final.mp4"), final, args.fps))


if __name__ == "__main__":
    main()
