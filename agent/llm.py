#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
LLM 适配层（OpenAI 兼容接口，DeepSeek / OpenAI / 硅基流动 都能用）。

它在这个 agent 里只负责**文案和口味**，不负责几何：
  · 标题、副标、注解写什么
  · 卡点砸哪几个词
  · 跑马灯和终端面板编什么内容
  · 章节怎么分
  · 从六个配色预设里挑一个

时间轴、字号、位置、闪白强度全部由 director.py 的规则决定。这样即使模型今天
心情不好，工程也不会烂掉——最坏情况就是文案平庸，排版依然是对的。

没配 Key 时所有函数都会安静地返回 None，调用方退回规则文案。

配置优先级：命令行参数 > 环境变量 > agent/config.json > 默认值

  MK_LLM_BASE   https://api.deepseek.com
  MK_LLM_KEY    sk-...
  MK_LLM_MODEL  deepseek-chat
"""

import json
import os
import re
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))


def load_config(path=None):
    cfg = {"llm": {}, "asr": {}}
    p = path or os.path.join(HERE, "config.json")
    if os.path.exists(p):
        try:
            with open(p, encoding="utf-8") as f:
                data = json.load(f)
            for k in ("llm", "asr"):
                if isinstance(data.get(k), dict):
                    cfg[k].update(data[k])
        except Exception:
            pass
    env = {
        "baseUrl": os.environ.get("MK_LLM_BASE"),
        "apiKey": os.environ.get("MK_LLM_KEY"),
        "model": os.environ.get("MK_LLM_MODEL"),
        "timeout": os.environ.get("MK_LLM_TIMEOUT"),
    }
    for k, v in env.items():
        if v:
            cfg["llm"][k] = float(v) if k == "timeout" else v
    asr_env = {
        "baseUrl": os.environ.get("MK_ASR_BASE"),
        "apiKey": os.environ.get("MK_ASR_KEY"),
        "model": os.environ.get("MK_ASR_MODEL"),
    }
    for k, v in asr_env.items():
        if v:
            cfg["asr"][k] = v
    cfg["llm"].setdefault("baseUrl", "https://api.deepseek.com")
    cfg["llm"].setdefault("model", "deepseek-chat")
    cfg["llm"].setdefault("timeout", 90)
    return cfg


def available(cfg=None):
    cfg = cfg or load_config()
    return bool(cfg["llm"].get("apiKey"))


def chat(messages, cfg=None, temperature=0.7, max_tokens=1400, json_mode=False):
    """一次同步对话。失败抛异常，让调用方决定怎么降级。"""
    cfg = cfg or load_config()
    key = cfg["llm"].get("apiKey")
    if not key:
        return None
    base = str(cfg["llm"].get("baseUrl") or "").rstrip("/")
    # 兼容两种情况：给的是 https://api.deepseek.com 还是 https://api.deepseek.com/v1
    url = base + "/chat/completions" if base.endswith("/v1") else base + "/v1/chat/completions"
    body = {
        "model": cfg["llm"].get("model"),
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": False,
    }
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    req = urllib.request.Request(
        url, data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
    )
    timeout = float(cfg["llm"].get("timeout") or 90)
    last = None
    for attempt in range(2):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = json.loads(r.read().decode("utf-8", "replace"))
            return (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:300]
            last = RuntimeError("HTTP %s: %s" % (e.code, detail))
            if e.code in (400, 401, 403, 404):
                break            # 这些重试也没用
        except Exception as e:  # 超时 / 断网
            last = e
    raise last if last else RuntimeError("LLM 调用失败")


def extract_json(text):
    """模型经常把 JSON 包在 ```json 里，或者前后加几句废话。"""
    if not text:
        return None
    s = text.strip()
    s = re.sub(r"^```(?:json)?\s*", "", s)
    s = re.sub(r"\s*```$", "", s)
    try:
        return json.loads(s)
    except Exception:
        pass
    i, j = s.find("{"), s.rfind("}")
    if i >= 0 and j > i:
        try:
            return json.loads(s[i:j + 1])
        except Exception:
            return None
    return None


SYSTEM = """你是一位视觉动效导演，负责给一支视频的"JS 动效叠加层"写文案和定调。
你只输出 JSON，不解释。文案要短、要硬、要像画面上的字，不要写句子。
规则：
- 所有字段必须存在，不能省。
- hooks 里每个词不超过 10 个字符（英文全大写），是砸在画面上的卡点大字。
- title 不超过 24 个字符，kicker / note 不超过 30 个字符。
- tickers.top / tickers.bottom 是跑马灯内容，用三个空格分隔词组。
- terminal 是终端面板的逐行内容，每行不超过 34 个字符，以 "> " 开头的行看起来最好。
- chapters 是 2~4 个章节短标（可以是纯数字 01/02，也可以是一个词）。
- style 必须从给定列表里挑一个。"""


