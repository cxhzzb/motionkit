// ============================================================================
// 把 50 个模板的参数定义导出成 agent/schema.json。
//
// 为什么要这一步：agent 是自动生成工程 JSON 的，如果它对参数名、取值范围只是
// "大概记得"，就会写出模板根本不认的键（静默失效）或者越界的值（渲染难看）。
// 让规划器读这份 schema 来对齐参数，比在提示词里叮嘱 LLM 靠谱得多。
//
// 用法： node tools/schema.mjs
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

// 模板模块只在 draw() 里碰 canvas，顶层不碰 DOM，所以这里能直接 import。
const { registerAll, listTemplates, CATEGORIES } = await import(
  url.pathToFileURL(path.join(ROOT, 'templates', 'index.js')).href
);
registerAll();

const templates = {};
for (const t of listTemplates()) {
  templates[t.id] = {
    id: t.id,
    name: t.name || t.id,
    category: t.category || 'other',
    categoryLabel: CATEGORIES[t.category] || t.category || '其他',
    desc: t.desc || t.description || '',
    params: (t.params || []).map((p) => {
      const o = { key: p.key, label: p.label || p.key, type: p.type || 'text', default: p.default };
      for (const k of ['min', 'max', 'step', 'options', 'rows']) if (p[k] !== undefined) o[k] = p[k];
      return o;
    }),
  };
}

const out = {
  generatedBy: 'tools/schema.mjs',
  count: Object.keys(templates).length,
  categories: CATEGORIES,
  templates,
};

const dest = path.join(ROOT, 'agent', 'schema.json');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out, null, 2) + '\n', 'utf8');

console.log(`模板 schema -> ${path.relative(ROOT, dest)}  (${out.count} 个模板)`);
for (const [id, t] of Object.entries(templates)) {
  console.log(`  ${id.padEnd(18)} ${String(t.params.length).padStart(2)} 个参数   ${t.name}`);
}
