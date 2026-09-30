// ============================================================================
// 把整个工程打包成一个单文件 HTML（dist/studio.html），双击就能用。
// 不依赖任何打包器：每个模块包进一个 IIFE 保住自己的作用域，
// import 变成从上一个模块的解构，export 变成返回对象的字段。
// 因为只处理自己写的、风格统一的代码，够用而且完全可读。
//
// 用法: npm run bundle
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'studio', 'studio.js');

const modules = [];        // 依赖序（先依赖后使用者）
const byPath = new Map();  // 绝对路径 -> 模块序号

const reImport = /^[ \t]*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?[ \t]*$/gm;

/** 把一个 import 子句改写成从 __modN 解构出来的语句 */
function importLines(clause, ref) {
  const lines = [];
  let rest = clause.trim();

  // 具名导入 { a, b as c } —— 一定要先处理大括号，
  // 否则按逗号切分会把 "{ clamp" 这种半截当成分片。
  const brace = rest.match(/\{([\s\S]*?)\}/);
  if (brace) {
    const inner = brace[1].split(',').map((s) => s.trim()).filter(Boolean)
      .map((s) => {
        const m = s.match(/^(\w+)\s+as\s+(\w+)$/);
        return m ? `${m[1]}: ${m[2]}` : s;
      }).join(', ');
    if (inner) lines.push(`const { ${inner} } = ${ref};`);
    rest = rest.replace(brace[0], ' ');
  }

  // 命名空间导入 * as NS
  const ns = rest.match(/\*\s+as\s+(\w+)/);
  if (ns) {
    lines.push(`const ${ns[1]} = ${ref};`);
    rest = rest.replace(ns[0], ' ');
  }

  // 默认导入
  const def = rest.replace(/,/g, ' ').trim();
  if (/^[A-Za-z_$][\w$]*$/.test(def) && def !== 'from') {
    lines.push(`const ${def} = ${ref}.default;`);
  }

  if (!lines.length) lines.push(`/* 未识别的 import: ${clause} */`);
  return lines.join('\n');
}

function collect(file) {
  const abs = path.resolve(file);
  if (byPath.has(abs)) return byPath.get(abs);

  let src = fs.readFileSync(abs, 'utf8');

  // 1) 先递归收集依赖（后序：依赖一定排在前面），并用占位符标记改写位置
  const pending = [];
  src = src.replace(reImport, (all, clause, spec) => {
    if (!spec.startsWith('.')) return `/* 外部依赖保持原样: ${spec} */`;
    const depIdx = collect(path.resolve(path.dirname(abs), spec));
    pending.push({ depIdx, clause });
    return `/*__IMP${pending.length - 1}__*/`;
  });

  const idx = modules.length;
  byPath.set(abs, idx);
  modules.push({ abs, rel: path.relative(ROOT, abs).replace(/\\/g, '/'), src: '' });

  // 2) 占位符 -> 解构语句
  src = src.replace(/\/\*__IMP(\d+)__\*\//g, (all, k) => {
    const p = pending[+k];
    return importLines(p.clause, `__mod${p.depIdx}`);
  });

  // 2) 收集导出名，去掉 export 关键字
  const exportNames = new Set();
  let hasDefault = false;

  // export { a, b as c };
  src = src.replace(/^[ \t]*export\s*\{([^}]*)\}\s*;?[ \t]*$/gm, (all, inner) => {
    inner.split(',').map((s) => s.trim()).filter(Boolean).forEach((s) => {
      const m = s.match(/^(\w+)\s+as\s+(\w+)$/);
      // export { 原名 as 对外名 }  ->  返回对象里写成 对外名: 原名
      exportNames.add(m ? `${m[2]}: ${m[1]}` : s);
    });
    return '';
  });

  // export default X
  src = src.replace(/^[ \t]*export\s+default\s+/gm, () => { hasDefault = true; return '__default = '; });

  // export const/let/var/function/class/async function
  src = src.replace(
    /^[ \t]*export\s+(async\s+function|function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
    (all, kind, name) => { exportNames.add(name); return all.replace(/export\s+/, ''); },
  );

  modules[idx].src = src;
  modules[idx].exports = [...exportNames];
  modules[idx].hasDefault = hasDefault;
  return idx;
}

collect(ENTRY);

// ---------------------------------------------------------------- 拼装
const parts = [];
modules.forEach((m, i) => {
  const lines = [`const __mod${i} = (() => {`, 'let __default = undefined;'];
  lines.push(m.src);
  const obj = m.exports.slice();
  if (m.hasDefault) obj.push('default: __default');
  lines.push(`return { ${obj.join(', ')} };`);
  lines.push('})();');
  parts.push(`// ===== ${m.rel} =====\n${lines.join('\n')}`);
});

const body = parts.join('\n\n');
const css = fs.readFileSync(path.join(ROOT, 'studio', 'studio.css'), 'utf8');

let html = fs.readFileSync(path.join(ROOT, 'studio', 'index.html'), 'utf8');
html = html.replace(/<link rel="stylesheet"[^>]*>/, () => `<style>\n${css}\n</style>`);

// 单文件版没有服务器，把预设连内容一起内联，file:// 下也能一键加载。
// 注意：必须排在主脚本 **前面**，因为 studio.js 初始化时就会读 window.__PRESETS__。
const presetsDir = path.join(ROOT, 'presets');
let presets = [];
try {
  const index = JSON.parse(fs.readFileSync(path.join(presetsDir, 'index.json'), 'utf8'));
  presets = index.map((it) => ({
    file: it.file,
    name: it.name,
    data: JSON.parse(fs.readFileSync(path.join(presetsDir, it.file), 'utf8')),
  }));
} catch (_) {}
html = html.replace(
  /<script type="module"[^>]*><\/script>/,
  () => `<script>window.__PRESETS__=${JSON.stringify(presets)};window.__MOTIONKIT_BUNDLED__=true;</script>\n<script>\n${body}\n</script>`,
);

fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
const outFile = path.join(ROOT, 'dist', 'studio.html');
fs.writeFileSync(outFile, html, 'utf8');
console.log(`打包完成 -> dist/studio.html  (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB, ${modules.length} 个模块)`);
