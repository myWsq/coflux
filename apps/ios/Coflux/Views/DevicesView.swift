import CofluxClientCore
import CofluxProtocol
import SwiftUI

/// 设备面板（plan 077）：机群的健康（在线+RTT）、路径（relay 节点）、版本与身份一页扫完。
/// 行三层，无详情页——机群个位数规模，点进二级页面反而把「扫一眼」变成「逐台点开」。
/// RTT/节点只在本页在场时测量（retainDeviceMeasure，onAppear 起 onDisappear 停，不常驻耗电）。
struct DevicesView: View {
    let client: CofluxClient

    /// 每台在线设备一个测量持有的释放闭包；页面离开或设备下线时释放。
    @State private var measureReleases: [String: @MainActor () -> Void] = [:]

    /// 与 web 同档（sidebar.tsx RTT_GOOD_MS）：< 200ms 绿、≥ 200ms 黄。
    private static let rttGoodMS = 200.0

    private var sortedDaemons: [Coflux_V1_DaemonInfo] {
        client.daemons.sorted {
            if $0.online != $1.online { return $0.online }
            return $0.name.localizedCompare($1.name) == .orderedAscending
        }
    }

    private var onlineIDs: Set<String> {
        Set(client.daemons.filter(\.online).map(\.daemonID))
    }

    var body: some View {
        List {
            ForEach(sortedDaemons, id: \.daemonID) { daemon in
                deviceRow(daemon)
                    .listRowInsets(EdgeInsets(top: 12, leading: 20, bottom: 12, trailing: 20))
                    .listRowBackground(Theme.background)
                    .listRowSeparatorTint(Theme.border)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .overlay {
            if client.daemons.isEmpty {
                ContentUnavailableView(
                    "暂无设备",
                    systemImage: "macbook.and.iphone",
                    description: Text("在机器上安装 cofluxd 并完成授权后此处会出现")
                )
            }
        }
        .navigationTitle("设备")
        .navigationBarTitleDisplayMode(.large)
        .onAppear { syncMeasures() }
        .onChange(of: onlineIDs) { syncMeasures() }
        .onDisappear { releaseAllMeasures() }
    }

    // MARK: - 行（三层：名称+状态+RTT / host·platform / 路径+版本）

    private func deviceRow(_ daemon: Coflux_V1_DaemonInfo) -> some View {
        let transport = client.deviceTransports[daemon.daemonID]
        let rtt = daemon.online ? transport?.rttMs : nil
        return HStack(alignment: .top, spacing: 14) {
            Image(systemName: platformSymbol(daemon.platform))
                .font(.system(size: 17))
                .foregroundStyle(Theme.mutedForeground)
                .frame(width: 26)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(daemon.name.isEmpty ? daemon.host : daemon.name)
                        .font(Theme.Fonts.body.weight(.medium))
                        .foregroundStyle(daemon.online ? Theme.foreground : Theme.mutedForeground)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    // 色只表延迟、形只表状态（web 2026-07-26 原则）：在线实心点、离线空心环。
                    if daemon.online {
                        Circle().fill(rttTone(rtt)).frame(width: 7, height: 7)
                        if let rtt {
                            Text("\(Int(rtt.rounded())) ms")
                                .font(Theme.Fonts.label.monospacedDigit())
                                .foregroundStyle(rttTone(rtt))
                        }
                    } else {
                        Circle().stroke(Theme.mutedForeground, lineWidth: 1.2).frame(width: 7, height: 7)
                    }
                }
                Text("\(daemon.host) · \(daemon.platform)")
                    .font(Theme.Fonts.label)
                    .foregroundStyle(Theme.mutedForeground)
                    .lineLimit(1)
                thirdLine(daemon, transport: transport)
            }
        }
        .opacity(daemon.online ? 1 : 0.72)
    }

    @ViewBuilder
    private func thirdLine(_ daemon: Coflux_V1_DaemonInfo, transport: CofluxClient.DeviceTransportInfo?) -> some View {
        HStack(spacing: 8) {
            if daemon.online {
                // iOS 现阶段恒 relay（云）；transport 三分语汇与 web 同套，P2P/direct 枚举留给后续立项。
                HStack(spacing: 4) {
                    Image(systemName: "cloud.fill").font(.system(size: 9))
                    Text(relayNodeLabel(transport?.relayHost))
                }
                .font(Theme.Fonts.meta)
                .foregroundStyle(Theme.mutedForeground)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(Theme.secondarySurface, in: Capsule())
            } else {
                Text("离线")
                    .font(Theme.Fonts.meta)
                    .foregroundStyle(Theme.subtleForeground)
            }
            if !daemon.workerVersion.isEmpty {
                Text(versionLabel(daemon))
                    .font(Theme.Fonts.meta.monospacedDigit())
                    .foregroundStyle(daemon.online ? Theme.mutedForeground : Theme.subtleForeground)
                    .lineLimit(1)
            }
        }
        .padding(.top, 2)
    }

    private func platformSymbol(_ platform: String) -> String {
        let lower = platform.lowercased()
        if lower.contains("darwin") || lower.contains("mac") { return "laptopcomputer" }
        if lower.contains("linux") { return "server.rack" }
        return "desktopcomputer"
    }

    private func rttTone(_ rtt: Double?) -> Color {
        guard let rtt else { return Theme.mutedForeground }
        return rtt < Self.rttGoodMS ? Theme.success : Theme.warning
    }

    /// relay 节点短名：host 首段（relay-bj.coflux.… → relay-bj）；lane 未建时占位。
    private func relayNodeLabel(_ host: String?) -> String {
        guard let host, !host.isEmpty else { return "relay …" }
        return host.split(separator: ".").first.map(String.init) ?? host
    }

    private func versionLabel(_ daemon: Coflux_V1_DaemonInfo) -> String {
        daemon.supervisorVersion.isEmpty
            ? daemon.workerVersion
            : "\(daemon.workerVersion) · sup \(daemon.supervisorVersion)"
    }

    // MARK: - 测量生命周期

    private func syncMeasures() {
        let online = onlineIDs
        for (daemonID, release) in measureReleases where !online.contains(daemonID) {
            release()
            measureReleases[daemonID] = nil
        }
        for daemonID in online where measureReleases[daemonID] == nil {
            measureReleases[daemonID] = client.retainDeviceMeasure(daemonID: daemonID)
        }
    }

    private func releaseAllMeasures() {
        for release in measureReleases.values { release() }
        measureReleases.removeAll()
    }
}
