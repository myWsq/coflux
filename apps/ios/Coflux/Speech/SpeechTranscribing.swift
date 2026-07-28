import Foundation

/// 语音转写事件——豆包/Apple 两套引擎统一收敛为 volatile(可变中间稿)/finalized(定稿)
/// 两档（plan 064 决策）：调用方只关心"当前应显示的整段文字"与其是否还会变，
/// 不关心具体引擎的分段/校正细节。两个事件携带的都是全量文本（非增量）。
enum SpeechTranscriptEvent: Sendable {
    /// 全量文本，仍可能被后续事件覆盖/改写
    case volatile(String)
    /// 全量文本，本段已确认（后续语音会在其后继续增长，不会回改这段）
    case finalized(String)
    /// 仅 Apple 引擎：语言模型资产下载进度（0-1，nil = 进度未知）
    case modelDownloading(progress: Double?)
    /// 不可恢复错误；调用方按当前已转写文字兜底，不切换引擎（plan 064 决策：
    /// 对讲中途豆包断连不换引擎，结束会话保留已转写文字）
    case failed(String)
    /// 会话已终止，events 流不再产出
    case closed
}

/// 最薄的转写引擎协议：一次 start，喂 PCM，finish/cancel 收尾，事件走 AsyncStream。
/// 两个实现（豆包 IME 免 key 通道 / Apple 本地 SpeechAnalyzer）都以 actor 承载：
/// 采音 tap 跑在 CoreAudio 实时线程，UI 消费跑在 MainActor，actor 隔离统一兜底
/// 跨线程访问，不需要额外加锁。
protocol SpeechTranscribing: Sendable {
    var events: AsyncStream<SpeechTranscriptEvent> { get }
    /// 建立连接/会话；失败即抛错，调用方据此决定是否降级到下一引擎
    func start() async throws
    /// 喂一段 16kHz mono Int16 PCM（由共享采音器提供，帧长由引擎自行切分）
    func feed(pcm: Data) async
    /// 正常结束：flush 剩余音频、请求引擎给出终稿，之后 events 会收到 .closed
    func finish() async
    /// 中途放弃：尽快断开，不等终稿
    func cancel() async
}
