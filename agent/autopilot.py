#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
MotionKit Agent —— 一条命令从一段视频走到一份能渲染的动效工程。

    python agent/autopilot.py --video in.mp4 --out projects/demo

它做的事：
  1. 自动挑片段（不指定的话就找全片最"有事发生"的那一段）
  2. 分析素材：拍点 / 镜头切点 / 亮度 / 运动量 / 人声段
  3. 自动出字幕（装了 faster-whisper 或配了 ASR 接口就会做）
  4. 写文案与定调（有 LLM 用 LLM，没有就用分析数字兜底）
  5. 排图层：卡点大字、HUD 框、终端面板、章节卡、转场、字幕，全部按占位避让
  6. 落盘：scene.json / report.md / analysis.json / transcript.srt
  7. 可选 --render：直接渲出带透明叠加层、ProRes 4444、合好音的成片

用户只需要在几个关键点上拍板：配色风格、动效幅度、信息密度、要不要字幕、做多长。
其余全自动，并且每一步的决定和理由都写进 report.md。

给工作室调用的模式：--json-progress 会把进度按 NDJSON 打到 stdout，最后一行是结果。
"""

import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, "tools"))

import analyze as A          # noqa: E402
import director as D         # noqa: E402
import llm as LLM            # noqa: E402


# ---------------------------------------------------------------- 进度输出
class Reporter:
    def __init__(self, ndjson=False, quiet=False):
        self.ndjson = ndjson
        self.quiet = quiet

    def __call__(self, msg, progress=None, step=None):
        if self.ndjson:
            print(json.dumps({"type": "progress", "msg": msg,
                              "progress": progress, "step": step}, ensure_ascii=False), flush=True)
        elif not self.quiet:
            print(("  " + (("[%3d%%] " % int(progress * 100)) if progress is not None else "") + msg),
                  flush=True)

    def result(self, payload):
        if self.ndjson:
            print(json.dumps({"type": "result", "result": payload}, ensure_ascii=False), flush=True)


# ---------------------------------------------------------------- 选片段
def pick_window(path, target, mode="auto", report=None, has_audio=True):
    """挑一段做。返回 (start, duration)。

    auto：在整片上按 2 次/秒扫一遍，用"运动量 + 亮度变化"当活动度，
          取活动度最高的等长窗口——比从 0 秒开始剪靠谱得多（开头经常是黑场/字幕）。
    """
    info = A.probe(path)
    full = float(info.get("duration") or 0)
    if mode == "full" or full <= target + 0.5:
        return 0.0, min(full, target) if full > 0 else target
    if mode and mode != "auto":
        try:
            a, b = mode.split(":")
            return max(0.0, float(a)), max(0.5, float(b))
        except Exception:
            pass

    if report:
        report("扫描全片找最精彩的 %.0f 秒…" % target)
    # 超长素材别把整片都解码一遍：20 分钟以上只扫前 10 分钟（够挑出可用的段了）
    scan_len = full if full <= 1200 else 600
    vc = A.visual_curve(path, fps=2.0, size=(48, 27), limit=scan_len)
    import numpy as np
    mot = np.asarray(vc["motion"], dtype=np.float32)
    lum = np.asarray(vc["luma"], dtype=np.float32)
    if len(mot) < 4:
        return 0.0, min(full, target)
    dl = np.abs(np.diff(lum, prepend=lum[:1]))
    act = 0.65 * A._norm(mot, 95) + 0.35 * A._norm(dl, 95)
    k = max(1, int(vc["fps"] * 1.5))
    act = np.convolve(act, np.ones(k) / k, mode="same")
    win = max(1, int(round(target * vc["fps"])))
    if win >= len(act):
        return 0.0, min(full, target)
    csum = np.concatenate([[0.0], np.cumsum(act)])
    scores = csum[win:] - csum[:-win]
    best = int(np.argmax(scores))
    start = best / vc["fps"]
    # 别贴着开头切；也别超过片尾（以及扫描范围）
    start = max(0.0, min(start, max(0.0, min(full, scan_len) - target)))
    return round(start, 3), round(min(target, full - start), 3)


# ---------------------------------------------------------------- 渲染
def png_pattern(ov_dir):
    """按目录里真实的帧名推 ffmpeg 的序列模板。

    渲染工具是按"最后一帧的位数"补零的：104 帧就是 frame_%03d.png，1080 帧才是
    %04d。写死 %04d 会直接匹配不到文件，而 ffmpeg 只会安静地不产出成片
    （这个坑踩过一次了）。
    """
    import glob
    import re
    files = sorted(glob.glob(os.path.join(ov_dir, "*.png")))
    if not files:
        return None, 0
    m = re.search(r"(\d+)\.png$", os.path.basename(files[-1]))
    if not m:
        return None, 0
    digits = len(m.group(1))
    name = os.path.basename(files[0])
    prefix = name[: len(name) - digits - 4]
    m2 = re.search(r"(\d+)\.png$", name)
    start = int(m2.group(1)) if m2 else 0
    return os.path.join(ov_dir, "%s%%0%dd.png" % (prefix, digits)), start


def render_all(video, start, duration, scene_path, out_dir, fps, report, want_share=True):
    """渲染叠加层 -> ProRes 4444 -> 烧进剪好的片段。全部落在 out_dir 里。"""
    os.makedirs(out_dir, exist_ok=True)
    ff = A.find_ffmpeg()
    if not ff:
        raise RuntimeError("找不到 ffmpeg，无法渲染")

    ov_dir = os.path.join(out_dir, "overlay_png")
    report("渲染叠加层（%d 帧）…" % int(round(duration * fps)), 0.75, "render")
    r = subprocess.run(["node", os.path.join(ROOT, "tools", "render.mjs"),
                        "--scene", scene_path, "--out", ov_dir, "--fps", str(fps)],
                       cwd=ROOT, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError("叠加层渲染失败：" + (r.stderr or b"").decode("utf-8", "replace")[-500:])

    # 剪出这一段（转码，保证帧精确；-ss 放在 -i 前面走 accurate seek）
    cut = os.path.join(out_dir, "cut.mp4")
    report("剪出这段素材…", 0.85, "cut")
    args = [ff, "-y", "-hide_banner", "-loglevel", "error", "-ss", str(start), "-t", str(duration),
            "-i", video, "-c:v", "libx264", "-crf", "16", "-preset", "veryfast",
            "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", cut]
    r = subprocess.run(args, capture_output=True)
    if r.returncode != 0:
        cut = None

    report("编 ProRes 4444 叠加层（带 Alpha）…", 0.9, "encode")
    mov = os.path.join(out_dir, "overlay-4444-alpha.mov")
    enc = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "encode.py"),
                          "--in", ov_dir, "--out", mov, "--codec", "prores4444", "--fps", str(fps)],
                         cwd=ROOT, capture_output=True)
    if enc.returncode != 0 or not os.path.exists(mov):
        report("ProRes 编码失败：" + (enc.stderr or b"").decode("utf-8", "replace")[-200:], 0.9, "encode")

    final = None
    if cut and os.path.exists(cut):
        report("合成成片…", 0.95, "compose")
        final = os.path.join(out_dir, "final.mp4")
        pattern, start_number = png_pattern(ov_dir)
        if not pattern:
            report("没找到叠加层帧序列，跳过合成", 0.95, "compose")
            final = None
        else:
            # 叠加层的设计尺寸不一定等于底片尺寸。overlay 是"按原尺寸贴到指定坐标"，
            # 尺寸不一致时只会盖住左上角一块（这个坑踩过）。所以先把叠加层缩放到底片尺寸。
            base = A.probe(cut)
            bw, bh = int(base.get("width") or 0), int(base.get("height") or 0)
            bw -= bw % 2
            bh -= bh % 2
            with open(scene_path, encoding="utf-8") as f:
                sc = json.load(f)
            sw, sh = int(sc.get("width") or 0), int(sc.get("height") or 0)
            if bw and bh and (sw, sh) != (bw, bh):
                report("叠加层 %dx%d → 缩放到成片 %dx%d" % (sw, sh, bw, bh), 0.95, "compose")
                fc = "[1:v]scale=%d:%d:flags=lanczos[ov];[0:v][ov]overlay=0:0:format=auto[v]" % (bw, bh)
            else:
                fc = "[0:v][1:v]overlay=0:0:format=auto[v]"
            args = [ff, "-y", "-hide_banner", "-loglevel", "error", "-i", cut,
                    "-framerate", str(fps), "-start_number", str(start_number), "-i", pattern,
                    "-filter_complex", fc,
                    "-map", "[v]", "-map", "0:a?", "-c:v", "libx264", "-crf", "17", "-preset", "medium",
                    "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart", final]
            r2 = subprocess.run(args, capture_output=True)
            if r2.returncode != 0 or not os.path.exists(final):
                report("合成失败：" + (r2.stderr or b"").decode("utf-8", "replace")[-260:], 0.95, "compose")
                final = None
    if final and os.path.exists(mov) and os.path.getsize(mov) > 0:
        # 带 Alpha 的 mov 已经是最好的复用素材了，PNG 序列留着纯占地方
        import shutil
        try:
            shutil.rmtree(ov_dir)
            report("已清理临时 PNG 序列（需要的重跑一次渲染即可）", 0.98, "clean")
        except Exception:
            pass
        ov_dir = None
    return {"overlayPng": ov_dir, "overlayMov": mov if os.path.exists(mov) else None,
            "cut": cut, "final": final}


# ---------------------------------------------------------------- 主流程
def run(video, out_dir, brief=None, target=30.0, clip="auto", use_llm=True,
        asr_provider=None, do_render=False, quiet=False, ndjson=False, lang=None):
    rep = Reporter(ndjson=ndjson, quiet=quiet)
    brief = dict(brief or {})
    styles = D.load_styles()
    cfg = LLM.load_config()
    os.makedirs(out_dir, exist_ok=True)

    if not os.path.exists(video):
        raise SystemExit("找不到素材：%s" % video)

    info = A.probe(video)
    rep("素材 %.2fs  %dx%d  %.2ffps  %s" % (
        info["duration"], info["width"], info["height"], info["fps"],
        "有音轨" if info["hasAudio"] else "无音轨"), 0.03, "probe")

    # 没指定画布尺寸就跟素材走（上限 1080p）：这样叠加层和底片天然 1:1，
    # 不用在合成时缩放，也不会出现"叠加层只盖住左上角"。
    if not brief.get("width") or not brief.get("height"):
        w0 = float(info.get("width") or 1920)
        h0 = float(info.get("height") or 1080)
        k = min(1.0, 1920.0 / w0, 1080.0 / h0)
        brief["width"] = max(2, int(w0 * k) // 2 * 2)
        brief["height"] = max(2, int(h0 * k) // 2 * 2)
        rep("画布跟随素材 -> %dx%d" % (brief["width"], brief["height"]), 0.05, "probe")

    start, duration = pick_window(video, target, clip, rep if not ndjson else None, info["hasAudio"])
    rep("采用 %.2fs 起的 %.2fs（源片一共 %.2fs）" % (start, duration, info["duration"]), 0.1, "window")

    analysis = A.analyze(video, start=start, limit=duration, quiet=True)
    analysis["window"] = {"start": start, "duration": duration}
    analysis["file"] = os.path.basename(video)
    b = analysis.get("beat") or {}
    rep("拍点 BPM %.1f 对齐 %.0f%%｜镜头 %d 个｜亮度 %.2f｜人声段 %d 处" % (
        b.get("bpm", 0), float(b.get("align") or 0) * 100, len(analysis.get("shots") or []),
        analysis.get("brightness", 0), len(analysis.get("speech") or [])), 0.25, "analyze")

    # 字幕
    transcript, tr_meta = [], {"provider": None, "error": None}
    if brief.get("captions", "auto") != "off":
        import transcribe as TR
        provs = TR.available_providers(cfg)
        if provs or asr_provider:
            rep("准备语音转写（可用：%s）…" % (", ".join(provs) or "无"), 0.3, "asr")
            tr = TR.transcribe(video, cfg=cfg, start=start, duration=duration,
                               progress=lambda m: rep(m, 0.35, "asr"),
                               lang=lang or brief.get("lang"), provider=asr_provider)
            transcript = tr["segments"]
            tr_meta = {"provider": tr["provider"], "error": tr["error"],
                       "segments": len(transcript)}
            analysis["asr"] = tr_meta
            if transcript:
                rep("转写完成：%d 段" % len(transcript), 0.5, "asr")
            elif tr_meta.get("provider"):
                rep("这段没识别到人声（多半是器乐 / 环境音）。要换一段试试就加 --clip 起始秒:长度",
                    0.5, "asr")
            else:
                rep("转写跳过：%s" % (tr_meta.get("error") or "没有可用的语音识别"), 0.5, "asr")
        else:
            tr_meta = {"provider": None,
                       "error": "没装 faster-whisper，也没配 ASR 接口；这一版不出字幕"}
            rep("没有可用的语音转写，跳过字幕（其余照做）", 0.45, "asr")
        analysis["transcript"] = transcript

    # 文案
    style_id = D.pick_style(analysis, D.normalize_brief(brief), styles)[0]
    creative = D.fallback_creative(analysis, D.normalize_brief(brief), styles[style_id], transcript)
    if use_llm and LLM.available(cfg):
        rep("让 %s 写文案与定调…" % cfg["llm"].get("model"), 0.55, "llm")
        part = LLM.creative_brief(analysis, D.normalize_brief(brief), styles, transcript,
                                  cfg=cfg, notes=brief.get("notes", ""))
        if part:
            creative = LLM.merge_creative(creative, part)
            rep("文案就绪（标题：%s）" % creative.get("title", ""), 0.62, "llm")
        else:
            rep("LLM 没返回可用内容，改用本地规则文案", 0.62, "llm")
    else:
        rep("用本地规则文案%s" % ("" if use_llm else "（--no-llm）"), 0.6, "llm")

    # 排布
    brief_full = dict(brief)
    brief_full.setdefault("duration", duration)
    scene, report = D.build_scene(analysis, brief_full, creative, styles)
    rep("排布完成：%d 层 / %d 条字幕 / %d 个特效" % (
        len(scene["layers"]), len(scene["captions"]), len(scene["fx"])), 0.7, "plan")

    # 落盘
    def dump(name, obj, text=False):
        p = os.path.join(out_dir, name)
        with open(p, "w", encoding="utf-8") as f:
            f.write(obj if text else json.dumps(obj, ensure_ascii=False, indent=1))
        return p

    paths = {
        "scene": dump("scene.json", scene),
        "analysis": dump("analysis.json", analysis),
        "report": dump("report.md", D.report_markdown(report, analysis), True),
        "brief": dump("agent-brief.json", {"brief": brief_full, "creative": creative,
                                           "window": {"start": start, "duration": duration},
                                           "style": style_id}),
    }
    if transcript:
        import transcribe as TR
        paths["srt"] = TR.write_srt(transcript, os.path.join(out_dir, "transcript.srt"))
        dump("transcript.json", transcript)

    renders = None
    if do_render:
        renders = render_all(video, start, duration, paths["scene"], out_dir,
                             int(scene["fps"]), rep)
        paths.update({k: v for k, v in renders.items() if v})

    result = {
        "video": os.path.abspath(video),
        "window": {"start": start, "duration": duration},
        "scene": scene,
        "report": report,
        "reportMarkdown": D.report_markdown(report, analysis),
        "creative": creative,
        "style": style_id,
        "transcript": transcript,
        "asr": tr_meta,
        "llm": {"used": creative.get("source") == "llm",
                "model": cfg["llm"].get("model") if LLM.available(cfg) else None},
        "analysisSummary": {
            "duration": analysis.get("duration"), "width": analysis.get("width"),
            "height": analysis.get("height"), "fps": analysis.get("fps"),
            "brightness": analysis.get("brightness"), "motion": analysis.get("motionMean"),
            "cuts": len(analysis.get("shots") or []),
            "bpm": (analysis.get("beat") or {}).get("bpm"),
            "align": (analysis.get("beat") or {}).get("align"),
            "hasAudio": analysis.get("hasAudio"),
        },
        "files": paths,
    }
    dump("agent-result.json", result)
    rep("完成 -> %s" % out_dir, 1.0, "done")
    rep.result(result)
    return result


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--out", required=True, help="输出目录，例如 projects/myclip")
    ap.add_argument("--style", default="auto")
    ap.add_argument("--intensity", type=float, default=0.6, help="动效幅度 0~1")
    ap.add_argument("--density", type=float, default=0.55, help="信息密度 0~1")
    ap.add_argument("--captions", default="auto", choices=["auto", "off"])
    ap.add_argument("--caption-style", default="bar",
                    choices=["bar", "mono", "hero", "karaoke"])
    ap.add_argument("--target", type=float, default=30.0, help="目标时长（秒）")
    ap.add_argument("--clip", default="auto", help="auto / full / 起始秒:长度")
    ap.add_argument("--width", type=int, default=0, help="叠加层画布宽（0 = 跟随素材，上限 1080p）")
    ap.add_argument("--height", type=int, default=0, help="叠加层画布高（0 = 跟随素材，上限 1080p）")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--lang", default=None)
    ap.add_argument("--notes", default="", help="补充要求（会喂给 LLM）")
    ap.add_argument("--asr", default=None, help="local / api / auto")
    ap.add_argument("--llm", dest="llm", action="store_true", default=True)
    ap.add_argument("--no-llm", dest="llm", action="store_false")
    ap.add_argument("--render", action="store_true", help="顺便渲染成片（慢）")
    ap.add_argument("--json-progress", action="store_true", help="NDJSON 进度（工作室用）")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    brief = {
        "style": args.style, "intensity": args.intensity, "density": args.density,
        "captions": args.captions, "captionStyle": args.caption_style,
        "width": args.width, "height": args.height, "fps": args.fps,
        "lang": args.lang, "notes": args.notes, "duration": args.target,
    }
    run(args.video, args.out, brief=brief, target=args.target, clip=args.clip,
        use_llm=args.llm, asr_provider=args.asr, do_render=args.render,
        quiet=args.quiet, ndjson=args.json_progress, lang=args.lang)


if __name__ == "__main__":
    main()
