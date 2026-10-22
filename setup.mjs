#!/usr/bin/env node
// setup.mjs — 安装识别引擎（sherpa-onnx）并自检
//
// 默认走标准 npm 安装：
//     npm install
//
// 如果你的机器上没有配置好 npm 源，也可以加 --from-dsh：从已安装的
// DeepSeek Harness 应用包里提取同一套引擎（仅 macOS + 已装 DSH 时可用）。
//
// 用法：
//   node setup.mjs              # npm install + 自检
//   node setup.mjs --from-dsh   # 从 DSH 应用包提取（离线可用）
//   node setup.mjs --check      # 只自检，不安装

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEST = path.join(__dirname, 'node_modules');
const PKGS = ['sherpa-onnx-node', 'sherpa-onnx-darwin-arm64'];

const argv = process.argv.slice(2);
const FROM_DSH = argv.includes('--from-dsh');
const CHECK_ONLY = argv.includes('--check');

const log = (...a) => console.log(...a);
const ok = (s) => log(`  ✓ ${s}`);
const bad = (s) => console.error(`  ✗ ${s}`);

function haveEngine() {
  return PKGS.every((p) => fs.existsSync(path.join(DEST, p, 'package.json')));
}

// ── 方式一：标准 npm 安装 ──────────────────────────────────────────────
function npmInstall() {
  log('用 npm 安装依赖…');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: __dirname,
    stdio: 'inherit',
  });
  if (r.error) {
    bad(`无法执行 npm：${r.error.message}`);
    return false;
  }
  if (r.status !== 0) {
    bad(`npm install 退出码 ${r.status}`);
    return false;
  }
  return haveEngine();
}

// ── 方式二：从 DeepSeek Harness 应用包里提取（离线/无 npm 时） ─────────
const ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';
const UNPACKED = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar.unpacked';

function openAsar() {
  const fd = fs.openSync(ASAR, 'r');
  const b = Buffer.alloc(16);
  fs.readSync(fd, b, 0, 16, 0);
  const hsize = b.readUInt32LE(12);
  const jb = Buffer.alloc(hsize);
  fs.readSync(fd, jb, 0, hsize, 16);
  // 数据区起点是 16 + hsize + 2（Electron asar 的对齐头）
  return { fd, header: JSON.parse(jb.toString('utf8')), base: 16 + hsize + 2 };
}

function extractPkg(fd, header, base, pkgName, destRoot) {
  const nm = header.files.dsh.files.node_modules.files;
  const node = nm[pkgName];
  if (!node) throw new Error(`asar 里找不到 ${pkgName}`);
  const outRoot = path.join(destRoot, pkgName);

  const walk = (n, rel) => {
    fs.mkdirSync(path.join(outRoot, rel), { recursive: true });
    for (const [k, v] of Object.entries(n.files || {})) {
      const np = path.join(rel, k);
      if (v.files) { walk(v, np); continue; }
      if (v.link !== undefined) continue;      // 符号链接跳过
      if (v.unpacked) continue;                 // 原生二进制在 .unpacked，另行复制
      const buf = Buffer.alloc(v.size);
      fs.readSync(fd, buf, 0, v.size, base + parseInt(v.offset));
      fs.writeFileSync(path.join(outRoot, np), buf);
    }
  };
  walk(node, '');
  return outRoot;
}

function fromDsh() {
  if (!fs.existsSync(ASAR)) {
    bad(`找不到 DSH 安装：${ASAR}`);
    return false;
  }
  fs.mkdirSync(DEST, { recursive: true });
  const { fd, header, base } = openAsar();
  log('从 DSH 安装中提取 sherpa-onnx 引擎…');
  const sherpaDir = extractPkg(fd, header, base, 'sherpa-onnx-node', DEST);
  const platDir = extractPkg(fd, header, base, 'sherpa-onnx-darwin-arm64', DEST);
  fs.closeSync(fd);
  ok('sherpa-onnx-node');
  ok('sherpa-onnx-darwin-arm64');

  // 原生 addon 与它依赖的 dylib 都是 unpacked 的，直接从磁盘复制。
  // 关键：这些 dylib 通过 @rpath = @loader_path 查找，必须与 .node 同目录。
  const unpackedPlat = path.join(UNPACKED, 'dsh/node_modules/sherpa-onnx-darwin-arm64');
  let nNative = 0;
  for (const f of fs.readdirSync(unpackedPlat)) {
    if (!/\.(node|dylib)$/.test(f)) continue;
    const dst = path.join(platDir, f);
    fs.copyFileSync(path.join(unpackedPlat, f), dst);
    fs.chmodSync(dst, 0o755);
    ok(f);
    nNative++;
  }
  if (!nNative) {
    bad(`在 ${unpackedPlat} 里没找到 .node/.dylib`);
    return false;
  }

  // addon.js 会在 <pkg>/node_modules/ 下找平台包，补一个
  const nested = path.join(sherpaDir, 'node_modules');
  fs.mkdirSync(nested, { recursive: true });
  const nestedLink = path.join(nested, 'sherpa-onnx-darwin-arm64');
  try { fs.rmSync(nestedLink, { recursive: true, force: true }); } catch {}
  fs.cpSync(platDir, nestedLink, { recursive: true });
  ok('平台包目录');
  return haveEngine();
}

// ── 自检 ───────────────────────────────────────────────────────────────
function selfCheck() {
  log('自检：加载识别引擎…');
  try {
    const out = execFileSync(process.execPath, ['-e',
      `const s=require('sherpa-onnx-node');console.log('ONNX Runtime',s.onnxruntimeVersion,'| sherpa',s.version);`,
    ], { cwd: __dirname, encoding: 'utf8', timeout: 60000 });
    ok(out.trim());
    return true;
  } catch (e) {
    bad('引擎加载失败：' + (e.stderr || e.message).toString().split('\n')[0]);
    return false;
  }
}

// ── 主流程 ─────────────────────────────────────────────────────────────
function main() {
  if (CHECK_ONLY) {
    process.exit(selfCheck() ? 0 : 1);
  }

  if (!haveEngine()) {
    let done = false;
    if (FROM_DSH) {
      done = fromDsh();
    } else {
      done = npmInstall();
      if (!done && fs.existsSync(ASAR)) {
        log('');
        log('npm 安装失败，尝试从本地 DSH 应用包提取…');
        done = fromDsh();
      }
    }
    if (!done) {
      bad('依赖安装失败。请手动执行：');
      log('    npm install');
      log('  或（已装 DeepSeek Harness 的 macOS）：');
      log('    node setup.mjs --from-dsh');
      process.exit(1);
    }
  } else {
    ok('依赖已存在，跳过安装');
  }

  if (!selfCheck()) process.exit(1);

  log('');
  log('识别引擎就绪。下一步：');
  log('  1) 下载模型：        node setup-model.mjs');
  log('  2) 编译麦克风工具：  swiftc -O mic2pcm.swift -o mic2pcm');
  log('  3) 启动：            node captioner.mjs');
}

main();
