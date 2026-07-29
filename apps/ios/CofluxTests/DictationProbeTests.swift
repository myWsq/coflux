import Foundation
import Testing

@testable import Coflux

/// 对讲栈崩溃探针（真机长按崩溃排查用，2026-07-29）：绕过权限弹窗段，
/// 分层驱动采音/Opus/两个转写引擎的真实初始化路径。目标是"不崩"，
/// 网络失败/模型缺失等 throw 均可接受。
@Suite(.serialized)
struct DictationProbeTests {
    /// 核心断言 = 不崩进程。无输入路由/TCC 受限环境（模拟器测试进程）下
    /// start() 允许抛 inputUnavailable——2026-07-29 之前这里是 installTap
    /// 收到 0Hz 格式直接 NSException(SIGABRT)，即真机长按崩溃的复现点。
    @Test func audioCaptureStartStop() async throws {
        let capture = AudioCapture()
        do {
            try capture.start()
            try await Task.sleep(for: .seconds(1))
            capture.stop()
            // 二次启动：悬挂 tap/session 残留会在这里炸
            try capture.start()
            capture.stop()
        } catch SpeechCaptureError.inputUnavailable {
            // 无输入设备环境的合法出路；再走一遍确认可重复且仍不崩
            do { try capture.start() } catch SpeechCaptureError.inputUnavailable {}
        }
    }

    @Test func opusEncodeSilentFrame() throws {
        let encoder = try DoubaoOpusEncoder()
        let out = try encoder.encodeFrame(Data(count: 640))
        #expect(!out.isEmpty)
    }

    @Test func doubaoAdmissionAndTeardown() async {
        let provider = DoubaoIMEProvider()
        do {
            try await provider.start()
            await provider.feed(pcm: Data(count: 640 * 5))
            await provider.finish()
        } catch {
            // 免 key 通道网络/准入失败可接受
        }
        await provider.cancel()
    }

    @Test func appleProviderStartAndTeardown() async {
        guard #available(iOS 26.0, *) else { return }
        let provider = AppleSpeechProvider()
        do {
            try await provider.start()
            await provider.feed(pcm: Data(count: 640 * 5))
            await provider.finish()
        } catch {
            // 模拟器无 zh_CN 模型等 throw 可接受
        }
        await provider.cancel()
    }
}
