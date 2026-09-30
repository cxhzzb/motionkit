#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
素材分析：把一段视频/音频拆成 agent 能用的数字。

产出（analysis.json）：
  · 基本规格 / 时长 / 有没有音轨
  · 拍点：BPM、偏移、每个拍点、强拍（复用 tools/beatmap.py 那套算法）
  · 镜头切点：靠 ffmpeg 的 scene 检测，附带每个镜头的亮度和运动量
  · 曲线：4 次/秒的亮度、运动量、整体响度、低频（鼓）能量
  · 人声段：没装 ASR 时的粗略 VAD（有 ASR 时会被真实时间轴覆盖）

这些数字是给 agent 做"判断"用的——哪里该卡点、哪里该安静、用什么配色、
幅度给多大。不追求学术指标好看，追求排出来的东西能看。

独立使用：
  python agent/analyze.py --video in.mp4 --out analysis.json
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "tools"))


def find_ffmpeg():
    try:
        import imageio_ffmpeg
        p = imageio_ffmpeg.get_ffmpeg_exe()
        if p and os.path.exists(p):
            return p
    except Exception:
        pass
    import shutil
    return shutil.which("ffmpeg")


FFMPEG = find_ffmpeg()


def run(args, **kw):
    if not FFMPEG:
        raise SystemExit("找不到 ffmpeg（pip install imageio-ffmpeg）")
    return subprocess.run([FFMPEG, "-hide_banner", "-nostdin"] + args,
                          capture_output=True, **kw)


# ---------------------------------------------------------------- 基本规格
def probe(path):
    r = run(["-i", path])
    text = (r.stderr or b"").decode("utf-8", "replace")
    out = {"duration": 0.0, "fps": 0.0, "width": 0, "height": 0,
           "hasAudio": False, "vcodec": "", "acodec": ""}
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("Duration:"):
            hms = line.split("Duration:")[1].split(",")[0].strip()
            try:
                h, m, s = hms.split(":")
                out["duration"] = int(h) * 3600 + int(m) * 60 + float(s)
            except Exception:
                pass
        elif line.startswith("Stream #") and "Video:" in line:
            out["hasAudio"] = out["hasAudio"] or "Audio:" in line
            # "2560x1440 [SAR 1:1 DAR 16:9], 59.94 fps"
            for part in line.split(","):
                part = part.strip()
                if "x" in part and part.split("x")[0].strip().isdigit():
                    wh = part.split()[0].split("x")
                    if len(wh) == 2 and wh[1].isdigit():
                        out["width"], out["height"] = int(wh[0]), int(wh[1])
                if part.endswith("fps"):
                    try:
                        out["fps"] = float(part.split()[0])
                    except Exception:
                        pass
            if "Video:" in line:
                try:
                    out["vcodec"] = line.split("Video:")[1].strip().split()[0]
                except Exception:
                    pass
        elif line.startswith("Stream #") and "Audio:" in line:
            out["hasAudio"] = True
            try:
                out["acodec"] = line.split("Audio:")[1].strip().split()[0]
            except Exception:
                pass
    return out


# ---------------------------------------------------------------- 音频
def extract_wav(path, sr=22050, limit=None, start=0.0):
    fd, tmp = tempfile.mkstemp(suffix=".wav", prefix="mk_agent_")
    os.close(fd)
    args = ["-y", "-loglevel", "error"]
    if start:
        args += ["-ss", str(start)]
    if limit:
        args += ["-t", str(limit)]
    args += ["-i", path, "-vn", "-ac", "1", "-ar", str(sr), "-f", "wav", tmp]
    r = run(args)
    if r.returncode != 0 or not os.path.exists(tmp):
        raise RuntimeError("抽音频失败：" + (r.stderr or b"").decode("utf-8", "replace")[-400:])
    return tmp


def read_wav(path):
    with wave.open(path, "rb") as w:
        sr, n, ch, sw = w.getframerate(), w.getnframes(), w.getnchannels(), w.getsampwidth()
        raw = w.readframes(n)
    if sw != 2:
        raise RuntimeError("只支持 16bit wav")
    x = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    return x, sr


