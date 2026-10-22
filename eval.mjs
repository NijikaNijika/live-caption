#!/usr/bin/env node
// eval.mjs — 切段质量评测：把分段识别的结果与已知原文比对
//
// 为什么需要它：切段策略的改动很容易"看起来更好"，但没法判断到底有没有进步。
// 这里用词错误率（WER）把质量变成数字，并单独跟踪冠词丢失——
// 因为句子被拦腰切断时，丢失的往往正是 the/a/an 这类词（实测教训：
// "Cities divide their territory into residential" 丢了主语，
//  "and industrial zones" 反而把 the 丢了）。
//
// 用法：
//   node eval.mjs transcript.jsonl ground-truth.txt

import fs from 'node:fs';

const [transcriptPath, truthPath] = process.argv.slice(2);
if (!transcriptPath || !truthPath) {
  console.error('用法: node eval.mjs transcript.jsonl ground-truth.txt');
  process.exit(1);
}

const norm = (s) => s.toLowerCase()
  .replace(/[^a-z0-9'\s]/g, ' ')     // 去标点
  .replace(/\s+/g, ' ')
  .trim();

const tokenize = (s) => norm(s).split(' ').filter(Boolean);

// 词级编辑距离（Levenshtein），带回溯以找出具体是哪些词被吞/被加
function align(ref, hyp) {
  const n = ref.length, m = hyp.length;
  const d = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) d[i][0] = i;
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,                                    // 删（漏识别）
        d[i][j - 1] + 1,                                    // 插（多识别）
        d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1), // 替换
      );
    }
  }
  // 回溯，收集错误类型
  const errors = { del: [], ins: [], sub: [] };
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && ref[i - 1] === hyp[j - 1] && d[i][j] === d[i - 1][j - 1]) { i--; j--; continue; }
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + 1) { errors.sub.push([ref[i - 1], hyp[j - 1]]); i--; j--; continue; }
    if (i > 0 && d[i][j] === d[i - 1][j] + 1) { errors.del.push(ref[i - 1]); i--; continue; }
    errors.ins.push(hyp[j - 1]); j--;
  }
  return { distance: d[n][m], errors };
}

const rows = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n')
  .filter(Boolean).map(l => JSON.parse(l));
const hypothesis = rows.map(r => r.en).join(' ');
const reference = fs.readFileSync(truthPath, 'utf8').trim();

const ref = tokenize(reference);
const hyp = tokenize(hypothesis);
const { distance, errors } = align(ref, hyp);

const pct = (x) => (x * 100).toFixed(1) + '%';

console.log('══════ 切段质量评测 ══════');
console.log(`原文词数      : ${ref.length}`);
console.log(`识别词数      : ${hyp.length}`);
console.log(`词错误率 WER  : ${pct(distance / ref.length)}  (${distance} 处错误)`);
console.log(`  漏识别      : ${errors.del.length}`);
console.log(`  多识别      : ${errors.ins.length}`);
console.log(`  识别错      : ${errors.sub.length}`);

// 冠词存活率：句子被切断的敏感指标
const articles = ref.filter(w => ['the', 'a', 'an'].includes(w));
const hypSet = [...hyp];
let survived = 0;
for (const a of articles) {
  const idx = hypSet.indexOf(a);
  if (idx >= 0) { survived++; hypSet.splice(idx, 1); }
}
console.log(`\n冠词存活率    : ${articles.length ? pct(survived / articles.length) : 'n/a'}  (${survived}/${articles.length})`);
console.log('  （句子被拦腰切断时，最先丢的就是 the/a/an）');

if (errors.del.length) {
  console.log(`\n漏掉的词      : ${errors.del.slice(0, 20).join(', ')}${errors.del.length > 20 ? ' …' : ''}`);
}
if (errors.sub.length) {
  console.log(`识别错的词    : ${errors.sub.slice(0, 12).map(([a, b]) => `${a}→${b}`).join(', ')}`);
}

// 段落切分统计
console.log('\n══════ 分段情况 ══════');
const evPath = transcriptPath.replace(/\.jsonl$/, '').replace('transcript', 'events') + '.jsonl';
try {
  const evs = fs.readFileSync(evPath, 'utf8').trim().split('\n').filter(Boolean)
    .map(l => JSON.parse(l)).filter(e => e.name === 'finalize');
  const byReason = {};
  for (const e of evs) byReason[e.reason] = (byReason[e.reason] || 0) + 1;
  for (const [k, v] of Object.entries(byReason)) console.log(`  ${k.padEnd(14)}: ${v} 次`);
  const lats = evs.map(e => e.latencyMs).filter(Boolean);
  if (lats.length) {
    lats.sort((a, b) => a - b);
    console.log(`  端到端延迟    : 中位 ${lats[Math.floor(lats.length / 2)]}ms / 最大 ${lats[lats.length - 1]}ms`);
  }
} catch (e) {
  console.log('  （没有 events.jsonl，跳过）');
}

console.log(`\n分段英语全文（检查是否连贯）:\n${rows.map((r, i) => `  [${i + 1}] ${r.en}`).join('\n')}`);
