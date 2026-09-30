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

export const ALL = [...hud, ...type, ...panels, ...transitions, ...hits];

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
