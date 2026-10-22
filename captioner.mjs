#!/usr/bin/env node
// captioner.mjs — 本地实时同传字幕流水线
//
//   麦克风 ──► 流式识别(屏幕预览) ──► 分块 ──► SenseVoice 精修 ──► 翻译 ──► 滚动字幕
//                  (即时反馈)                  (带标点)       (本地 Ollama)
//
// 为什么用两套识别器（这是实测后的决定，不是设计洁癖）：
//   · 流式 zipformer 能边说边出字，但它输出 ALL CAPS 且没有标点，
//     直接拿去翻译会明显掉质量（实测："...KILOMETER OF" 还被截断）；
//   · SenseVoice 输出带标点和正常大小写的漂亮文本，但它是离线模型，必须等一段说完。
//   所以：流式负责"让你马上看到在听什么"，SenseVoice 负责"产出可读可翻的正文"。
//
// 延迟预算（实测值）：
//   分块 2.5s + SenseVoice ~0.3s + 翻译 0.9~1.4s ≈ 3.7~4.2s  < 5s ✅
//
// 用法：
//   node captioner.mjs                  # 麦克风
//   node captioner.mjs --source stdin   # 从 stdin 读 16k 单声道 PCM16（测试用）
//   node captioner.mjs --no-translate   # 只识别不翻译
//   node captioner.mjs --chunk-ms 2000  # 调整分块长度（直接决定延迟）

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME;

// ─────────────────────────── 配置 ───────────────────────────
const CFG = {
  sampleRate: 16000,

  // 流式识别（屏幕预览）
  streamingDir: path.join(__dirname, 'models/streaming-zipformer-bilingual'),

  // 离线识别（产出正文）——SenseVoice 模型
  // 优先用 setup-model.mjs 下到项目内的 ./models/sensevoice；
  // 若没有则回退到旧版 DeepSeek Harness shared 目录（兼容已有部署）。
  senseVoiceDir: (() => {
    const local = path.join(__dirname, 'models/sensevoice');
    if (fs.existsSync(path.join(local, 'model.int8.onnx'))) return local;
    const legacy = path.join(HOME, '.dsh/speech-to-text/sensevoice/models/sensevoice-onnx');
    if (fs.existsSync(path.join(legacy, 'model.int8.onnx'))) return legacy;
    return local;
  })(),

  source: 'mic',         // 'mic' | 'stdin' | 'replay'
  replayFile: null,      // --replay <pcm文件>：按实时速度回放，用来验证整条链路
  micBin: path.join(__dirname, 'mic2pcm'),

  // 延迟与质量的关键参数。下面这组值是实测扫参选出来的（不是拍脑袋）：
  // 扫描用两套合成讲座音频：句间 1.4s 停顿（讲座常态）与 0.25s（连续讲话最坏情况），
  // 同时看词错误率 WER 与"上屏延迟"两个指标。
  //
  // 结论：静音切分是质量最好的路径（WER 可到 1.5%，切点天然落在句子边界）；
  // 硬切是质量杀手（WER 会涨到 10%），所以它只当安全阀，用来兜住
  // "说话人长时间不停顿"这种情况，而不是常规切分手段。
  //
  // 实测权衡（讲座 / 连续 两个场景的 WER）：
  //   阀=4500 → 10.4% / 0.0%     阀=5000 → 3.0% / 3.4%
  //   阀=6000 →  1.5% / 1.7%     阀=6500 → 1.5% / 1.7%
  // 取 5000：两个场景都不至于崩，延迟也更可控。
  // 发现句子老被切断 → 调到 6000~6500；觉得字幕太滞后 → 调到 4500。
  //
  // 2026-10-16 调整：用户实测反馈"看视频时字幕滞后到 7 秒，与声音越差越远"。
  // 日志证实：视频连续讲话几乎从不触发静音切分，全部走 6500ms 硬切，
  // 于是每段"从开口"恒定为 6.8~7.4 秒（见 captioner.log 段#224~#231）。
  // 而 README 的扫参表显示 6000 与 6500 的 WER 完全相同（1.5%/1.7%），
  // 说明 6500 白亏 500ms。故下调到 5000（WER 3.0~4.5%），
  // 并用 chunkGraceMs 智能微延补偿被切断的句子。
  chunkMs: 5000,         // 安全阀：无停顿时最长攒这么多音频就强制定稿。
                         // 实测 5000→6500 让 WER 从 3.0% 降到 1.5%，代价是从开口约 7 秒。
  minChars: 3,           // 少于这么多字不翻（滤掉噪音）
  silenceHoldMs: 800,    // 静音多久算"说完了"（实测 700 以下会切碎句子）
                         // 900→800：静音路径的上屏延迟再降 100ms。
  // 智能硬切：撞到 chunkMs 时，如果句子正卡在半截（hanging），
  // 最多再等这么久把句子收完再定稿 —— 用"少数句子多等 ≤0.8s"换回硬切损失的准确率。
  // 与旧的"宽限期"不同：那个是无条件 +350ms 且会一路涨到 6.7s；
  // 这里只在 hanging 且未超 chunkMs+chunkGraceMs 时等待，上限严格可控。
  chunkGraceMs: 800,
  minSpeechMs: 1200,     // 一段至少这么长才允许被静音切走
  finalizeGraceMs: 350,  // 判定"说完了"之后再等这么久才真定稿。流式模型文本
                         // 比音频滞后几十到几百毫秒，不等会把最后的词切掉。
  // 切点重叠：硬切会把一个词劈成两半（实测出现过 "University of" + "Ically good"，
  // 原本是 "typically good"）。把段尾这一小段音频带到下一段开头一起识别，
  // 被切断的词就能在新段落里被完整看到；重复部分再用文本去重消掉。
  overlapMs: 300,        // 0 = 关闭。实测开启后讲座场景 WER 4.5% → 1.5%；
                         // 150→300（2026-10-16）：chunkMs 下调到 5000 后切点更密，
                         // 实测出现词被劈开的残留（Transport→"Tport"、kilometre→"kilom"）。
                         // 加大重叠让被切断的词在新段里能被完整看到，再由文本去重消掉重复。
                         // 连续讲话场景在噪声范围内（差距小于一个词）。
                         // 取小值：只影响段边界，不引入额外风险。
  overlapMinChars: 4,    // 去重时至少匹配这么多字符，避免误删正常内容

  // 翻译
  translate: true,
  ollamaUrl: 'http://127.0.0.1:11434/api/chat',
  ollamaModel: 'qwen3:8b',
  noThink: true,
  contextPairs: 2,

  // 输出
  autoSaveMs: 60000,     // 每 60 秒自动保存一次 Word（静默覆盖同名文件）。
                         // 2026-10-16 新增：用户要求"同传翻译之后把内容保存到翻译文件文件夹"，
                         // 不能只在 Ctrl-C 退出时导出 —— 直接关窗口就会全丢。
                         // 0 = 关闭自动保存（仅退出时导出）。
  liveJson: path.join(__dirname, 'live.json'),
  transcriptFile: path.join(__dirname, 'transcript.jsonl'),
  eventsFile: path.join(__dirname, 'events.jsonl'),
  logFile: path.join(__dirname, 'captioner.log'),
  subtitlesHtml: path.join(__dirname, 'subtitles.html'),
  verbose: false,        // 是否把诊断日志也打到终端（默认关闭，避免顶乱字幕）

  // 终端显示区高度（行）。默认 40 行 ≈ 19 段历史 + 进行中一段 + 状态行。
  // 实际渲染时会自动压到「终端高度 - 1」以内 —— 超过就会触发滚动，
  // 而"永不滚动"正是这个界面存在的意义。用 --lines 临时改。
  displayLines: 40,

  // 退出时导出 Word
  city: 'London',              // 标题里的地区城市，用 --city 改
  docxSubdir: '翻译文件',       // 输出子目录（相对本目录）
  // 导出 Word 用的 Python（需要 python-docx）
  // 优先级：$PYTHON / $DSH_PYTHON → 旧版 DSH 自带解释器（兼容）→ PATH 上的 python3
  pythonPath: (() => {
    if (process.env.PYTHON) return process.env.PYTHON;
    if (process.env.DSH_PYTHON) return process.env.DSH_PYTHON;
    const dshPy = path.join(HOME, '.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3');
    return fs.existsSync(dshPy) ? dshPy : 'python3';
  })(),
};

