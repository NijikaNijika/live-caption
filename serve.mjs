#!/usr/bin/env node
// serve.mjs — 提供字幕页面的本地服务器
//
// 为什么需要它：字幕页面用 fetch 读 live.json。如果直接用 file:// 打开，
// 浏览器会因为同源策略拒绝这次请求（file:// 的 origin 是 null），
// 页面会一直卡在"等待数据"。走 127.0.0.1 就没有这个问题。
//
// 用法：node serve.mjs         然后浏览器打开 http://127.0.0.1:8790/
//       node serve.mjs 9000    换端口

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || 8790);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/subtitles.html';

  // ?snapshot=1 ：把当前字幕数据直接内联进 HTML 一起返回。
  // 用途：无头浏览器截图、存档一份完整可看的字幕，不依赖后续 fetch。
  const snapshot = url.searchParams.get('snapshot') === '1';

  // 只允许读本目录下的文件，防目录穿越
  const full = path.join(__dirname, rel);
  if (!full.startsWith(__dirname)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      // live.json 还没生成时给出明确提示，而不是 404 空白页
      if (rel === '/live.json') {
        res.writeHead(200, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ updated: 0, live: null, lines: [] }));
        return;
      }
      res.writeHead(404).end('not found: ' + rel);
      return;
    }
    let body = data;
    if (snapshot && rel === '/subtitles.html') {
      let snap = { updated: 0, live: null, lines: [] };
      try { snap = JSON.parse(fs.readFileSync(path.join(__dirname, 'live.json'), 'utf8')); } catch {}
      const inject = `<script>window.__SNAPSHOT__=${JSON.stringify(snap)};</script>`;
      body = Buffer.from(data.toString('utf8').replace('</head>', inject + '\n</head>'));
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`字幕页面: http://127.0.0.1:${PORT}/`);
  console.log('（保持这个进程运行，另开一个终端跑 captioner.mjs）');
  console.log('Ctrl-C 停止。');
});
