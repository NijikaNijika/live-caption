// mic2pcm.swift — 麦克风持续采集，输出 16kHz 单声道 PCM16 到 stdout
//
// 用途：给本地同传流水线提供音频源，零外部依赖（只用 AVFoundation）。
// 用法：./mic2pcm > audio.pcm        （Ctrl-C 停止）
//       ./mic2pcm 2>log.txt         （日志走 stderr，音频走 stdout，互不污染）
//
// 说明：首次运行系统会弹出麦克风授权；若被拒绝，请到
//       「系统设置 → 隐私与安全性 → 麦克风」里勾选运行它的程序（如终端）。

import AVFoundation
import Foundation

let targetRate: Double = 16000

func log(_ s: String) {
    FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
}

// 授权检查：命令行工具不属于某个 app bundle，这里主动请求一次。
switch AVCaptureDevice.authorizationStatus(for: .audio) {
case .authorized:
    log("[mic2pcm] 麦克风已授权")
case .notDetermined:
    log("[mic2pcm] 请求麦克风授权…")
    let sem = DispatchSemaphore(value: 0)
    AVCaptureDevice.requestAccess(for: .audio) { ok in
        log("[mic2pcm] 授权结果: \(ok)")
        sem.signal()
    }
    sem.wait()
case .denied, .restricted:
    log("[mic2pcm] 错误：麦克风被拒绝。请到「系统设置 → 隐私与安全性 → 麦克风」中允许。")
    exit(2)
@unknown default:
    break
}

guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
    log("[mic2pcm] 错误：未获得麦克风权限，退出。")
    exit(2)
}

let engine = AVAudioEngine()
let input = engine.inputNode

// 设备实际格式（通常是 48kHz 单声道 Float32）
let hwFormat = input.inputFormat(forBus: 0)
log("[mic2pcm] 设备格式: \(hwFormat.sampleRate)Hz ch=\(hwFormat.channelCount)")

guard let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16,
                                    sampleRate: targetRate,
                                    channels: 1,
                                    interleaved: true) else {
    log("[mic2pcm] 错误：无法创建目标格式")
    exit(3)
}
guard let converter = AVAudioConverter(from: hwFormat, to: outFormat) else {
    log("[mic2pcm] 错误：无法创建转换器")
    exit(3)
}

let stdout = FileHandle.standardOutput

input.installTap(onBus: 0, bufferSize: 1600, format: hwFormat) { buffer, _ in
    // 估算重采样后的帧数
    let ratio = targetRate / hwFormat.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
    guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else { return }

    var consumed = false
    var err: NSError?
    converter.convert(to: out, error: &err) { _, status in
        if consumed {
            status.pointee = .noDataNow
            return nil
        }
        consumed = true
        status.pointee = .haveData
        return buffer
    }
    if let err = err {
        log("[mic2pcm] 转换错误: \(err)")
        return
    }
    guard out.frameLength > 0, let ch = out.int16ChannelData else { return }
    let n = Int(out.frameLength)
    let data = Data(bytes: ch[0], count: n * MemoryLayout<Int16>.size)
    stdout.write(data)
}

do {
    try engine.start()
    log("[mic2pcm] 开始采集 → stdout (16kHz mono PCM16)。Ctrl-C 停止。")
} catch {
    log("[mic2pcm] 错误：引擎启动失败 \(error)")
    exit(4)
}

signal(SIGINT) { _ in
    log("\n[mic2pcm] 收到中断，正在停止…")
    exit(0)
}

RunLoop.main.run()
