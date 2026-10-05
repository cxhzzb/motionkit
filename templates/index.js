// ============================================================================
// 模板注册中心
// 新模板：写一个 draw(ctx, env) 的文件，在下面 import 并塞进 ALL 即可。
// ============================================================================

import { registerTemplate, listTemplates, registry } from '../engine/core.js';
import hud from './hud.js';
import type from './type.js';
import panels from './panels.js';
import transitions from './transitions.js';
import hits from './hits.js';
import design from './design.js';
import rock from './rock.js';
import focus from './focus.js';
import data from './data.js';
import mark from './mark.js';
import chaos from './chaos.js';
import grid2 from './grid2.js';
import spectrum from './spectrum.js';
import typography2 from './typography2.js';

// 顺序 = 模板库里的分组顺序：叠加层 → 动态排版 → 设计排版 → 面板卡片 → 转场
// 顺序 = 模板库里的分组顺序
export const ALL = [...hud, ...spectrum, ...type, ...typography2, ...design, ...chaos, ...grid2, ...data, ...focus, ...mark, ...rock, ...panels, ...transitions, ...hits];

let registered = false;
export function registerAll(force = false) {
  if (registered && !force) return ALL;
  for (const t of ALL) registerTemplate(t);
  registered = true;
  return ALL;
}

/** 分类中文名 */
export const CATEGORIES = {
  overlay: '叠加层 / HUD',
  typography: '动态排版',
  caption: '字幕',
  panel: '面板卡片',
  design: '设计排版',
  focus: '聚焦 / 标注',
  data: '数据 / 图表',
  chaos: '秩序 / 混沌',
  rock: '摇滚 / 海报',
  transition: '转场 / 冲击',
};

export function byCategory() {
  const out = {};
  for (const t of listTemplates()) {
    const c = t.category || 'other';
    (out[c] = out[c] || []).push(t);
  }
  return out;
}

registerAll();

export { listTemplates, registry };
