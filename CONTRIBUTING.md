# Contributing

Thanks for taking a look. This project is small and deliberately dependency-light, so contributing is straightforward.

## Before you start

Read the **Segmentation strategy** section of the README. Most "the captions are wrong" bugs are actually segmentation bugs, and changing `chunkMs` / `silenceHoldMs` / `overlapMs` without measuring is how they get worse.

## Development setup

```bash
git clone https://github.com/<you>/live-caption.git
cd live-caption
npm install
node setup-model.mjs
swiftc -O -target arm64-apple-macos14.0 -module-cache-path ./mcache mic2pcm.swift -o mic2pcm
ollama pull qwen3:8b
```

## Testing a change

You do **not** need to talk into the microphone to test the pipeline. Use replay mode with a PCM file, then score the transcript:

```bash
# 16 kHz mono PCM16, replay at real-time speed
node captioner.mjs --replay test.pcm

# word error rate against a ground-truth transcript
node eval.mjs transcript.jsonl truth.txt
```

Please include the before/after numbers from `eval.mjs` and the latency line from `captioner.log` in your PR description. That is the whole review process — numbers, not impressions.

## What makes a good PR

- **Small and focused.** One behaviour per PR.
- **Measured.** Segmentation or model changes must show WER and latency before/after.
- **Documented.** If you add a flag, add it to the flags table in README and to the comment block in `CFG`.
- **No recorded audio or transcripts.** Never commit `.pcm`, `.wav`, `*.jsonl`, `*.log` or `翻译文件/` — they contain real conversations.

## Platform support

Currently macOS arm64 only, because:

- `mic2pcm.swift` uses AVFoundation,
- `sherpa-onnx-darwin-arm64` ships arm64 binaries.

Porting to Intel macOS or Linux needs a different capture path and a different sherpa-onnx platform package. If you want to do that, open an issue first so we can agree on the structure.

## Code style

Plain ES modules, no build step, no framework. Keep comments explaining *why* a value was chosen (the existing comments record measured trade-offs) rather than *what* the line does.

## License

By contributing you agree your work is released under the MIT license in [LICENSE](LICENSE).
