#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
语音转写：给"自动出字幕"提供时间轴。

两条路，按可用性自动选：
  1. local  —— 本机装了 faster-whisper 就直接跑（离线、免费、最省心）
  2. api    —— 任何 OpenAI 兼容的 /v1/audio/transcriptions
                （OpenAI、硅基流动、Groq、通义…填 baseUrl 和 key 即可）
  两条都不通就返回空，agent 会跳过字幕但其它部分照做。

配置写在 agent/config.json 的 asr 段里：
  { "asr": { "provider": "auto", "baseUrl": "...", "apiKey": "...", "model": "whisper-1" } }

独立使用：
  python agent/transcribe.py --video in.mp4 --start 60 --duration 30 --out subs.srt
"""

import argparse
import json
import os
import sys
import uuid
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, "tools"))

import analyze as A           # noqa: E402
import llm as LLM             # noqa: E402

_LOCAL_MODEL = None


def _cuda_libs_ok():
    """CUDA 不是"有显卡"就能用：ctranslate2 在推理那一刻才会去加载 cuBLAS，
    缺了就直接抛 "Library cublas64_12.dll is not found"。
    所以在 Windows 上先自己试着把这两个 DLL 加载起来，省得白跑一趟。
    """
    import sys as _sys
    if not _sys.platform.startswith("win"):
        return True                      # 非 Windows 交给 ctranslate2 自己判断
    try:
        import ctypes
        for dll in ("cudart64_12.dll", "cublas64_12.dll"):
            ctypes.WinDLL(dll)
        return True
    except Exception:
        return False


def resolve_device(cfg_asr):
    dev = str(cfg_asr.get("device") or "auto").lower()
    if dev != "auto":
        return dev
    try:
        import ctranslate2
        if ctranslate2.get_cuda_device_count() > 0 and _cuda_libs_ok():
            return "cuda"
    except Exception:
        pass
    return "cpu"


def local_available():
    try:
        import faster_whisper  # noqa: F401
        return True
    except Exception:
        return False


def api_available(cfg=None):
    cfg = cfg or LLM.load_config()
    return bool(cfg["asr"].get("apiKey") and cfg["asr"].get("baseUrl"))


def available_providers(cfg=None):
    cfg = cfg or LLM.load_config()
    out = []
    if local_available():
        out.append("local")
    if api_available(cfg):
        out.append("api")
    return out


def _extract(path, start, duration):
    """抽 16k 单声道 wav —— 两个 provider 都吃这个。"""
    return A.extract_wav(path, sr=16000, limit=duration, start=start)


# Whisper 在没人声的段落上会"编"出这几个固定产物（有乐器垫着的时候尤其常见）
JUNK_LINES = {
    "i", "you", "we", "thank you", "thanks for watching", "thank you for watching",
    "please subscribe", "subscribe", "bye", "okay", "yeah", "oh", "ah",
    "谢谢观看", "謝謝觀看", "感谢观看", "請訂閱", "请订阅", "字幕由", "字幕志愿者",
    "ご視聴ありがとうございました", "ご視聴ありがとうございます", "おやすみなさい",
    "amara.org", "www.amara.org", "...", "。", "，", ",", ".", "-", "—",
}


def _is_junk(text, dur):
    """判断一段是不是幻觉产物。

    实测：纯器乐段落上 whisper 会吐出一个孤零零的 "I" 并给它 1.4 秒时长；
    用 VAD 时这种段落是空的，关掉 VAD 之后就必须自己挡掉。
    """
    t = str(text or "").strip().strip(".,!?;:。，！？；：…-— \u3000")
    if not t:
        return True
    if t.lower() in JUNK_LINES:
        return True
    # 一两个字却占了很久 —— 正常说话不会这样
    if len(t) <= 2 and dur > 1.2:
        return True
    return False


def _clean_segments(segs):
    out = []
    for s in segs:
        text = (s.get("text") or "").strip()
        dur = float(s.get("end", 0)) - float(s.get("start", 0))
        if _is_junk(text, dur):
            continue
        s["text"] = text
        out.append(s)
    # 全是幻觉的话，宁可当作"没识别到人声"，也不要往成片上贴一句 "I"
    return out


def _local(wav, cfg, progress=None, lang=None):
    """faster-whisper：第一次调用会下载模型，之后缓存在内存里。"""
    global _LOCAL_MODEL
    from faster_whisper import WhisperModel
    size = cfg["asr"].get("model") or "small"
    if _LOCAL_MODEL is None:
        if progress:
            progress("加载本地语音模型（%s，首次会自动下载）…" % size)
        device = resolve_device(cfg["asr"])
        compute = cfg["asr"].get("computeType") or ("float16" if device == "cuda" else "int8")
        _LOCAL_MODEL = (WhisperModel(size, device=device, compute_type=compute), device)
    model, used_device = _LOCAL_MODEL
    if progress:
        progress("本地转写中（%s / %s）…" % (used_device, size))

    # 直接把 16kHz 单声道浮点数组喂进去，不要让它自己用 PyAV 解文件：
    # faster-whisper 1.2.1 会调 av.open(..., metadata_errors="ignore")，
    # 而 PyAV 19 已经没有这个参数了，走文件路径会直接 TypeError。
    # 我们本来就解过一次音频，喂数组既避开这个坑，也省一遍解码。
    try:
        x, sr = A.read_wav(wav)
        audio = x
    except Exception:
        audio = wav
    vad_cfg = str(cfg["asr"].get("vad", "auto")).lower()
    use_vad = vad_cfg not in ("0", "false", "off", "no")
    allow_retry = vad_cfg not in ("true", "1", "yes", "on")   # auto 才回退

    def run(use_vad_flag):
        # transcribe() 返回的是生成器，必须真的取完才知道有几段
        out, _info = model.transcribe(audio, language=lang, vad_filter=use_vad_flag,
                                      word_timestamps=True)
        return list(out)

    try:
        segs = run(use_vad)
    except Exception as e:
        # 兜底：万一还是撞上 CUDA 运行库缺失，就用 CPU 重来一次
        if used_device != "cpu" and "cublas" in str(e).lower():
            if progress:
                progress("GPU 运行库缺失，改用 CPU 重试…")
            from faster_whisper import WhisperModel as _WM
            model = _WM(size, device="cpu", compute_type="int8")
            _LOCAL_MODEL = (model, "cpu")
            used_device = "cpu"
            segs = run(use_vad)
        else:
            raise

    # Silero VAD 是按"说话"训练的：唱歌、喊、器乐人声经常被它整段判成非语音。
    # MV / 卡点视频全是唱词，用 VAD 会得到 0 段然后白白跳过字幕——所以一旦空手，
    # 就关掉 VAD 再跑一遍（只在真的没结果时才多花这一次）。
    if use_vad and allow_retry and not segs:
        if progress:
            progress("VAD 没找到语音（唱词常被它误判），关掉 VAD 重跑一次…")
        segs = run(False)
    out = []
    for s in segs:
        words = [{"start": round(w.start, 3), "end": round(w.end, 3), "text": w.word}
                 for w in (getattr(s, "words", None) or [])]
        out.append({"start": round(float(s.start), 3), "end": round(float(s.end), 3),
                    "text": (s.text or "").strip(), "words": words})
    return out


def _post_multipart(url, fields, file_field, filename, data, headers_extra, timeout=180):
    boundary = "----MotionKit" + uuid.uuid4().hex
    body = bytearray()
    for k, v in fields.items():
        body += ("--%s\r\nContent-Disposition: form-data; name=\"%s\"\r\n\r\n%s\r\n" % (boundary, k, v)).encode("utf-8")
    body += ("--%s\r\nContent-Disposition: form-data; name=\"%s\"; filename=\"%s\"\r\n"
             "Content-Type: audio/wav\r\n\r\n" % (boundary, file_field, filename)).encode("utf-8")
    body += data
    body += ("\r\n--%s--\r\n" % boundary).encode("utf-8")
    req = urllib.request.Request(url, data=bytes(body), headers={
        "Content-Type": "multipart/form-data; boundary=" + boundary, **headers_extra})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def _api(wav_path, cfg, progress=None, lang=None):
    cfg_asr = cfg["asr"]
    base = str(cfg_asr["baseUrl"]).rstrip("/")
    url = base + "/audio/transcriptions" if base.endswith("/v1") else base + "/v1/audio/transcriptions"
    headers = {"Authorization": "Bearer " + cfg_asr["apiKey"]}
    with open(wav_path, "rb") as f:
        data = f.read()
    fields = {"model": cfg_asr.get("model") or "whisper-1",
              "response_format": "verbose_json"}
    if lang:
        fields["language"] = lang
    if progress:
        progress("调用语音识别接口（%s）…" % cfg_asr.get("model"))
    res = _post_multipart(url, fields, "file", os.path.basename(wav_path), data, headers)
    out = []
    for s in res.get("segments") or []:
        out.append({"start": round(float(s.get("start", 0)), 3),
                    "end": round(float(s.get("end", 0)), 3),
                    "text": (s.get("text") or "").strip(),
                    "words": s.get("words") or []})
    if not out and res.get("text"):
        out.append({"start": 0.0, "end": float(res.get("duration") or 0), "text": res["text"].strip()})
    return out


def transcribe(path, cfg=None, start=0.0, duration=None, progress=None, lang=None, provider=None):
    """返回 {"segments": [...], "provider": "local"/"api"/None, "error": ...}。

    时间轴全部是**相对本段开头**的秒数，和工程时间轴一致。
    """
    cfg = cfg or LLM.load_config()
    want = provider or cfg["asr"].get("provider") or "auto"
    order = available_providers(cfg)
    if want != "auto":
        order = [want] if want in order else []
    if not order:
        return {"segments": [], "provider": None,
                "error": "没装 faster-whisper，也没配 ASR 接口（agent/config.json 的 asr 段）"}

    wav = _extract(path, start, duration)
    try:
        size_mb = os.path.getsize(wav) / 1048576.0
        if progress:
            progress("抽出音频 %.1f MB（16kHz 单声道）" % size_mb)
        errs = []
        for prov in order:
            try:
                segs = _local(wav, cfg, progress, lang) if prov == "local" else _api(wav, cfg, progress, lang)
                segs = [s for s in segs if s["text"]]
                segs = _clean_segments(segs)
                return {"segments": segs, "provider": prov, "error": None}
            except Exception as e:
                errs.append("%s: %s" % (prov, e))
        return {"segments": [], "provider": None, "error": "；".join(errs)}
    finally:
        try:
            os.remove(wav)
        except Exception:
            pass


def _ts(t):
    ms = int(round((t % 1) * 1000))
    total = int(t)
    return "%02d:%02d:%02d,%03d" % (total // 3600, total % 3600 // 60, total % 60, ms)


def write_srt(segments, path):
    lines = []
    for i, s in enumerate(segments, 1):
        lines.append("%d\n%s --> %s\n%s\n" % (i, _ts(s["start"]), _ts(s["end"]), s["text"]))
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--out", default=None)
    ap.add_argument("--start", type=float, default=0.0)
    ap.add_argument("--duration", type=float, default=None)
    ap.add_argument("--lang", default=None)
    ap.add_argument("--provider", default=None)
    ap.add_argument("--json", default=None, help="把结果写成 JSON（含词级时间）")
    args = ap.parse_args()
    r = transcribe(args.video, start=args.start, duration=args.duration,
                   lang=args.lang, provider=args.provider,
                   progress=lambda m: print("  " + m))
    if r["error"]:
        print("转写不可用：" + r["error"])
    print("provider=%s  段数=%d" % (r["provider"], len(r["segments"])))
    for s in r["segments"][:8]:
        print("  [%6.2f - %6.2f] %s" % (s["start"], s["end"], s["text"]))
    if args.out and r["segments"]:
        write_srt(r["segments"], args.out)
        print("字幕 ->", args.out)
    if args.json:
        parent = os.path.dirname(os.path.abspath(args.json))
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(r, f, ensure_ascii=False, indent=1)
        print("JSON ->", args.json)


if __name__ == "__main__":
    main()
