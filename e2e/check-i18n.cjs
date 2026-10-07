#!/usr/bin/env node
/*
 * i18n integrity check for OmniSense.
 *
 *   1. every data-i18n key used in HTML exists in zh.json and en.json
 *   2. every literal t('key') used in JS exists in zh.json and en.json
 *   3. zh and en have exactly the same key set (no asymmetric translations)
 *   4. no CJK characters leak into en.json values
 *      (language-picker endonyms such as "中文" are intentional and exempt)
 *   5. a data-i18n target whose dictionary value contains {{placeholders}} must
 *      supply a matching data-i18n-<name> attribute, otherwise the UI renders
 *      the literal braces (this shipped once: "本次已拦截：{{requests}} 个请求")
 *   6. no hard-coded CJK string in JS or in HTML outside the i18n mechanism —
 *      the class of leak that has been reported repeatedly in the English locale
 *   7. informational list of unused keys
 *
 * Usage: node e2e/check-i18n.cjs
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const zh = JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n/zh.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n/en.json'), 'utf8'));

// Language names are shown in their own language inside language pickers, so
// these keys legitimately carry CJK text even in the English dictionary.
const ENDONYM_KEYS = /\.lang_(zh|ja|ko)$/;

// Files whose Chinese text is a *prompt sent to the local model*, not UI copy.
const JS_CJK_ALLOW_FILES = new Set(['offscreen.js']);

const problems = [];
const note = m => console.log('  ' + m);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'vendor' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(ROOT).filter(f => !f.includes(`${path.sep}e2e${path.sep}`));
const htmlFiles = files.filter(f => f.endsWith('.html'));
const jsFiles = files.filter(f => f.endsWith('.js'));

// ---- 1 + 2 gather used keys
const used = new Map(); // key -> Set(source)
const addUse = (key, src) => {
  if (!key) return;
  if (!used.has(key)) used.set(key, new Set());
  used.get(key).add(src);
};

for (const f of htmlFiles) {
  const s = fs.readFileSync(f, 'utf8');
  // Only `data-i18n="KEY"` carries a key; `data-i18n-attr` names an attribute
  // and the other `data-i18n-*` variants carry placeholder argument values.
  for (const m of s.matchAll(/\bdata-i18n="([^"]+)"/g)) addUse(m[1], path.relative(ROOT, f));
}

for (const f of jsFiles) {
  const s = fs.readFileSync(f, 'utf8');
  for (const m of s.matchAll(/\bt\(\s*['"`]([a-zA-Z0-9_.]+)['"`]/g)) addUse(m[1], path.relative(ROOT, f));
  // Keys reached indirectly, e.g. `t(s.labelKey)` where the table entry declares
  // `labelKey: 'tone.style.luxun'`. Without this the unused-key report is noise.
  for (const m of s.matchAll(/labelKey:\s*['"`]([a-zA-Z0-9_.]+)['"`]/g)) addUse(m[1], path.relative(ROOT, f));
}

// ---- checks
const zhKeys = new Set(Object.keys(zh));
const enKeys = new Set(Object.keys(en));

console.log(`dictionaries: zh=${zhKeys.size} keys, en=${enKeys.size} keys`);
console.log(`referenced:   ${used.size} distinct keys\n`);

const missingZh = [], missingEn = [];
for (const [key, srcs] of used) {
  if (!zhKeys.has(key)) missingZh.push(`${key}  (used in ${[...srcs].join(', ')})`);
  if (!enKeys.has(key)) missingEn.push(`${key}  (used in ${[...srcs].join(', ')})`);
}
if (missingZh.length) { problems.push(`missing in zh.json (${missingZh.length})`); missingZh.forEach(note); }
if (missingEn.length) { problems.push(`missing in en.json (${missingEn.length})`); missingEn.forEach(note); }
if (missingZh.length || missingEn.length) console.log('');

const onlyZh = [...zhKeys].filter(k => !enKeys.has(k));
const onlyEn = [...enKeys].filter(k => !zhKeys.has(k));
if (onlyZh.length) { problems.push(`only in zh.json (${onlyZh.length})`); onlyZh.forEach(note); }
if (onlyEn.length) { problems.push(`only in en.json (${onlyEn.length})`); onlyEn.forEach(note); }
if (onlyZh.length || onlyEn.length) console.log('');

const cjk = [];
for (const [k, v] of Object.entries(en)) {
  if (ENDONYM_KEYS.test(k)) continue;
  if (/[\u4e00-\u9fff]/.test(String(v))) cjk.push(`${k} = ${v}`);
}
if (cjk.length) { problems.push(`CJK leaking into en.json (${cjk.length})`); cjk.forEach(note); }
if (cjk.length) console.log('');

const endonyms = Object.keys(en).filter(k => ENDONYM_KEYS.test(k));
if (endonyms.length) {
  console.log(`exempt endonym keys (${endonyms.length}): ${endonyms.join(', ')}\n`);
}

// ---- 5 placeholder arguments actually supplied in HTML
const placeholderProblems = [];
for (const f of htmlFiles) {
  const src = fs.readFileSync(f, 'utf8');
  const tagRe = /<[a-zA-Z0-9]+([^>]*\bdata-i18n="([^"]+)"[^>]*)>/g;
  for (const m of src.matchAll(tagRe)) {
    const attrs = m[1], key = m[2];
    const value = zh[key];
    if (typeof value !== 'string') continue;
    const needed = [...value.matchAll(/\{\{(\w+)\}\}/g)].map(x => x[1]);
    if (!needed.length) continue;
    const supplied = new Set([...attrs.matchAll(/data-i18n-([\w-]+)=/g)].map(x => x[1]));
    const missing = needed.filter(n => !supplied.has(n));
    if (missing.length) {
      placeholderProblems.push(`${path.relative(ROOT, f)}: data-i18n="${key}" needs data-i18n-${missing.join('/')}`);
    }
  }
}
if (placeholderProblems.length) {
  problems.push(`data-i18n targets that would render literal {{braces}} (${placeholderProblems.length})`);
  placeholderProblems.forEach(note);
  console.log('');
}

// ---- 6 hard-coded CJK outside the i18n mechanism
const CJK = /[\u4e00-\u9fff]/;
const cjkLeaks = [];
for (const f of [...jsFiles, ...htmlFiles]) {
  const rel = path.relative(ROOT, f);
  const base = path.basename(f);
  if (JS_CJK_ALLOW_FILES.has(base)) continue;
  if (rel.startsWith('i18n' + path.sep)) continue;
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  // Comments are exempt (they are not UI copy), and an HTML comment may span
  // several lines. Tracking the block state is required: only checking each
  // line's own prefix flagged the middle of a multi-line `<!-- ... -->` as a
  // leak, which is a false positive that trains people to ignore this check.
  let inHtmlComment = false;
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (inHtmlComment) {
      if (trimmed.includes('-->')) inHtmlComment = false;
      return;
    }
    if (trimmed.startsWith('<!--')) {
      if (!trimmed.includes('-->')) inHtmlComment = true;
      return;
    }
    if (!CJK.test(line)) return;
    if (/^(\/\/|\*|\/\*)/.test(trimmed)) return;                   // comment
    if (trimmed.includes('i18n-allow-cjk')) return;                // explicit exemption
    if (f.endsWith('.html') && trimmed.includes('data-i18n')) return; // i18n fallback copy
    cjkLeaks.push(`${rel}:${i + 1}: ${trimmed.slice(0, 110)}`);
  });
}
if (cjkLeaks.length) {
  problems.push(`hard-coded CJK outside the i18n mechanism (${cjkLeaks.length})`);
  cjkLeaks.forEach(note);
  console.log('');
}

const unused = [...zhKeys].filter(k => !used.has(k));

console.log(`unused keys (informational, ${unused.length}):`);
unused.slice(0, 40).forEach(note);
if (unused.length > 40) note(`... and ${unused.length - 40} more`);

console.log('');
if (problems.length) {
  console.log(`FAIL — ${problems.length} problem group(s):`);
  problems.forEach(p => console.log(`  - ${p}`));
  process.exit(1);
}
console.log('PASS — i18n dictionaries are consistent, complete for every referenced key, and CJK-free in en.json');
