// ============================================================================
// 排版类模板（补充）：幽灵水印框
// 和 type-stack 那种"砸下来的压扁大字"是两个路子：
// 这个是低不透明度的描边水印 + 四角括号 + 一枚方向箭头，压在实拍上像档案素材。
// ============================================================================

import { text, label, measure, cornerTicks, ui, palette, FONTS } from '../engine/draw.js';
import { TAU, clamp, easeOutCubic } from '../engine/core.js';
import { envelope, color, trng, fakeCode, P } from './_lib.js';

export const ghostMark = {
  id: 'ghost-mark',
  name: '幽灵水印',
  category: 'typography',
  hint: '半透明描边大字水印 + 四角括号 + 方向箭头；默认墨黑（压在浅色素材上），深色素材把颜色改成白色。',
  params: [
    { key: 'text', label: '文字', type: 'string', default: 'ARCHIVE' },
    { key: 'position', label: '位置 x,y', type: 'string', default: '0.5,0.5' },
    { key: 'size', label: '字号', type: 'number', default: 190, min: 24, max: 700, step: 2 },
    { key: 'opacity', label: '不透明度', type: 'number', default: 0.3, min: 0.03, max: 1, step: 0.02 },
    { key: 'rotate', label: '倾斜角度', type: 'number', default: -8, min: -45, max: 45, step: 1 },
    { key: 'tracking', label: '字距', type: 'number', default: 0.06, min: -0.05, max: 0.6, step: 0.01 },
    { key: 'frame', label: '四角括号', type: 'bool', default: true },
    { key: 'arrow', label: '方向箭头', type: 'bool', default: true },
    { key: 'plate', label: '角标底色', type: 'bool', default: true },
    { key: 'caption', label: '右下小字', type: 'string', default: 'SOURCE MATERIAL · NOT FOR BROADCAST' },
    { key: 'hold', label: '常驻（不进退场）', type: 'bool', default: false },
    { key: 'color', label: '颜色', type: 'color', default: 'ink' },
    P.accent('orange'),
  ],

  draw(ctx, env) {
    const { width: w, height: h, params: p, t } = env;
    const a = p.hold ? 1 : envelope(env.progress, { inFrac: 0.1, outFrac: 0.12 });
    if (a <= 0.001) return;
    const ink = color(p.color, ui.paper);
    const acc = color(p.accent, palette.orange);
    const rng = trng(env, 'ghost');
    const parts = String(p.position || '').split(',').map((s) => Number(String(s).trim()));
    const cx = w * (Number.isFinite(parts[0]) ? parts[0] : 0.5);
    const cy = h * (Number.isFinite(parts[1]) ? parts[1] : 0.5);
    const size = p.size;
    const alpha = clamp(p.opacity, 0, 1) * a;
    // 入场时描边先"划"出来，再落到目标透明度
    const reveal = easeOutCubic(clamp(env.local / 0.7, 0, 1));
    const str = String(p.text || '').toUpperCase();

    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.translate(cx, cy);
    ctx.rotate((p.rotate * Math.PI) / 180);

    const tw = measure(ctx, str, { font: FONTS.condensed, size, weight: 700, tracking: size * p.tracking });
    const th = size;

    // 描边大字：只描边不填充，才有水印那味
    ctx.save();
    ctx.beginPath();
    // 从左往右擦出：用一个矩形裁剪当"划入"
    ctx.rect(-tw / 2 - size * 0.1, -th, (tw + size * 0.2) * reveal, th * 2);
    ctx.clip();
    text(ctx, str, 0, 0, {
      font: FONTS.condensed, size, weight: 700, align: 'center', baseline: 'middle',
      tracking: size * p.tracking, color: 'rgba(255,255,255,0.001)',
      stroke: ink, strokeWidth: Math.max(1.5, size * 0.012),
    });
    ctx.restore();

    // 四角括号贴着文字外框
    if (p.frame) {
      const pad = size * 0.34;
      const fw = tw + pad * 2;
      const fh = th + pad * 1.3;
      cornerTicks(ctx, -fw / 2, -fh / 2, fw, fh, {
        len: Math.min(46, size * 0.22), color: ink, width: Math.max(1, size * 0.008), alpha: 0.85,
      });
    }

    // 方向箭头（左上角外沿，朝左下指的"这一段从这里来"那种记号）
    if (p.arrow) {
      const ax = -tw / 2 - size * 0.62;
      const ay = 0;
      const len = size * 0.3;
      ctx.save();
      ctx.strokeStyle = acc;
      ctx.lineWidth = Math.max(2, size * 0.012);
      ctx.beginPath();
      ctx.moveTo(ax, ay - len); ctx.lineTo(ax, ay + len); ctx.lineTo(ax + len * 0.62, ay + len * 0.3);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(ax, ay - len, Math.max(2, size * 0.018), 0, TAU);
      ctx.fillStyle = acc;
      ctx.fill();
      ctx.restore();
    }

    // 角标：左上 KEY、右下 caption
    if (p.plate) {
      const key = `${fakeCode(rng, 3)}-${String(Math.round(t * 10) % 1000).padStart(3, '0')}`;
      const ky = -th / 2 - size * 0.9;
      ctx.fillStyle = 'rgba(0,0,0,0.62)';
      ctx.fillRect(-tw / 2 - size * 0.1, ky - 4, measure(ctx, key, { font: FONTS.mono, size: Math.max(11, size * 0.075), tracking: 1.4 }) + 16, Math.max(18, size * 0.13));
      label(ctx, key, -tw / 2, ky, { size: Math.max(11, size * 0.075), color: acc });
    }
    if (p.caption) {
      const cs = Math.max(11, size * 0.075);
      label(ctx, String(p.caption).toUpperCase(), tw / 2, th / 2 + size * 0.72, {
        size: cs, color: 'rgba(255,255,255,0.66)', align: 'right',
      });
    }

    ctx.restore();
  },
};

export default [ghostMark];
