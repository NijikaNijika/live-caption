#!/usr/bin/env node
// setup-model.mjs — 下载两套本地识别模型
//
//   1) streaming-zipformer-bilingual（约 198MB）
//      流式模型，负责"边说边出字"的屏幕预览；
//   2) SenseVoice（约 239MB）
//      离线整段模型，负责产出最终正文（准确率更高，中英混说自动判语言）。
//
// 用法：
//   node setup-model.mjs                 # 两个都下
//   node setup-model.mjs --only=streaming
//   node setup-model.mjs --only=sensevoice
//
// 模型都放在 ./models 下，已被 .gitignore 排除，不会进仓库。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const onlyArg = (argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || '';
const only = onlyArg.trim();

// 优先 huggingface.co，失败回退 hf-mirror.com（国内网络）
const MIRRORS = [
  (repo, f) => `https://huggingface.co/${repo}/resolve/main/${f}`,
  (repo, f) => `https://hf-mirror.com/${repo}/resolve/main/${f}`,
];

const JOBS = [
  {
    key: 'streaming',
    label: '流式识别模型（中英双语 zipformer int8）',
    dir: path.join(__dirname, 'models/streaming-zipformer-bilingual'),
    repo: 'csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20',
    files: [
      ['encoder-epoch-99-avg-1.int8.onnx', 181895032],
      ['decoder-epoch-99-avg-1.int8.onnx', 13091040],
      ['joiner-epoch-99-avg-1.int8.onnx', 3228404],
      ['tokens.txt', 56317],
      ['bpe.model', 244836],
    ],
  },
  {
    key: 'sensevoice',
    label: '离线识别模型（SenseVoice，中英日韩粤）',
    dir: path.join(__dirname, 'models/sensevoice'),
    repo: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    files: [
      ['model.int8.onnx', 239233841],
      ['tokens.txt', 315894],
    ],
  },
];

const fmt = (b) => (b > 1e6 ? (b / 1e6).toFixed(1) + 'MB' : (b / 1e3).toFixed(0) + 'KB');

async function download(repo, file, dest, expectBytes) {
  if (fs.existsSync(dest) && fs.statSync(dest).size === expectBytes) {
    console.log(`  ✓ ${file} 已存在（${fmt(expectBytes)}）`);
    return true;
  }
  for (const mk of MIRRORS) {
    const url = mk(repo, file);
    const host = new URL(url).host;
    try {
      process.stdout.write(`  ↓ ${file} ← ${host} … `);
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length !== expectBytes) throw new Error(`大小不符：${buf.length} != ${expectBytes}`);
      fs.writeFileSync(dest, buf);
      console.log(`完成（${fmt(buf.length)}）`);
      return true;
    } catch (e) {
      console.log(`失败：${e.message}`);
    }
  }
  return false;
}

async function runJob(job) {
  console.log(`\n【${job.label}】→ ${path.relative(__dirname, job.dir)}`);
  fs.mkdirSync(job.dir, { recursive: true });
  for (const [f, size] of job.files) {
    const okFile = await download(job.repo, f, path.join(job.dir, f), size);
    if (!okFile) {
      console.error(`\n✗ ${f} 下载失败。`);
      console.error(`  可手动从 https://huggingface.co/${job.repo} 下载后放入 ${job.dir}`);
      return false;
    }
  }
  return true;
}

async function main() {
  const jobs = only ? JOBS.filter((j) => j.key === only) : JOBS;
  if (only && !jobs.length) {
    console.error(`未知的 --only=${only}，可选：${JOBS.map((j) => j.key).join(' / ')}`);
    process.exit(1);
  }

  console.log('开始准备模型（只需一次，合计约 440MB）');
  for (const job of jobs) {
    if (!(await runJob(job))) process.exit(1);
  }
  console.log('\n模型就绪。');
}

main().catch((e) => { console.error('失败:', e.message); process.exit(1); });
