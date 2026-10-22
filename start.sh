#!/bin/bash
# 实时字幕启动器（中英混合 → 中文）
#
# 用法：
#   ./start.sh                      # 麦克风收音，终端显示彩色字幕
#   ./start.sh --chunk-ms 6000      # 句子更完整、延迟略高
#   ./start.sh --chunk-ms 4500      # 更跟手、可能切断句子
#   ./start.sh --city Beijing       # 改 Word 标题里的地区名
#
# 停止：Ctrl-C（会导出最终 Word；即使不按，运行中也每 60 秒自动保存一次）

set -euo pipefail
cd "$(dirname "$0")"

OLLAMA_URL="http://127.0.0.1:11434"

fail() { printf '\033[91m✘ %s\033[0m\n' "$1" >&2; exit 1; }

# node：优先 PATH，找不到再回退 DeepSeek Harness 自带的（兼容旧环境）
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  NODE="$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node"
fi

# ── 前置检查：早点报错，别等跑起来才发现 ──
[ -x "$NODE" ]         || fail "找不到 node，请先安装 Node.js 18+（https://nodejs.org）"
[ -x ./mic2pcm ]       || fail "找不到麦克风程序 ./mic2pcm，先执行：swiftc -O mic2pcm.swift -o mic2pcm"
[ -f ./captioner.mjs ] || fail "找不到 captioner.mjs"
[ -d ./node_modules/sherpa-onnx-node ] || fail "识别引擎未安装，先执行：npm install（或 node setup.mjs）"
[ -d ./models/sensevoice ]             || fail "识别模型未下载，先执行：node setup-model.mjs"

# Ollama 必须在跑，否则没有翻译（只有识别）
if ! curl -s --max-time 3 "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
  fail "Ollama 没在运行。请先启动 Ollama.app，或执行：ollama serve"
fi

# 翻译模型是否已下载
if ! curl -s --max-time 3 "$OLLAMA_URL/api/tags" | grep -q "qwen3:8b"; then
  printf '\033[93m! 没找到 qwen3:8b，翻译会失败。先执行：ollama pull qwen3:8b\033[0m\n' >&2
fi

printf '\033[92m✔ 依赖检查通过\033[0m  参数: %s\n' "${*:-默认（分块 5000ms）}"
printf '  停止：Ctrl-C    自动保存：每 60 秒 + 退出时\n\n'

exec "$NODE" captioner.mjs "$@"