def frame_energies(x, sr, win=1024, hop=512):
    """逐帧 RMS / 低频 / 中频能量，用于曲线和粗 VAD。"""
    n = 1 + max(0, (len(x) - win) // hop)
    if n < 2:
        z = np.zeros(2, dtype=np.float32)
        return z, z, z, sr / hop
    idx = np.arange(win)[None, :] + (np.arange(n) * hop)[:, None]
    frames = x[idx]
    rms = np.sqrt((frames ** 2).mean(axis=1) + 1e-12).astype(np.float32)
    spec = np.abs(np.fft.rfft(frames * np.hanning(win)[None, :], axis=1))
    freqs = np.fft.rfftfreq(win, 1.0 / sr)
    lo = (freqs >= 30) & (freqs < 180)
    mid = (freqs >= 300) & (freqs < 3400)
    low = spec[:, lo].mean(axis=1).astype(np.float32)
    voice = spec[:, mid].mean(axis=1).astype(np.float32)
    return rms, low, voice, sr / hop


def beat_analysis(wav_path):
    """拍点检测直接跑 tools/beatmap.py 这个现成的 CLI。

    为什么不 import 进来再调：那套算法的"最小二乘精修"是嵌在它 main() 里的
    局部函数，抠出来改一遍容易改坏，而且以后两边会慢慢漂。让它 CLI 干活、
    我们读它写出来的 JSON —— 算法只有一份，命令行和 agent 永远一致。
    """
    beats_py = os.path.join(ROOT, "tools", "beatmap.py")
    fd, out = tempfile.mkstemp(suffix=".json", prefix="mk_beats_")
    os.close(fd)
    try:
        r = subprocess.run([sys.executable, beats_py, "--in", wav_path, "--out", out],
                           capture_output=True)
        if r.returncode != 0 or not os.path.exists(out):
            raise RuntimeError("beats 分析失败: " +
                               (r.stderr or b"").decode("utf-8", "replace")[-300:])
        with open(out, encoding="utf-8") as f:
            data = json.load(f)
        return {
            "bpm": data.get("bpm", 120.0),
            "offset": data.get("offset", 0.0),
            "confidence": data.get("confidence", 0.0),
            "firstBeat": data.get("firstBeat", 0),
            "beats": data.get("beats", []),
            "downbeats": data.get("downbeats", []),
        }
    finally:
        try:
            os.remove(out)
        except Exception:
            pass


def beat_alignment(wav_path, beats):
    """拍点对齐度：每个拍点附近到底有没有真的起音峰。

    为什么不用 beatmap 自带的 confidence：那个值是"自相关峰 / 拍点数量"的经验比，
    完美对齐的 click track 也只有 25%，音乐上更是常常只有个位数——拿它当门槛，
    要么把好素材误判成没拍子，要么把错拍子放进工程。这里改成实测：
    看每个拍点 ±1 帧内是否出现了接近局部峰值的起音，返回命中比例。
    """
    if not beats:
        return 0.0
    try:
        import beatmap
    except Exception:
        return 0.0
    try:
        x, sr = beatmap.load_audio(wav_path)
        onset, rate, _low, off = beatmap.onset_envelope(x, sr)
    except Exception:
        return 0.0
    if len(onset) < 8:
        return 0.0
    hits = 0
    for b in beats:
        i = int(round((float(b) - off) * rate))
        lo, hi = max(0, i - 1), min(len(onset), i + 2)
        if hi <= lo:
            continue
        wlo, whi = max(0, i - 6), min(len(onset), i + 7)
        local = float(onset[wlo:whi].max())
        if local <= 1e-6:
            continue
        if float(onset[lo:hi].max()) >= 0.42 * local and float(onset[lo:hi].max()) > 0.08:
            hits += 1
    return round(hits / float(len(beats)), 4)


def speech_regions(x, sr, voice, voice_rate, min_dur=0.55):
    """粗 VAD：中频（人声主要频段）相对能量超过自适应阈值就算"有人在说话"。

    没有装 ASR 的时候，至少能知道哪里有人声——用来避免把大字压在说话上。
    """
    if len(voice) < 4:
        return []
    v = np.log1p(voice * 200.0)
    # 自适应阈值：中位数 + 0.35 * 动态范围
    lo, hi = float(np.percentile(v, 20)), float(np.percentile(v, 95))
    thr = lo + 0.42 * (hi - lo)
    active = v > thr
    regions = []
    i = 0
    while i < len(active):
        if active[i]:
            j = i
            while j + 1 < len(active) and (active[j + 1] or (j + 2 < len(active) and active[j + 2])):
                j += 1
            t0, t1 = i / voice_rate, (j + 1) / voice_rate
            if t1 - t0 >= min_dur:
                # 两端各留一点余量，语音的起音和收音经常被判没
                regions.append([round(max(0.0, t0 - 0.12), 3), round(t1 + 0.18, 3)])
            i = j + 1
        else:
            i += 1
    return regions


# ---------------------------------------------------------------- 画面
def shot_cuts(path, threshold=0.30, limit=None, start=0.0):
    """ffmpeg scene 检测。返回 [{t, score}]，t 是**相对窗口开头**的秒数。

    注意日志行的真实长相是
        [Parsed_metadata_1 @ 000001f2] frame:0    pts:128000  pts_time:10.416667
        [Parsed_metadata_1 @ 000001f2] lavfi.scene_score=0.350775
    所以不能拿 startswith("frame:") 去匹配（前面有过滤器前缀，永远匹配不上，
    切点会被静默丢光——这个坑踩过一次了）。
    """
    args = ["-loglevel", "info"]
    if start:
        args += ["-ss", str(start)]
    if limit:
        args += ["-t", str(limit)]
    args += ["-i", path, "-an",
             "-vf", "select='gt(scene,%.3f)',metadata=print" % threshold,
             "-f", "null", "-"]
    r = run(args)
    text = ((r.stderr or b"") + (r.stdout or b"")).decode("utf-8", "replace")
    cuts, pending_t = [], None
    for line in text.splitlines():
        if "pts_time:" in line and "frame:" in line:
            try:
                pending_t = float(line.split("pts_time:")[1].split()[0])
            except Exception:
                pending_t = None
        elif "lavfi.scene_score=" in line and pending_t is not None:
            try:
                score = float(line.split("lavfi.scene_score=")[1].strip())
            except Exception:
                score = threshold
            cuts.append({"t": round(pending_t, 4), "score": round(score, 4)})
            pending_t = None
    return cuts


def visual_curve(path, fps=4.0, size=(64, 36), limit=None, start=0.0):
    """按 fps 解码成小灰度图，算亮度 + 帧间差（运动量）。"""
    w, h = size
    args = ["-loglevel", "error"]
    if start:
        args += ["-ss", str(start)]
    if limit:
        args += ["-t", str(limit)]
    args += ["-i", path, "-an", "-vf", "fps=%s,scale=%d:%d" % (fps, w, h),
             "-f", "rawvideo", "-pix_fmt", "gray", "-"]
    r = run(args)
    buf = np.frombuffer(r.stdout or b"", dtype=np.uint8)
    n = len(buf) // (w * h)
    if n < 2:
        return {"fps": fps, "luma": [], "motion": [], "size": [w, h]}
    frames = buf[:n * w * h].reshape(n, h, w).astype(np.float32)
    luma = frames.reshape(n, -1).mean(axis=1) / 255.0
    diff = np.abs(np.diff(frames, axis=0)).reshape(n - 1, -1).mean(axis=1) / 255.0
    motion = np.concatenate([[0.0], diff])
    return {"fps": fps, "luma": luma, "motion": motion, "size": [w, h]}


# ---------------------------------------------------------------- 汇总
def _resample(arr, src_rate, dst_rate, n_out=None):
    """把逐帧曲线降采样到固定速率，控制 JSON 体积。

    所有曲线最后都被拉成同样长度 n_out —— 规划器要按同一根时间轴索引它们，
    差一个采样点就会像上面那样广播失败。
    """
    arr = np.asarray(arr)
    if arr.size == 0:
        return np.zeros(n_out or 0, dtype=np.float32)
    if n_out is None:
        n_out = max(1, int(len(arr) * dst_rate / src_rate))
    ratio = len(arr) / float(n_out)
    idx = np.clip((np.arange(n_out) * ratio).astype(int), 0, len(arr) - 1)
    return arr[idx]


def _norm(a, pct=97):
    a = np.asarray(a, dtype=np.float32)
    if a.size == 0:
        return a
    m = float(np.percentile(np.abs(a), pct))
    return np.clip(a / m, 0, 1.4) if m > 1e-9 else a


def analyze(path, out=None, curve_rate=4.0, limit=None, quiet=False, start=0.0, shot_threshold=0.26):
    info = probe(path)
    start = max(0.0, float(start))
    avail = max(0.0, info["duration"] - start)
    duration = min(avail, limit) if limit else avail
    result = {
        "file": os.path.basename(path),
        "path": os.path.abspath(path),
        "start": round(start, 4),
        "duration": round(float(duration), 4),
        "sourceDuration": round(float(info["duration"]), 4),
        "fps": round(float(info["fps"]), 4),
        "width": info["width"], "height": info["height"],
        "hasAudio": bool(info["hasAudio"]),
        "vcodec": info["vcodec"], "acodec": info["acodec"],
    }

    # 画面
    vc = visual_curve(path, fps=curve_rate, limit=limit, start=start)
    n_curve = max(2, int(round(duration * curve_rate)) + 1)
    luma = _resample(vc["luma"], vc["fps"], curve_rate, n_curve)
    motion = _resample(vc["motion"], vc["fps"], curve_rate, n_curve)
    result["curve"] = {
        "rate": curve_rate,
        "luma": [round(float(v), 4) for v in luma],
        "motion": [round(float(v), 4) for v in motion],
    }
    result["brightness"] = round(float(np.mean(luma)) if len(luma) else 0.5, 4)
    result["motionMean"] = round(float(np.mean(motion)) if len(motion) else 0.05, 4)
    result["dark"] = bool(result["brightness"] < 0.38)

    # 镜头切点
    cuts = shot_cuts(path, threshold=shot_threshold, limit=limit, start=start)
    result["shots"] = cuts
    span = max(0.5, duration / 60.0)
    result["cutsPerMinute"] = round(len(cuts) / span, 3)

    # 给每个镜头标上亮度/运动（用切点作为分界）
    bounds = [0.0] + [c["t"] for c in cuts if 0 < c["t"] < duration] + [duration]
    shots = []
    for i in range(len(bounds) - 1):
        a, b = bounds[i], bounds[i + 1]
        ia, ib = int(a * curve_rate), max(int(a * curve_rate) + 1, int(b * curve_rate))
        seg_l = luma[ia:ib] if len(luma) else []
        seg_m = motion[ia:ib] if len(motion) else []
        shots.append({
            "start": round(a, 3), "end": round(b, 3), "dur": round(b - a, 3),
            "luma": round(float(np.mean(seg_l)) if len(seg_l) else 0.5, 4),
            "motion": round(float(np.mean(seg_m)) if len(seg_m) else 0.0, 4),
        })
    result["sceneShots"] = shots

    # 音频
    if info["hasAudio"]:
        wav = extract_wav(path, limit=limit, start=start)
        try:
            x, sr = read_wav(wav)
            rms, low, voice, erate = frame_energies(x, sr)
            result["beat"] = beat_analysis(wav)
            result["beat"]["align"] = beat_alignment(wav, result["beat"].get("beats") or [])
            result["speech"] = speech_regions(x, sr, voice, erate)
            r = _resample(rms, erate, curve_rate, n_curve)
            l = _resample(low, erate, curve_rate, n_curve)
            result["curve"]["rms"] = [round(float(v), 4) for v in _norm(r)]
            result["curve"]["low"] = [round(float(v), 4) for v in _norm(l)]
            result["rmsMean"] = round(float(np.mean(rms)) if len(rms) else 0.0, 4)
            result["loudnessRange"] = round(float(np.percentile(rms, 95) - np.percentile(rms, 10)), 4) if len(rms) else 0.0
        finally:
            try:
                os.remove(wav)
            except Exception:
                pass
    else:
        result["beat"] = {"bpm": 120.0, "offset": 0.0, "confidence": 0.0,
                          "beats": [], "downbeats": []}
        result["speech"] = []
        result["curve"]["rms"] = []
        result["curve"]["low"] = []
        result["rmsMean"] = 0.0
        result["loudnessRange"] = 0.0

    # 活动曲线：把"这里有事情发生"综合成一个 0..1 的分数，给 agent 挑高光用
    n = len(result["curve"]["luma"])
    if n:
        mo = _norm(np.asarray(result["curve"]["motion"], dtype=np.float32), 95)
        rm = _norm(np.asarray(result["curve"]["rms"] or [0] * n, dtype=np.float32), 95)
        cut_flag = np.zeros(n, dtype=np.float32)
        for c in cuts:
            i = int(c["t"] * curve_rate)
            if 0 <= i < n:
                cut_flag[i] = 1.0
        score = 0.42 * mo + 0.33 * rm + 0.25 * cut_flag
        # 平滑一下，避免选出来的"高光"全是单帧闪烁
        k = max(1, int(curve_rate * 1.0))
        kernel = np.ones(k) / k
        score = np.convolve(score, kernel, mode="same")
        result["curve"]["activity"] = [round(float(v), 4) for v in score]
    else:
        result["curve"]["activity"] = []

    if out:
        parent = os.path.dirname(os.path.abspath(out))
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(out, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=1)
        if not quiet:
            print("已写出分析 ->", out)
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--out", default=None)
    ap.add_argument("--limit", type=float, default=None, help="只分析前 N 秒")
    ap.add_argument("--start", type=float, default=0.0, help="从第几秒开始分析")
    ap.add_argument("--shot-threshold", type=float, default=0.26, help="镜头切点灵敏度，越小越灵敏")
    ap.add_argument("--curve-rate", type=float, default=4.0)
    args = ap.parse_args()
    a = analyze(args.video, out=args.out, curve_rate=args.curve_rate, limit=args.limit,
                start=args.start, shot_threshold=args.shot_threshold)
    print("时长 %.2fs  %dx%d  %.2ffps  音轨:%s" % (
        a["duration"], a["width"], a["height"], a["fps"], "有" if a["hasAudio"] else "无"))
    print("亮度 %.2f（%s）  运动 %.3f  切点 %d（%.1f 次/分）" % (
        a["brightness"], "偏暗" if a["dark"] else "偏亮",
        a["motionMean"], len(a["shots"]), a["cutsPerMinute"]))
    if a["hasAudio"]:
        print("BPM %.2f（置信度 %.0f%%）  拍点 %d  人声段 %d" % (
            a["beat"]["bpm"], a["beat"]["confidence"] * 100,
            len(a["beat"]["beats"]), len(a["speech"])))


if __name__ == "__main__":
    main()
