import CofluxClientCore
import CofluxProtocol
import SwiftUI

struct DeviceRoutePresentation {
    enum Tone { case primary, destructive, success, warning, muted, hollow }
    struct Row { let icon: String; let text: String }
    let title: String
    let symbol: String?
    let tone: Tone
    let rows: [Row]
    init(daemon: Coflux_V1_DaemonInfo, transport: CofluxClient.DeviceTransportInfo?) {
        let mode = transport?.mode
        let connected = ["direct", "p2p", "relay"].contains(mode ?? "")
        let rtt = (transport?.rttMs).flatMap { $0.isFinite && $0 >= 0 ? $0 : nil }
        let label: String
        switch mode {
        case "direct": label = "本机直连"
        case "p2p": label = "P2P 直连"
        case "relay": label = "中心 relay"
        case "probing": label = "正在探测"
        case "offline": label = "Device route 离线"
        default: label = daemon.online ? "中心在线" : "中心离线"
        }
        title = label + (rtt.map { " · " + String(format: "%.0f", $0.rounded()) + "ms" } ?? "")
        symbol = mode == "direct" ? "zap" : mode == "p2p" ? "radio" : mode == "relay" ? "cloud" : nil
        tone = mode == "probing" ? .primary : mode == "offline" ? .destructive
            : connected ? rtt.map { $0 < 200 ? .success : .warning } ?? .muted
            : daemon.online ? .muted : .hollow
        var details = [Row(icon: "monitor", text: "\(daemon.host) / \(daemon.platform)")]
        if !daemon.workerVersion.isEmpty { details.append(Row(icon: "package", text: "worker \(daemon.workerVersion)")) }
        if !daemon.supervisorVersion.isEmpty { details.append(Row(icon: "cog", text: "supervisor \(daemon.supervisorVersion)")) }
        if let detail = transport?.detail, !detail.isEmpty { details.append(Row(icon: "info", text: detail)) }
        rows = details
    }
    var accessibilityDetails: String { ([title] + rows.map(\.text)).joined(separator: "\n") }
}

struct DeviceRouteIndicator: View {
    let presentation: DeviceRoutePresentation
    private var color: Color {
        switch presentation.tone {
        case .primary: Design.foreground
        case .destructive: Design.destructive
        case .success: Design.success
        case .warning: Design.warning
        case .muted, .hollow: Design.muted
        }
    }
    var body: some View {
        Group {
            if let symbol = presentation.symbol { WorkbenchIcon(symbol: symbol) }
            else if presentation.tone == .hollow { Circle().strokeBorder(lineWidth: 1).frame(width: 6, height: 6) }
            else { Circle().fill().frame(width: 6, height: 6) }
        }.foregroundStyle(color).accessibilityLabel(presentation.title)
    }
}

struct DeviceTooltipContent: View {
    let presentation: DeviceRoutePresentation
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                WorkbenchIcon(symbol: presentation.symbol ?? "cloud")
                Text(presentation.title).font(.system(size: 13, weight: .medium))
            }
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(presentation.rows.enumerated()), id: \.offset) { _, row in
                    HStack(spacing: 6) {
                        WorkbenchIcon(symbol: row.icon).opacity(0.7)
                        Text(row.text).lineLimit(1)
                    }
                }
            }.font(.system(size: 11)).foregroundStyle(Design.muted)
        }.frame(maxWidth: 284, alignment: .leading).fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 8).padding(.vertical, 4).foregroundStyle(Design.color(0xfafafa))
            .background(Design.color(0x1b1b1b), in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.white.opacity(0.15), lineWidth: 1))
    }
}
