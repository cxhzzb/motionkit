#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把抽帧拼成一张对照图（做 UI 预览图用）。

  python tools/sheet.py --frames .out/long/frame_00.png .out/long/frame_05.png --out docs/preview.png
  python tools/sheet.py --pattern ".out/long/frame_*.png" --step 5 --cols 3 --out docs/preview.png

每格左上角会烧上文件名（时间），方便对着时间轴找问题。
"""

import argparse
import glob
import os

from PIL import Image, ImageDraw


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames", nargs="*", default=[])
    ap.add_argument("--pattern", default="")
    ap.add_argument("--step", type=int, default=1, help="从排序后的帧里每 N 张取一张")
    ap.add_argument("--cols", type=int, default=3)
    ap.add_argument("--tile", type=int, default=616, help="每格宽度")
    ap.add_argument("--label-step", type=float, default=0, help="文件名里的帧号按这个秒数换算成时间码标签")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    files = list(a.frames)
    if a.pattern:
        files = sorted(glob.glob(a.pattern))[:: max(1, a.step)]
    if not files:
        raise SystemExit("没有找到帧")

    tiles = []
    for f in files:
        im = Image.open(f).convert("RGB")
        tw = a.tile
        th = max(1, round(im.height * tw / im.width))
        im = im.resize((tw, th), Image.LANCZOS)
        d = ImageDraw.Draw(im)
        tag = os.path.splitext(os.path.basename(f))[0]
        if a.label_step > 0:
            digits = "".join(ch for ch in tag if ch.isdigit())
            if digits:
                sec = int(digits) * a.label_step
                tag = "%d:%02d" % (sec // 60, sec % 60)
        d.rectangle([0, 0, 9 + len(tag) * 8, 20], fill=(0, 0, 0))
        d.text((6, 5), tag, fill=(255, 255, 255))
        tiles.append(im)

    cols = max(1, a.cols)
    rows = (len(tiles) + cols - 1) // cols
    th = tiles[0].height
    sheet = Image.new("RGB", (cols * a.tile, rows * th), (10, 10, 12))
    for i, im in enumerate(tiles):
        sheet.paste(im, ((i % cols) * a.tile, (i // cols) * th))
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    sheet.save(a.out)
    print("拼图 -> %s   %d 格 / %d 列" % (a.out, len(tiles), cols))


if __name__ == "__main__":
    main()