const argv = process.argv.slice(2);
const valOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
if (valOf('--source')) CFG.source = valOf('--source');
if (valOf('--replay')) { CFG.source = 'replay'; CFG.replayFile = valOf('--replay'); }
if (argv.includes('--no-translate')) CFG.translate = false;
if (valOf('--model')) CFG.ollamaModel = valOf('--model');
if (valOf('--chunk-ms')) CFG.chunkMs = Number(valOf('--chunk-ms'));
if (valOf('--silence-ms')) CFG.silenceHoldMs = Number(valOf('--silence-ms'));
if (valOf('--grace-ms')) CFG.finalizeGraceMs = Number(valOf('--grace-ms'));
if (valOf('--overlap-ms')) CFG.overlapMs = Number(valOf('--overlap-ms'));
if (argv.includes('--verbose')) CFG.verbose = true;
if (valOf('--city')) CFG.city = valOf('--city');
if (valOf('--lines')) CFG.displayLines = Math.max(6, Number(valOf('--lines')) || 40);

// ── 日志：默认只写文件，不污染终端 ──
//
// 这是踩过的坑：原来 log() 直接 console.error，而同一个终端正在原地重画字幕。
// 每段 3 行日志把画面顶下去，清屏又只清可视区，结果就是"内容一直往下滚、
// 还出现重复块"，用户得一直手动往下翻。诊断信息与字幕必须分两个渠道。
// 用同步追加而不是 WriteStream：WriteStream 是缓冲的，而退出前我们直接调
// process.exit(0)，缓冲区里最后几行（包括"Word 已生成"这类关键记录）会被丢掉。
// 日志量很小（每分钟几十行），同步写完全不影响性能。
const log = (...a) => {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${a.join(' ')}\n`;
  try { fs.appendFileSync(CFG.logFile, line); } catch {}
  if (CFG.verbose) process.stderr.write(line);
};
const event = (name, data) => {
  try { fs.appendFileSync(CFG.eventsFile, JSON.stringify({ t: Date.now(), name, ...data }) + '\n'); } catch {}
};

// ─────────────────────── 识别器 ───────────────────────
function buildStreaming() {
  const sherpa = require('sherpa-onnx-node');
  const d = CFG.streamingDir;
  return new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: CFG.sampleRate, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: path.join(d, 'encoder-epoch-99-avg-1.int8.onnx'),
        decoder: path.join(d, 'decoder-epoch-99-avg-1.int8.onnx'),
        joiner: path.join(d, 'joiner-epoch-99-avg-1.int8.onnx'),
      },
      tokens: path.join(d, 'tokens.txt'),
      numThreads: 2, provider: 'cpu', debug: 0,
    },
    decodingMethod: 'greedy_search',
    enableEndpoint: false,     // 我们自己按静音判断，不依赖它的 endpoint
    rule1MinTrailingSilence: 2.4,
    rule2MinTrailingSilence: 1.2,
    rule3MinUtteranceLength: 20,
  });
}

function buildSenseVoice() {
  const sherpa = require('sherpa-onnx-node');
  const d = CFG.senseVoiceDir;
  if (!fs.existsSync(path.join(d, 'model.int8.onnx'))) {
    throw new Error(
      `找不到 SenseVoice 模型：${d}\n` +
      `请先运行：node setup-model.mjs`
    );
  }
  return new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: CFG.sampleRate, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model: path.join(d, 'model.int8.onnx'),
        language: 'auto',              // 中英混说自动判语言
        useInverseTextNormalization: 1,
      },
      tokens: path.join(d, 'tokens.txt'),
      numThreads: 2, provider: 'cpu', debug: 0,
    },
  });
}

// 把流式输出（ALL CAPS 无标点）收拾成能看的预览
function tidyPreview(s) {
  if (!s) return '';
  const t = s.trim().replace(/\s+/g, ' ');
  // 全大写转句首大写，其余小写（专有名词会吃亏，但这只是预览）
  if (t === t.toUpperCase() && /[A-Z]/.test(t)) {
    return t.charAt(0) + t.slice(1).toLowerCase();
  }
  return t;
}

// ─────────────────────── 翻译 ───────────────────────
class Translator {
  constructor() { this.history = []; this.stats = { count: 0, totalMs: 0, lastMs: 0 }; }

  async run(text, onDone) {
    const t0 = Date.now();
    let zh;
    try { zh = await this.#call(text); }
    catch (e) { log('翻译失败:', e.message); zh = `[翻译失败: ${e.message}]`; }
    const ms = Date.now() - t0;
    this.stats.count++; this.stats.totalMs += ms; this.stats.lastMs = ms;
    if (zh && !zh.startsWith('[翻译失败')) {
      this.history.push({ en: text, zh });
      if (this.history.length > 8) this.history.shift();
    }
    event('translate_done', { ms, chars: text.length });
    onDone?.(zh, ms);
  }

  async #call(text) {
    const sys = "You are a professional simultaneous interpreter working on live lecture audio. "
      + "Translate the user's text into concise, natural Simplified Chinese. "
      + "If the text is already Chinese, just clean it up minimally. "
      + "Output ONLY the translation — no explanation, no pinyin, no quotes, no English, no notes.";
    let user = text;
    if (this.history.length) {
      const ctx = this.history.slice(-CFG.contextPairs).map(h => `EN: ${h.en}\nZH: ${h.zh}`).join('\n');
      user = `Previous context (terminology reference only — do NOT re-translate, do NOT repeat):\n${ctx}\n\nTranslate this new segment:\n${text}`;
    }
    const body = {
      model: CFG.ollamaModel, stream: false, keep_alive: '30m',
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      options: { temperature: 0, num_predict: 220 },
    };
    if (CFG.noThink) body.think = false;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
      const res = await fetch(CFG.ollamaUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      let out = (d.message?.content || '').trim();
      // 兜底：模型偶尔会把上下文一起吐出来
      out = out.replace(/^(翻译|译文|Translation)[:：]\s*/i, '').trim();
      return out;
    } finally { clearTimeout(timer); }
  }
}

// ─────────────────────── 显示 ───────────────────────
class Display {
  constructor() {
    this.done = [];        // 已定稿段落
    this.live = null;      // 当前预览
    this.seq = 0;
    this.lastPaint = '';
    this.status = '';
    this.tip = '';
    this.tty = Boolean(process.stdout.isTTY);
    this.prevLines = [];   // 上一帧每一行的内容，用于只重画变化的行
    this.started = false;
    this.lastRows = 0;
  }

  // 显示区总行数：默认 CFG.displayLines，但绝不超过终端实际高度。
  // 这是硬约束 —— 块高一旦超过窗口高度，终端就会滚动，
  // 而"永不滚动"正是这个界面存在的意义（之前用追加模式时画面会一直往下跑）。
  currentRows() {
    const termRows = process.stdout.rows || 0;
    if (termRows > 0) return Math.max(6, Math.min(CFG.displayLines, termRows - 1));
    return CFG.displayLines;
  }

  setStatus(s) { this.status = s; this.paint(); }
  setTip(s) { this.tip = s; this.paint(); }

  setLive(en) {
    this.live = en ? { seq: this.seq + 1, en, state: 'live' } : null;
    this.paint();
  }

  beginSegment() { this.seq++; this.live = null; }

  commitSegment(en, zh, ms, tStart, tFinalize) {
    // tStart   = 开始攒这段音频的时刻（"从开口算"的起点）
    // tFinalize= 说话结束、我们知道该翻什么的时刻 → "上屏延迟"从这里算
    const rec = {
      seq: this.seq, en, zh, state: 'done',
      tStart, tFinalize: tFinalize || tStart, tDone: Date.now(), ms,
    };
    this.done.push(rec);
    if (this.done.length > 500) this.done.shift();
    this.live = null;
    // 非终端（重定向到文件）：不重画，按定稿顺序追加，保证文件可读
    if (!this.tty) process.stdout.write(`${en}\n${zh}\n\n`);
    this.paint(); this.writeLive(); this.writeTranscript(en, zh, ms);
    return rec;
  }

  dropSegment() { this.live = null; this.paint(); }

  // 压到一行内：超长就截断。必须做，否则折行会把固定块撑高、终端就会滚。
  // keepTail=true 用于"正在识别"的文本 —— 你想看的是最新吐出来的词。
  fit(text, keepTail) {
    const cols = Math.max(30, (process.stdout.columns || 80) - 1);
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (t.length <= cols) return t;
    return keepTail ? '…' + t.slice(-(cols - 1)) : t.slice(0, cols - 1) + '…';
  }

  paint() {
    if (!this.tty) return;

    // 2026-10-16 配色调整（用户反馈"颜色不够清楚"）：
    // 原来英文原文用 CYAND(36m 暗青)、中文译文用 CYAN(96m 亮青) ——
    // 两者同色系，且 36m 在深色终端里偏暗，原文读起来发灰。
    // 现在英文改用 WHITE(97m) 亮白，与亮青译文形成明显区分：
    //   段号 = 暗灰（不抢眼）／英文原文 = 亮白／中文译文 = 亮青
    const DIM = '\x1b[90m', WHITE = '\x1b[97m', CYAN = '\x1b[96m',
          CYAND = '\x1b[36m', AMBER = '\x1b[33m', R = '\x1b[0m';

    const rows = this.currentRows();
    const hasLive = Boolean(this.live?.en);
    // 除状态行外每段占 2 行（英文 + 中文）；进行中的那段也预留 2 行
    const reserve = 1 + (hasLive ? 2 : 0);
    const cap = Math.max(1, Math.floor((rows - reserve) / 2));
    const segs = this.done.slice(-cap);

    const body = [];
    for (const s of segs) {
      const idx = `[${String(s.seq).padStart(3, '0')}]`;
      body.push(`${WHITE}${this.fit(idx + ' ' + s.en, false)}${R}`);
      body.push(`${CYAN}${this.fit('      ' + s.zh, false)}${R}`);
    }
    if (hasLive) {
      body.push(`${WHITE}${this.fit('[···] ' + this.live.en, true)}${R}`);
      body.push(`${AMBER}${this.fit('      识别中…', false)}${R}`);
    } else if (!segs.length) {
      body.push(`${DIM}${this.fit('（等待语音…播放讲座音频或对着麦克风说话）', false)}${R}`);
    }

    // 内容不足时在顶部补空行 —— 新内容从下往上长，最新永远贴着状态行
    const pad = Math.max(0, rows - 1 - body.length);
    const lines = [
      ...new Array(pad).fill(''),
      ...body.slice(-(rows - 1)),
      `${DIM}${this.fit(this.status + (this.tip ? '   │   ' + this.tip : ''), false)}${R}`,
    ];
    while (lines.length < rows) lines.splice(lines.length - 1, 0, '');
    const finalLines = lines.slice(-rows);

    const key = finalLines.join('\n');
    if (key === this.lastPaint) return;
    this.lastPaint = key;

    // 首次（或行数变化后）清屏建立干净画布，之后只重画真正变化的行。
    // 已定稿的历史行几乎不变，所以通常每次只重画 1～3 行 —— 大幅减少闪烁。
    let out = '';
    const needFull = !this.started || rows !== this.lastRows;
    if (needFull) {
      out += '\x1b[2J\x1b[H';
      this.prevLines = [];
      this.started = true;
      this.lastRows = rows;
    }
    for (let i = 0; i < rows; i++) {
      if (!needFull && finalLines[i] === this.prevLines[i]) continue;
      out += `\x1b[${i + 1};1H` + finalLines[i] + '\x1b[K';
    }
    this.prevLines = finalLines;
    process.stdout.write(out);
  }

  writeLive() {
    try {
      fs.writeFileSync(CFG.liveJson, JSON.stringify({
        updated: Date.now(), live: this.live, lines: this.done.slice(-8),
      }, null, 2));
    } catch {}
  }

  writeTranscript(en, zh, ms) {
    try { fs.appendFileSync(CFG.transcriptFile, JSON.stringify({ t: Date.now(), en, zh, ms }) + '\n'); } catch {}
  }
}

// ─────────────────────── 主流程 ───────────────────────
async function main() {
  const streaming = buildStreaming();
  const senseVoice = buildSenseVoice();
  const display = new Display();
  const translator = new Translator();

  let stream = streaming.createStream();
  let buf = [];                 // 当前段的 Float32 样本
  let lastVoiceAt = 0;          // 最近一次"有声音"的时间
  let graceDeadline = 0;        // 定稿宽限期的截止时刻（0 = 无待定定稿）
  let pendingOverlap = null;    // 要带到下一段开头的音频（Float32Array，切点重叠用）
  let prevTextTail = '';        // 上一段正文的尾部，用于重叠去重
  let queue = Promise.resolve();
  let queueDepth = 0;           // 排队中的翻译任务数（用来发现"翻译跟不上语速"）
  let segStart = Date.now();
  // 会话开始时间：Word 文件名固定用它，这样定期自动保存是"覆盖同一个文件"。
  // 若用 new Date()，每次自动保存都会新建一个 docx，一分钟一个，很快堆满目录。
  const sessionStart = new Date();

  const SEG_MS = CFG.chunkMs;
  const END_SIL = CFG.silenceHoldMs;
  const MIN_SPEECH = CFG.minSpeechMs;

  function resetSegment() {
    stream = streaming.createStream();
    buf = [];
    lastVoiceAt = 0;
    graceDeadline = 0;
    segStart = Date.now();
    display.beginSegment();
  }

  // 用 SenseVoice 对整段音频做一次精修识别
  function refine(samples) {
    const t0 = Date.now();
    const st = senseVoice.createStream();
    st.acceptWaveform({ sampleRate: CFG.sampleRate, samples });
    senseVoice.decode(st);
    const r = senseVoice.getResult(st);
    return { text: (r?.text || '').trim(), ms: Date.now() - t0 };
  }

  // 重叠去重：这一段的开头往往和上一段的结尾是同一句话。
  // 找出"新文本的前缀"与"上一段文本的后缀"最长的重合部分并去掉。
  // 只在重合足够长时才动手，避免误删正常内容。
  function stripOverlap(text, prevTail) {
    if (!prevTail || !text) return text;
    const max = Math.min(text.length, prevTail.length);
    let best = 0;
    for (let k = max; k >= CFG.overlapMinChars; k--) {
      if (prevTail.slice(-k) === text.slice(0, k)) { best = k; break; }
    }
    if (best < CFG.overlapMinChars) return text;
    return text.slice(best).replace(/^[\s,.;:，。；：、]+/, '');
  }

  function finalize(reason) {
    const samples = buf.length > 1 ? Float32Array.from(buf) : null;
    const tSegStart = segStart;              // 这段音频是从什么时候开始攒的
    const tSpeechEnd = Date.now();           // 说话结束（= 我们知道该翻什么了）的时刻
    const audioMs = buf.length / (CFG.sampleRate / 1000);
    buf = [];
    stream = streaming.createStream();
    lastVoiceAt = 0;
    graceDeadline = 0;
    segStart = Date.now();

    if (!samples || audioMs < 400) { display.dropSegment(); display.beginSegment(); return; }

    let { text, ms: asrMs } = refine(samples);
    // 去掉与上一段重叠的部分（切点重叠会带来重复文字）
    const before = text;
    text = stripOverlap(text, prevTextTail);
    if (text !== before) {
      event('overlap_stripped', { removed: before.length - text.length, before, after: text });
    }
    event('finalize', { reason, audioMs: Math.round(audioMs), asrMs, text, chars: text.length });

    if (text.length < CFG.minChars) {
      log(`段跳过 [${reason}] 音频${Math.round(audioMs)}ms 识别为空`);
      display.dropSegment(); display.beginSegment(); return;
    }
    prevTextTail = text.slice(-60);

    const seq = display.seq + 1;
    const chained = (zh, ms) => {
      // 延迟从"说话结束"算起，而不是"开始攒音频"。
      //
      // 为什么改：原来从开始攒音频算，等于把 3.5 秒的缓冲时间也算进延迟，
      // 数字虚高；更糟的是排队积压会被逐段累加，报出 30 秒这种无意义的数字。
      // 真正该衡量的是：人说完话之后，多久能在屏幕上看到译文。
      const now = Date.now();
      const pipelineLatency = now - tSpeechEnd;      // 说完了 → 译文上屏
      const sinceSpeechStart = now - tSegStart;      // 从开口算（含攒音频）
      const queueWait = now - tSpeechEnd - asrMs;
      log(`段#${seq} [${reason}] 音频${Math.round(audioMs)}ms 识别${asrMs}ms `
        + `上屏延迟${pipelineLatency}ms (从开口${sinceSpeechStart}ms)\n   EN: ${text}\n   ZH: ${zh}`);
      event('segment_done', { seq, reason, pipelineLatency, sinceSpeechStart, asrMs, queueWaitMs: Math.max(0, queueWait) });
      // 状态行更新为实时统计，让你一眼看到"跟不跟得上"
      display.setStatus(`第 ${seq} 段 · 上屏 ${pipelineLatency}ms · 翻译 ${ms}ms · 识别 ${asrMs}ms`
        + (queueDepth > 0 ? ` · 积压 ${queueDepth}` : ''));
    };

    // 把段尾一小段音频带到下一段开头：被硬切劈开的词会在新段落里完整出现
    if (CFG.overlapMs > 0) {
      const n = Math.round((CFG.sampleRate * CFG.overlapMs) / 1000);
      const tail = samples.subarray(Math.max(0, samples.length - n));
      buf = Array.from(tail);
      event('overlap_carry', { samples: tail.length, ms: CFG.overlapMs });
    }

    if (CFG.translate) {
      // 串行排队：保证字幕顺序与语音顺序一致
      queueDepth++;
      if (queueDepth > 1) {
        // 积压说明翻译跟不上语速，延迟会持续增长——这是个必须让人看见的信号
        log(`⚠ 翻译积压 ${queueDepth} 段排队（翻译跟不上语速，字幕会越来越滞后）`);
        event('queue_backlog', { depth: queueDepth, seq });
      }
      queue = queue.then(() => translator.run(text, (zh, ms) => {
        display.commitSegment(text, zh, ms, tSegStart, tSpeechEnd);
        log(`   ZH(${ms}ms): ${zh}`);
        queueDepth--;
        chained(zh, ms);
      }));
    } else {
      display.commitSegment(text, '(未翻译)', 0, tSegStart, tSpeechEnd);
      chained('(未翻译)', 0);
    }
    display.beginSegment();
  }

  const framesPerMs = CFG.sampleRate / 1000;
  // 静音门限：固定值在真实环境里不可靠（实测安静房间麦克风 RMS 只有 70 左右，
  // 而固定门限 0.012≈393 会把正常说话也当静音）。
  //
  // 这里用"滚动分位数"估计环境噪声，而不是校准前 1.5 秒——因为实测发现，
  // 如果音频开头就是人声（讲座直接开讲、测试音频没有前导静音），
  // 把开头当噪声校准会把门限抬到语音之上，导致静音检测彻底失效。
  // 分位数的好处：说话时 RMS 高，但滚动窗口里总会有停顿的低值，底线自然稳在底部。
  const RMS_WINDOW = 150;          // 15 秒 × 100ms
  const rmsHistory = [];
  // 门限以"绝对听觉阈值"为主，自适应只做微调。
  //
  // 实测数据（这几个常数就是这么定出来的）：说话时 RMS 约 0.03~0.18，
  // 而停顿与底噪仍有 0.004~0.009（TTS 和房间噪声都不是真的零）。
  // 最初我用"底噪 × 3"当门限，结果门限落在 0.004，等于把停顿也判成说话，
  // 静音计时永远攒不到阈值 —— 整段音频只在结束时定稿一次，字幕完全失去实时性。
  // 取 0.012：高于底噪 0.009，远低于说话 0.03，两边都有余量。
  const VOICE_ABS = 0.012;
  const VOICE_MIN = 0.008;
  const VOICE_MAX = 0.030;
  let noiseFloor = 0.004;

  function updateNoiseFloor(rms) {
    rmsHistory.push(rms);
    if (rmsHistory.length > RMS_WINDOW) rmsHistory.shift();
    if (rmsHistory.length < 10) return;
    const sorted = [...rmsHistory].sort((a, b) => a - b);
    const p = sorted[Math.floor(sorted.length * 0.15)];   // 第 15 百分位 ≈ 安静时刻
    noiseFloor = Math.max(0.001, Math.min(p, 0.02));
  }

  function onAudio(f32) {
    // ① 预览：流式识别（边说边出字，让你立刻看到"在听什么"）
    stream.acceptWaveform({ sampleRate: CFG.sampleRate, samples: f32 });
    while (streaming.isReady(stream)) streaming.decode(stream);
    const preview = tidyPreview(streaming.getResult(stream)?.text || '');
    if (preview) display.setLive(preview);

    // ② 累积音频（留给 SenseVoice 精修）
    for (let i = 0; i < f32.length; i++) buf.push(f32[i]);

    // ③ 计算响度（既更新噪声底线，也用于静音判断）
    let sum = 0;
    for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
    const rms = Math.sqrt(sum / f32.length);
    updateNoiseFloor(rms);

    // 门限 = 绝对阈值，自适应只能在 [VOICE_MIN, VOICE_MAX] 内把它抬高一点，
    // 用来适应"环境本身就吵"的场合（比如教室空调声）。
    const voiceGate = Math.min(VOICE_MAX, Math.max(VOICE_ABS, noiseFloor * 1.5, VOICE_MIN));
    const now = Date.now();
    if (rms > voiceGate) lastVoiceAt = now;

    const audioMs = buf.length / framesPerMs;
    const silentFor = lastVoiceAt ? now - lastVoiceAt : 0;

    // 悬停检测：静音处如果预览文本正卡在半个句子上，就别切。
    // 实测教训——不判这个的话，"into residential" 后面的换气会被当成句尾，
    // 下一段就从 "commercial and industrial zones" 开始，主语丢了、译文也跟着错。
    const HANGING = /(\b(and|or|but|the|a|an|of|to|in|on|at|for|with|is|are|was|were|that|which|into|as|by|from|its|their|his|her|our|your|this|these|those)\b|[,;:—-])$/i;
    const hanging = HANGING.test(preview);

    const silenceReady = silentFor >= END_SIL && audioMs >= MIN_SPEECH && preview.length >= CFG.minChars;

    if (silenceReady && !hanging) {
      // 宽限期：让流式模型把尾巴吐完，避免切掉正在识别的最后几个词
      if (!graceDeadline) graceDeadline = now + CFG.finalizeGraceMs;
      return;   // 到期由看门狗负责定稿
    }

    // 有声音、或者句子还没说完 → 撤销待定状态
    if (!silenceReady) graceDeadline = 0;

    // 硬上限：攒够 chunkMs 就定稿，这是延迟的兜底保证。
    //
    // 注意：这里绝不能走静音那条宽限期。实测踩过的坑——宽限期只该服务于"静音提前切分"
    // （那种情况下多等 350ms 能让流式模型把句子吐完，值得）；
    // 但硬上限是延迟兜底，一旦让无条件宽限期介入，段落就会一路涨到 6.7 秒，
    // 端到端延迟冲到 9 秒。而且音频本来就在缓冲里，SenseVoice 会完整重跑，
    // 不需要等流式模型"说完"。
    //
    // 2026-10-16 新增「智能硬切」：chunkMs 下调到 5000 后，硬切会更容易拦腰切断句子
    // （这正是 5000 档 WER 3.0~4.5% 的来源）。所以撞线时判断一次 hanging：
    // 若句子正卡在半截，就再等一会儿把它收完 —— 但总时长严格不超过
    // SEG_MS + chunkGraceMs，因此延迟上界完全可控，不会重蹈"涨到 6.7 秒"的覆辙。
    if (audioMs >= SEG_MS) {
      // 2026-10-16 实测发现：光靠文本 hanging 判据不够。
      // SenseVoice 在音频被硬切时会"友好地"自己补一个句号 ——
      // 实测原文 "Cities divide their area into residential, commercial, and industrial districts."
      // 被切成 "…into residential, commercial." + "And industrial districts."，
      // 前一段结尾带句号，hanging 正则匹配不到，于是误判成"句子已完"，照切不误。
      //
      // 所以补一个更可靠的物理判据：此刻是否还在说话。
      // silentFor 很小 = 还没有出现自然停顿，说明这句话大概率没说完。
      // 此时再等一小会儿去撞一个停顿点；总时长仍严格受 SEG_MS + chunkGraceMs 约束。
      const stillTalking = silentFor < 250;
      if ((hanging || stillTalking) && audioMs < SEG_MS + CFG.chunkGraceMs) {
        return;   // 还没说完，再等一小会儿（最多 chunkGraceMs）
      }
      graceDeadline = 0;
      finalize(hanging ? 'chunk-hanging' : 'chunk');
    }
  }

  // ── 看门狗：不依赖新的音频到达 ──
  // 为什么必须有：定稿如果只在 onAudio 里触发，那么音频一旦停止推送
  // （USB 麦克风抖动、设备切换、回放播完），待定的定稿就永远不会执行，
  // 字幕会卡在最后一段不动。实测就是这么踩到的：整段音频只在 EOF 定稿了一次。
  const watchdog = setInterval(() => {
    if (!graceDeadline || Date.now() < graceDeadline) return;
    graceDeadline = 0;
    const preview = tidyPreview(streaming.getResult(stream)?.text || '');
    const hanging = /(\b(and|or|but|the|a|an|of|to|in|on|at|for|with|is|are|was|were|that|which|into|as|by|from|its|their|his|her|our|your|this|these|those)\b|[,;:—-])$/i.test(preview);
    try { finalize(hanging ? 'watchdog-hanging' : 'watchdog'); } catch (e) { log('看门狗定稿失败:', e.message); }
  }, 100);

  // ── 音频源 ──
  let child = null;
  let audioIn;
  if (CFG.source === 'mic') {
    if (!fs.existsSync(CFG.micBin)) throw new Error(`找不到 ${CFG.micBin}，请先编译 mic2pcm.swift（见 README.md）`);
    child = spawn(CFG.micBin, [], { stdio: ['ignore', 'pipe', 'inherit'] });
    audioIn = child.stdout;
    log('麦克风已启动');
  } else if (CFG.source === 'replay') {
    // 回放模式：按实时速度把 PCM 文件喂进来，用于验证整条链路（含真实延迟）
    const { PassThrough } = await import('node:stream');
    const data = fs.readFileSync(CFG.replayFile);
    const frameBytes = Math.round((CFG.sampleRate * 2 * 20) / 1000);   // 20ms
    const totalSec = data.length / (CFG.sampleRate * 2);
    audioIn = new PassThrough();
    let off = 0;
    const t0 = Date.now();
    const timer = setInterval(() => {
      // 按已过去的时间决定"现在应该播到哪里"，避免闹钟漂移累积
      const allowedSec = (Date.now() - t0) / 1000;
      const target = Math.min(data.length, Math.floor(allowedSec * CFG.sampleRate * 2));
      while (off < target) {
        const end = Math.min(off + frameBytes, target);
        audioIn.write(data.subarray(off, end));
        off = end;
      }
      if (off >= data.length) {
        clearInterval(timer);
        log(`回放结束（${totalSec.toFixed(1)} 秒）`);
        audioIn.end();
      }
    }, 20);
    log(`回放模式: ${CFG.replayFile}（实时速度，${totalSec.toFixed(1)} 秒）`);
  } else {
    audioIn = process.stdin;
    log('从 stdin 读取 16kHz 单声道 PCM16');
  }

  const FRAME_MS = 100;
  const FRAME_BYTES = Math.round((CFG.sampleRate * 2 * FRAME_MS) / 1000);
  let pending = Buffer.alloc(0);

  audioIn.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= FRAME_BYTES) {
      const frame = pending.subarray(0, FRAME_BYTES);
      pending = pending.subarray(FRAME_BYTES);
      const n = frame.length >> 1;
      const f32 = new Float32Array(n);
      for (let i = 0; i < n; i++) f32[i] = frame.readInt16LE(i << 1) / 32768;
      try { onAudio(f32); } catch (e) { log('处理错误:', e.message); }
    }
  });

  // ── 退出时导出 Word ──
  // 设计取舍：生成放在收尾里，且失败绝不影响退出。
  // 万一导出失败，transcript.jsonl 仍在，不会两头落空。
  // 2026-10-16：改成可重复导出。
  // 原因：用户反馈"同传翻译之后没有把内容保存到翻译文件文件夹"——
  // 旧实现只在 EOF / Ctrl-C 时导出一次（docxExported 是一次性标志），
  // 直接关窗口、进程被杀、或长时间运行中途想看内容，都不会有文件。
  // 现在改为：定期覆盖保存 + 退出时最终保存。文件名固定用「会话开始时间」，
  // 因此反复保存只刷新同一个 docx，不会堆出一堆文件。
  let exporting = false;        // 防重入（定期保存可能与退出保存撞车）
  let docxExported = false;     // 是否成功导出过至少一次（用于状态提示）
  async function exportDocx(reason, silent = false) {
    if (exporting) return;      // 上一次还没写完，跳过这一轮
    const segs = display.done;
    if (!segs.length) {
      log(`导出跳过（${reason}）：本次没有任何定稿段落`);
      return;
    }
    exporting = true;
    try {
      await writeDocx(reason, silent);
      docxExported = true;
    } catch (e) {
      log(`导出异常（${reason}）:`, e.message);
    } finally {
      exporting = false;
    }
  }

  async function writeDocx(reason, silent) {
    const segs = display.done;
    const now = sessionStart;   // 固定用会话开始时间 → 反复保存覆盖同一文件
    const pad = (n) => String(n).padStart(2, '0');
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const timeCompact = `${pad(now.getHours())}${pad(now.getMinutes())}`;

    const lats = segs
      .map(s => (s.tDone || 0) - (s.tFinalize || s.tStart || 0))
      .filter(v => v > 0).sort((a, b) => a - b);
    const median = lats.length ? lats[Math.floor(lats.length / 2)] : 0;
    const first = segs[0].tStart || segs[0].t || now.getTime();
    const lastSeg = segs[segs.length - 1];
    const last = lastSeg.tDone || now.getTime();
    const durSec = Math.max(0, Math.round((last - first) / 1000));

    const payload = {
      title: `${date} ${time} ${CFG.city}`,
      filename: `${date} ${timeCompact} ${CFG.city}.docx`,
      date, time, timeCompact,
      city: CFG.city,
      startedAt: first,
      endedAt: last,
      stats: {
        count: segs.length,
        durationText: `${Math.floor(durSec / 60)} 分 ${durSec % 60} 秒`,
        medianLatencyText: median ? `${median} ms` : '—',
        asrModel: 'SenseVoice（本地）',
        mtModel: CFG.translate ? `${CFG.ollamaModel}（本地）` : '未启用翻译',
      },
      segments: segs.map(s => ({
        t: s.tStart, en: s.en, zh: s.zh,
        latencyMs: (s.tDone && (s.tFinalize || s.tStart))
          ? s.tDone - (s.tFinalize || s.tStart) : 0,
      })),
    };

    const payloadPath = path.join(__dirname, '.docx-payload.json');
    const dir = path.join(__dirname, CFG.docxSubdir);
    try {
      fs.writeFileSync(payloadPath, JSON.stringify(payload, null, 2));
    } catch (e) {
      log('导出失败：无法写入 payload', e.message);
      return;
    }

    try {
      const { execFileSync } = await import('node:child_process');
      const out = execFileSync(CFG.pythonPath,
        [path.join(__dirname, 'make_docx.py'), payloadPath, dir],
        { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      log(`Word 文档已生成(${reason}): ${out}`);
      if (!silent) {
        // 只有退出时的最终导出才刷屏 —— 定期保存刷屏会把字幕画面顶乱
        process.stdout.write(`\r\n\x1b[92m✔ 已生成 Word 文档\x1b[0m\r\n  ${out}\r\n`);
      }
    } catch (e) {
      const msg = (e.stderr || e.message || '').toString().slice(0, 300);
      log(`导出 Word 失败(${reason}):`, msg);
      if (!silent) {
        process.stdout.write(`\r\n\x1b[91m✘ Word 导出失败\x1b[0m（内容仍完整保存在 transcript.jsonl）\r\n`);
      }
    } finally {
      try { fs.unlinkSync(payloadPath); } catch {}
    }
  }

  audioIn.on('end', async () => {
    log('音频结束，收尾…');
    clearInterval(watchdog);
    if (autoSaveTimer) clearInterval(autoSaveTimer);
    if (buf.length) finalize('eof');
    await queue.catch(() => {});
    const s = translator.stats;
    if (s.count) log(`翻译统计: ${s.count} 段，平均 ${Math.round(s.totalMs / s.count)}ms，最近 ${s.lastMs}ms`);
    const done = display.done;
    if (done.length) {
      const lats = done.filter(d => d.tDone && d.tStart).map(d => d.tDone - d.tStart);
      if (lats.length) {
        lats.sort((a, b) => a - b);
        const avg = Math.round(lats.reduce((a, b) => a + b, 0) / lats.length);
        log(`端到端延迟: 平均 ${avg}ms / 中位 ${lats[Math.floor(lats.length / 2)]}ms / 最大 ${lats[lats.length - 1]}ms（${lats.length} 段）`);
      }
    }
    await exportDocx('eof');
    child?.kill('SIGINT');
    process.exit(0);
  });

  // ── 定期自动保存 Word ──
  // 每 autoSaveMs 静默覆盖保存一次，因此任何时刻打开「翻译文件」里的
  // 那个 docx 都是"到目前为止"的完整原文+译文，不必等 Ctrl-C 退出。
  // 静默：不刷屏，避免顶乱实时字幕；失败只写日志，绝不影响识别。
  const autoSaveTimer = CFG.autoSaveMs > 0
    ? setInterval(() => {
        if (!display.done.length) return;
        exportDocx('autosave', true).catch((e) => log('自动保存失败:', e.message));
      }, CFG.autoSaveMs)
    : null;

  const shutdown = async () => {
    log('收到中断，收尾…');
    clearInterval(watchdog);
    if (autoSaveTimer) clearInterval(autoSaveTimer);
    try { if (buf.length) finalize('sigint'); } catch {}
    await queue.catch(() => {});
    await exportDocx('sigint');
    child?.kill('SIGINT');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  display.beginSegment();
  display.setTip(`分块 ${SEG_MS}ms · ${CFG.translate ? CFG.ollamaModel : '仅识别'} · 诊断日志见 captioner.log · Ctrl-C 停止`);
  display.setStatus(`就绪 · 字幕页 http://127.0.0.1:8790/`);
  log(`就绪 | 分块 ${SEG_MS}ms | 静音提前定稿 ${END_SIL}ms | 翻译 ${CFG.translate ? CFG.ollamaModel + (CFG.noThink ? '(no-think)' : '') : '关闭'}`);
  log(`字幕页: http://127.0.0.1:8790/  (由 serve.mjs 提供)`);
  if (CFG.translate) {
    log('预热翻译模型…');
    display.setStatus('预热翻译模型…');
    translator.run('warm up', () => {}).then(() => {
      log('预热完成');
      display.setStatus('就绪 · 正在监听');
    });
  }
}

main().catch(e => {
  log('启动失败:', e.message);
  process.stderr.write(`\n启动失败: ${e.message}\n（详见 captioner.log）\n`);
  process.exit(1);
});