def creative_brief(analysis, brief, styles, transcript=None, cfg=None, notes=""):
    """让模型产出文案与口味。任何异常都返回 None，由调用方退回规则文案。"""
    cfg = cfg or load_config()
    if not available(cfg):
        return None

    beat = analysis.get("beat") or {}
    shots = analysis.get("shots") or []
    speech = analysis.get("speech") or []
    tr_text = " ".join((s.get("text") or "").strip() for s in (transcript or []))
    tr_excerpt = tr_text[:1200]
    style_desc = "\n".join("  - %s：%s（%s）" % (k, v["name"], v["desc"]) for k, v in styles.items())

    user = """素材信息：
- 文件名：{name}
- 时长：{dur:.2f} 秒（只做这一段）
- 画面：{w}x{h} @{fps:.0f}fps，平均亮度 {bright:.2f}（{dark}），运动量 {motion:.3f}
- 镜头切点：{cuts} 个，每分钟 {cpm:.1f} 次
- 音乐：BPM {bpm:.1f}，拍点对齐度 {align:.0%}，共 {nbeats} 个拍点
- 检测到人声段：{nspeech} 处

用户给的要求（这是最重要的约束）：
- 配色风格：{style_req}
- 动效幅度 0~1：{intensity}
- 信息密度 0~1：{density}
- 额外要求：{notes}

可选配色（style 字段必须从这里挑一个）：
{style_desc}

语音转写节选（可能为空）：
\"\"\"{tr}\"\"\"

请输出这个 JSON：
{{
  "style": "上面列表里的一个 id",
  "title": "主标题（≤24字符）",
  "kicker": "标题上方小字",
  "note": "标题下方注解",
  "hooks": ["8 个卡点大字，按重要性排序"],
  "tickers": {{"top": "上跑马灯", "bottom": "下跑马灯"}},
  "terminal": ["6 行终端内容"],
  "chapters": ["2~4 个章节标"]
}}
语言跟随素材：中文素材就写中文，英文素材写英文，混就混。""".format(
        name=analysis.get("file", ""), dur=float(analysis.get("duration") or 0),
        w=analysis.get("width", 0), h=analysis.get("height", 0),
        fps=float(analysis.get("fps") or 0),
        bright=float(analysis.get("brightness") or 0),
        dark="偏暗" if analysis.get("dark") else "偏亮",
        motion=float(analysis.get("motionMean") or 0),
        cuts=len(shots), cpm=float(analysis.get("cutsPerMinute") or 0),
        bpm=float(beat.get("bpm") or 0), align=float(beat.get("align") or 0),
        nbeats=len(beat.get("beats") or []), nspeech=len(speech),
        style_req=brief.get("style", "auto"), intensity=brief.get("intensity"),
        density=brief.get("density"), notes=(notes or brief.get("notes") or "（无）"),
        style_desc=style_desc, tr=tr_excerpt,
    )

    try:
        raw = chat([{"role": "system", "content": SYSTEM},
                    {"role": "user", "content": user}], cfg=cfg,
                   temperature=0.75, json_mode=True)
    except Exception:
        return None
    data = extract_json(raw)
    return validate_creative(data, styles)


def validate_creative(data, styles):
    """模型输出必须过一遍体检：缺字段补默认、类型不对就丢、hooks 太长发就砍。"""
    if not isinstance(data, dict):
        return None
    out = {"source": "llm"}
    if data.get("style") in styles:
        out["style"] = data["style"]

    def s(key, n, default=""):
        v = data.get(key)
        if not isinstance(v, str) or not v.strip():
            v = default
        return v.strip()[:n]

    out["title"] = s("title", 24, "UNTITLED")
    out["kicker"] = s("kicker", 30)
    out["note"] = s("note", 30)

    hooks = data.get("hooks")
    if isinstance(hooks, list):
        hooks = [str(h).strip()[:10] for h in hooks if str(h).strip()]
    out["hooks"] = (hooks or [])[:10]

    tk = data.get("tickers") if isinstance(data.get("tickers"), dict) else {}
    out["tickers"] = {"top": str(tk.get("top") or "")[:160], "bottom": str(tk.get("bottom") or "")[:160]}

    term = data.get("terminal")
    if isinstance(term, list):
        term = [str(t).strip()[:34] for t in term if str(t).strip()]
    out["terminal"] = (term or [])[:6]

    ch = data.get("chapters")
    if isinstance(ch, list):
        ch = [str(c).strip()[:16] for c in ch if str(c).strip()]
    out["chapters"] = (ch or [])[:4]
    return out


def merge_creative(base, llm_part):
    """规则文案打底，LLM 的字段覆盖上去——缺一项也不会留空。"""
    if not llm_part:
        return base
    out = dict(base)
    for k, v in llm_part.items():
        if k == "source":
            continue
        if isinstance(v, dict):
            merged = dict(out.get(k) or {})
            for kk, vv in v.items():
                if vv:
                    merged[kk] = vv
            out[k] = merged
        elif isinstance(v, list):
            if v:
                out[k] = v
        elif v:
            out[k] = v
    out["source"] = "llm"
    return out
