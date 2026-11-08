import Foundation
import Testing

@testable import Coflux

/// 对讲栈崩溃探针（真机长按崩溃排查用，2026-07-29）：绕过权限弹窗段，
/// 驱动共享采音器的真实初始化路径。目标是"不崩"，无输入设备等 throw 均可接受。
@Suite(.serialized)
struct DictationProbeTests {
    #if targetEnvironment(simulator)
        static let isSimulator = true
    #else
        static let isSimulator = false
    #endif

    /// 核心断言 = 不崩进程。无输入路由/TCC 受限环境下 start() 允许抛
    /// inputUnavailable。仅真机可测：模拟器 headless 测试进程里 AURemoteIO
    /// 初始化必然 _ReportRPCTimeout abort（2026-07-29 实测，并行/非并行皆然，
    /// 环境固有非 app bug——app 本体在模拟器跑时音频正常）。该 abort 恰是
    /// 真机长按崩溃的同签名崩法，真机根因 = 权限框收起瞬间起引擎的时序，
    /// 修复在 DictationSession.start 的回 active 等待。
    @Test(.disabled(if: isSimulator, "模拟器测试进程无 CoreAudio 远程 IO 服务，AURemoteIO 必 abort"))
    func audioCaptureStartStop() async throws {
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
}
