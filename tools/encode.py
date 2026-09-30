#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把 MotionKit 导出的 PNG 序列编码成剪辑软件能吃的格式。

常用：
  ProRes 4444（带 Alpha，PR / FCP / 达芬奇 都认，画质最好）:
    python tools/encode.py --in .out/frames --out ESCAPE.mov --codec prores4444 --fps 24

  WebM VP9（带 Alpha，体积小）:
    python tools/encode.py --in .out/frames --out ESCAPE.webm --codec webm-alpha --fps 24

  直接烧到成片上（把叠加层合成进你的剪辑 base.mp4）:
    python tools/encode.py --in .out/frames --out final.mp4 --codec h264 --overlay base.mp4 --fps 24 --audio music.wav
"""

import argparse
import glob
import os
import shutil
import subprocess


def find_ffmpeg():
    """优先用 imageio-ffmpeg 自带的 ffmpeg（pip 装了就有），其次是 PATH 里的。"""
    try:
        import imageio_ffmpeg
        p = imageio_ffmpeg.get_ffmpeg_exe()
        if p and os.path.exists(p):
            return p
    except Exception:
        pass
    p = shutil.which("ffmpeg")
    if p:
        return p
    for c in [
        r"C:\ffmpeg\bin\ffmpeg.exe",
        "/usr/local/bin/ffmpeg",
        "/opt/homebrew/bin/ffmpeg",
        "/usr/bin/ffmpeg",
    ]:
        if os.path.exists(c):
            return c
    return None


def detect_pattern(folder):
    """自动识别 frame_0001.png 这类命名。"""
    files = sorted(glob.glob(os.path.join(folder, "*.png")))
    if not files:
        raise SystemExit("目录里没有 PNG：%s" % folder)
    # 目录里可能混着 _sheet.png 之类的杂图，挑第一个"结尾带编号"的当模板
    first, digits = None, ""
    for f in files:
        name = os.path.basename(f)
        d = ""
        for ch in reversed(name[:-4]):
            if ch.isdigit():
                d = ch + d
            else:
                break
        if d:
            first, digits = name, d
            break
    if first is None:
        raise SystemExit("文件名里找不到帧号（需要形如 frame_0001.png）")
    prefix = first[: len(first) - len(digits) - 4]
    return files, prefix, len(digits), digits[0]


def run(ffmpeg, args, label):
    cmd = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error"] + args
    print("  " + label)
    print("  " + " ".join('"%s"' % a if " " in a else a for a in cmd[4:]))
    r = subprocess.run(cmd)
    if r.returncode != 0:
        raise SystemExit("ffmpeg 失败（退出码 %d）" % r.returncode)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="indir", required=True, help="PNG 序列目录")
    ap.add_argument("--out", dest="out", required=True, help="输出文件")
    ap.add_argument("--codec", default="prores4444",
                    choices=["prores4444", "prores422", "webm-alpha", "webm", "h264", "hevc", "png"])
    ap.add_argument("--fps", type=float, default=24)
    ap.add_argument("--overlay", default=None, help="底片视频：把叠加层烧到它上面")
    ap.add_argument("--audio", default=None, help="音频文件（mp3/wav/m4a）")
    ap.add_argument("--pattern", default=None, help="帧命名模板，默认自动识别")
    ap.add_argument("--crf", type=int, default=16)
    ap.add_argument("--size", default="1920x1080", help="不透明编码时的画布尺寸")
    ap.add_argument("--bg", default="black", help="不透明编码时的背景色")
    ap.add_argument("--start-number", type=int, default=None, help="序列起始编号（默认自动）")
    args = ap.parse_args()

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise SystemExit(
            "找不到 ffmpeg。\n"
            "  最简单：pip install imageio-ffmpeg\n"
            "  或者把 ffmpeg.exe 加到 PATH 里"
        )
    print("ffmpeg:", ffmpeg)

    files, prefix, ndigits, first_digit = detect_pattern(args.indir)
    pattern = args.pattern or os.path.join(args.indir, "%s%%0%dd.png" % (prefix, ndigits))
    if args.start_number is None:
        args.start_number = int(first_digit + "0" * (ndigits - 1))
    print("识别到 %d 帧，模板：%s，起始编号 %d" % (len(files), pattern, args.start_number))

    seq_in = ["-framerate", str(args.fps), "-start_number", str(args.start_number), "-i", pattern]

    if args.overlay:
        cmd = ["-i", args.overlay] + seq_in + [
            "-filter_complex", "[0:v][1:v]overlay=0:0:format=auto[v]", "-map", "[v]",
        ]
        if args.audio:
            cmd += ["-i", args.audio, "-map", "a:0", "-c:a", "aac", "-b:a", "256k", "-shortest"]
        cmd += ["-c:v", "libx264", "-crf", str(args.crf), "-pix_fmt", "yuv420p",
                "-preset", "slow", "-movflags", "+faststart", args.out]
        run(ffmpeg, cmd, "合成到成片")
        print("\n完成 ->", args.out)
        return

    codec = args.codec
    if codec == "prores4444":
        enc = ["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le",
               "-alpha_bits", "16", "-vendor", "apl0"]
    elif codec == "prores422":
        enc = ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le", "-vendor", "apl0"]
    elif codec == "webm-alpha":
        enc = ["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "18", "-auto-alt-ref", "0"]
    elif codec == "webm":
        enc = ["-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", "-b:v", "0", "-crf", "18"]
    elif codec == "h264":
        enc = ["-c:v", "libx264", "-crf", str(args.crf), "-pix_fmt", "yuv420p", "-preset", "slow"]
    elif codec == "hevc":
        enc = ["-c:v", "libx265", "-crf", str(args.crf), "-pix_fmt", "yuv420p", "-preset", "slow", "-tag:v", "hvc1"]
    else:
        enc = ["-c:v", "png", "-pix_fmt", "rgba"]

    cmd = list(seq_in)
    if args.audio:
        cmd += ["-i", args.audio]
    opaque = codec in ("h264", "hevc", "webm")
    if opaque:
        cmd += ["-f", "lavfi", "-i", "color=c=%s:s=%s:r=%s" % (args.bg, args.size, args.fps)]
        cmd += ["-filter_complex", "[1:v][0:v]overlay=format=auto[v]", "-map", "[v]"]
    if args.audio:
        cmd += ["-map", "a:0", "-c:a", "aac", "-b:a", "256k", "-shortest"]
    cmd += enc + [args.out]
    run(ffmpeg, cmd, "编码 %s" % codec)

    print("\n完成 ->", args.out)
    if codec in ("prores4444", "webm-alpha"):
        print("带 Alpha 的叠加层：直接拖到时间轴上一层即可。")
    elif opaque:
        print("不透明编码；要保留透明请用 --codec prores4444")


if __name__ == "__main__":
    main()
