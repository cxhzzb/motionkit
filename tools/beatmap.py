#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
命令行卡点分析（和浏览器里那套算法等价）。
输出 JSON，可直接给 Studio 或你自己的脚本用。

  python tools/beatmap.py --in music.mp3 --out beats.json
  python tools/beatmap.py --in music.wav --markers beats.txt --fps 24
"""

import argparse
import json
import math
import os
import shutil
import subprocess
import tempfile
import wave

import numpy as np


def find_ffmpeg():
    try:
        import imageio_ffmpeg
        p = imageio_ffmpeg.get_ffmpeg_exe()
        if p and os.path.exists(p):
            return p
    except Exception:
        pass
    return shutil.which("ffmpeg")


def load_audio(path):
    """解码成单声道 float32。优先直接读 wav，否则交给 ffmpeg。"""
    if path.lower().endswith(".wav"):
        try:
            with wave.open(path, "rb") as w:
                sr = w.getframerate()
                ch = w.getnchannels()
                sw = w.getsampwidth()
                raw = w.readframes(w.getnframes())
            dt = {1: np.uint8, 2: np.int16, 4: np.int32}[sw]
            data = np.frombuffer(raw, dtype=dt).astype(np.float32)
            if sw == 1:
                data = (data - 128.0) / 128.0
            else:
                data = data / float(2 ** (8 * sw - 1))
            if ch > 1:
                data = data.reshape(-1, ch).mean(axis=1)
            return data, sr
        except Exception:
            pass

    ff = find_ffmpeg()
    if not ff:
        raise SystemExit("需要 ffmpeg 才能解码 %s（pip install imageio-ffmpeg）" % path)
    tmp = os.path.join(tempfile.gettempdir(), "mk_beat_tmp.wav")
    subprocess.run([ff, "-y", "-hide_banner", "-loglevel", "error", "-i", path,
                    "-ac", "1", "-ar", "22050", "-f", "wav", tmp], check=True)
    with wave.open(tmp, "rb") as w:
        sr = w.getframerate()
        raw = w.readframes(w.getnframes())
    data = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    try:
        os.remove(tmp)
    except Exception:
        pass
    return data, sr


def onset_envelope(x, sr, win=1024, hop=256, block=4096):
    n = 1 + max(0, (len(x) - win) // hop)
    if n < 8:
        zeros = np.zeros(4, dtype=np.float32)
        return zeros, sr / hop, zeros, win / (2.0 * sr)
    freqs = np.fft.rfftfreq(win, 1.0 / sr)
    lowmask = (freqs >= 30) & (freqs < 180)
    midmask = (freqs >= 180) & (freqs < 2000)
    highmask = (freqs >= 2000) & (freqs < 9000)
    hann = np.hanning(win)

    flux_low = np.zeros(n, dtype=np.float32)
    flux_mid = np.zeros(n, dtype=np.float32)
    flux_high = np.zeros(n, dtype=np.float32)
    low = np.zeros(n, dtype=np.float32)
    prev = None

    # 分块做 STFT，避免长音频一次性吃掉几百 MB
    for start in range(0, n, block):
        stop = min(n, start + block)
        idx = np.arange(win)[None, :] + (np.arange(start, stop) * hop)[:, None]
        spec = np.abs(np.fft.rfft(x[idx] * hann[None, :], axis=1))
        # 对数压缩：均衡强弱频段，避免低频瞬态淹没一切
        comp = np.log1p(spec * 12.0)
        if prev is not None:
            comp = np.vstack([prev[None, :], comp])
        d = np.maximum(0.0, np.diff(comp, axis=0))
        off = start - (1 if prev is not None else 0)
        # 注意是"频段内平均"而不是求和：否则高频噪声的 bin 数量优势会把底鼓压死
        flux_low[off + 1: off + 1 + d.shape[0]] = d[:, lowmask].mean(axis=1)
        flux_mid[off + 1: off + 1 + d.shape[0]] = d[:, midmask].mean(axis=1)
        flux_high[off + 1: off + 1 + d.shape[0]] = d[:, highmask].mean(axis=1)
        low[start:stop] = spec[:, lowmask].sum(axis=1)
        prev = comp[-1]

    # 低频（底鼓）主导，中频补充，高频只留一点点
    def _norm(a):
        m = float(a.max()) if a.size else 0.0
        return a / m if m > 1e-9 else a
    combined = (_norm(flux_low) * 0.6 + _norm(flux_mid) * 0.28 + _norm(flux_high) * 0.12).astype(np.float32)
    if low.max() > 0:
        low = low / low.max()

    env_rate = sr / hop
    # 第 f 帧代表的时间是 f*hop/sr + win/(2*sr)，别忘了这半个窗口的常数偏移
    env_offset = win / (2.0 * sr)
    span = max(2, int(env_rate * 0.35))
    base = np.convolve(combined, np.ones(span) / span, mode="same")
    onset = np.maximum(0.0, combined - base * 1.15)
    if onset.max() > 0:
        onset = onset / onset.max()
    return onset.astype(np.float32), env_rate, low.astype(np.float32), env_offset


def estimate_tempo(onset, env_rate, bpm_min, bpm_max):
    min_lag = max(2, int(round((60.0 / bpm_max) * env_rate)))
    max_lag = min(len(onset) - 2, int(round((60.0 / bpm_min) * env_rate)))
    if max_lag <= min_lag:
        return 120.0, 0.0, float(max(2, min_lag))
    scores = {}
    best_lag, best = min_lag, -1.0
    for lag in range(min_lag, max_lag + 1):
        s = float(np.dot(onset[:-lag], onset[lag:]))
        bpm = 60.0 * env_rate / lag
        prior = math.exp(-((math.log2(bpm / 120.0) / 0.6) ** 2))
        s *= 0.55 + 0.45 * prior
        scores[lag] = s
        if s > best:
            best, best_lag = s, lag
    lag = float(best_lag)
    if min_lag < best_lag < max_lag:
        y0, y1, y2 = scores[best_lag - 1], scores[best_lag], scores[best_lag + 1]
        den = y0 - 2 * y1 + y2
        if abs(den) > 1e-9:
            lag = best_lag - 0.5 * (y2 - y0) / den
    bpm = 60.0 * env_rate / lag
    while bpm < 70:
        bpm *= 2
    while bpm > 180:
        bpm /= 2
    conf = min(1.0, max(0.0, best / (len(onset) * 0.06)))
    return bpm, conf, lag


def estimate_phase(onset, low, period_frames):
    steps = max(8, int(round(period_frames)))
    best_phase, best = 0.0, -1.0
    for p in range(steps):
        ph = p / steps * period_frames
        idx = np.arange(ph, len(onset), period_frames).astype(int)
        idx = idx[idx < len(onset)]
        if len(idx) == 0:
            continue
        s = float((onset[idx] * (1.0 + 0.4 * low[idx])).sum())
        if s > best:
            best, best_phase = s, ph
    return best_phase


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", dest="out", default=None, help="输出 JSON")
    ap.add_argument("--markers", dest="markers", default=None, help="额外输出 Premiere 标记 txt")
    ap.add_argument("--bpm-min", type=float, default=60)
    ap.add_argument("--bpm-max", type=float, default=200)
    ap.add_argument("--fps", type=float, default=24, help="生成标记时间码用的帧率")
    ap.add_argument("--no-refine", action="store_true", help="不把拍点吸附到起音峰值")
    args = ap.parse_args()

    x, sr = load_audio(args.inp)
    print("音频：%d 采样 @%dHz，时长 %.2fs" % (len(x), sr, len(x) / sr))
    onset, env_rate, low, env_offset = onset_envelope(x, sr)
    bpm, conf, period = estimate_tempo(onset, env_rate, args.bpm_min, args.bpm_max)
    phase = estimate_phase(onset, low, period)
    duration = len(x) / sr
    to_t = lambda f: f / env_rate + env_offset          # 帧 -> 秒

    def build(period_f, phase_f):
        out = []
        k = int(math.floor(-phase_f / period_f))
        while True:
            base = phase_f + k * period_f
            t = to_t(base)
            if t > duration:
                break
            # 允许略微负的时间（第一个拍点常常落在 0 之前一点点），最后再钳到 0
            if t >= -0.6:
                out.append(t)
            k += 1
        return out

    def snap(raw, search):
        """把每个拍点吸附到邻域内最强的起音峰。"""
        res = []
        for t in raw:
            b = int(round((t - env_offset) * env_rate))
            lo, hi = max(0, b - search), min(len(onset), b + search + 1)
            if args.no_refine or hi <= lo:
                res.append(t)
            else:
                res.append((lo + int(np.argmax(onset[lo:hi]))) / env_rate + env_offset)
        return res

    def refine(period_f, phase_f, rounds=3):
        """最小二乘把网格拟合到起音峰上。

        自相关只能精确到一帧（hop 决定了量化误差），单纯取相邻峰间距的中位数
        会被量化噪声带偏；对 (序号 -> 峰位置) 做直线拟合可以把小数周期平出来，
        35 个拍点就能把周期误差压到万分之几。
        """
        for _ in range(rounds):
            raw = build(period_f, phase_f)
            sn = snap(raw, max(1, int(round(period_f * 0.12))))
            if len(sn) < 4:
                break
            frames = (np.array(sn) - env_offset) * env_rate
            idx = np.arange(len(sn), dtype=float)
            for _pass in range(3):
                A = np.vstack([idx, np.ones_like(idx)]).T
                slope, intercept = np.linalg.lstsq(A, frames, rcond=None)[0]
                resid = frames - (slope * idx + intercept)
                keep = np.abs(resid) < max(1.5, period_f * 0.3)
                if keep.all():
                    break
                idx, frames = idx[keep], frames[keep]
            period_f = float(slope)
            phase_f = float(intercept)
            phase_f = phase_f % period_f
        return period_f, phase_f

    period, phase = refine(period, phase)
    bpm = 60.0 * env_rate / period if period > 0 else bpm
    while bpm < 70:
        bpm *= 2
    while bpm > 180:
        bpm /= 2
    beats = [round(max(0.0, t), 4) for t in snap(build(period, phase), max(1, int(round(period * 0.12))))]

    if len(beats) >= 4:
        lowi = np.clip(((np.array(beats) - env_offset) * env_rate).astype(int), 0, len(low) - 1)
        shift = int(np.argmax([float(low[lowi[s::4]].sum()) for s in range(4)]))
    else:
        shift = 0
    downbeats = [b for i, b in enumerate(beats) if (i - shift) % 4 == 0]

    data = {
        "bpm": round(bpm, 4),
        "offset": round(beats[0] if beats else 0.0, 4),
        "confidence": round(conf, 4),
        "duration": round(duration, 4),
        "firstBeat": shift,
        "beats": beats,
        "downbeats": downbeats,
    }
    print("BPM %.2f  置信度 %.0f%%  拍数 %d  时长 %.1fs" % (bpm, conf * 100, len(beats), duration))

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print("已写出 ->", args.out)
    else:
        print(json.dumps({k: v for k, v in data.items() if k not in ("beats", "downbeats")}, ensure_ascii=False))

    if args.markers:
        fps = args.fps

        def tc(t):
            return "%02d:%02d:%02d:%02d" % (
                int(t // 3600), int(t % 3600 // 60), int(t % 60), int((t % 1) * fps))

        with open(args.markers, "w", encoding="utf-8") as f:
            for i, b in enumerate(beats):
                f.write("%s\tBEAT %03d\t00:00:00:00\n" % (tc(b), i + 1))
        print("已写出标记 ->", args.markers, "（Premiere：标记面板 → 导入标记）")


if __name__ == "__main__":
    main()
