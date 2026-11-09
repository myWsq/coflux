import CofluxClientCore
import CofluxProtocol
import SwiftUI

/// 设备 tab（plan 077 → Duo redesign, mockup O7）：one card per device — OS icon, name, terminal
/// count, online state, RTT and platform; offline devices are dimmed below "离线". A card opens the
/// device's terminal page (its directory workspace), which is the same terminal page as a
/// workspace's. RTT/路径只在本页在场时测量（retainDeviceMeasure，onAppear 起 onDisappear 停，不常驻耗电）。
struct DevicesView: View {
    let client: CofluxClient

    private func sorted(_ daemons: [Coflux_V1_DaemonInfo]) -> [Coflux_V1_DaemonInfo] {
        daemons.sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
    }

    private var online: [Coflux_V1_DaemonInfo] {
        sorted(client.daemons.filter(\.online))
    }

    private var offline: [Coflux_V1_DaemonInfo] {
        sorted(client.daemons.filter { !$0.online })
    }

    private var subtitle: String {
        offline.isEmpty ? "\(online.count) 台在线" : "\(online.count) 台在线 · \(offline.count) 台离线"
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                ForEach(online, id: \.daemonID) { daemon in
                    deviceLink(daemon)
                }
                if !offline.isEmpty {
                    Text("离线")
                        .font(Theme.Fonts.label.weight(.semibold))
                        .foregroundStyle(Theme.mutedForeground)
                        .padding(.horizontal, 6)
                        .padding(.top, online.isEmpty ? 0 : 10)
                    ForEach(offline, id: \.daemonID) { daemon in
                        deviceLink(daemon)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 4)
            .padding(.bottom, 24)
        }
        .scrollIndicators(.hidden)
        .background(Theme.background)
        .overlay {
            if client.daemons.isEmpty {
                ContentUnavailableView(
                    "暂无设备",
                    systemImage: "macbook.and.iphone",
                    description: Text("在电脑上安装 cofluxd 并完成授权后会显示在这里")
                )
            }
        }
        .navigationTitle("设备")
        .navigationSubtitle(client.daemons.isEmpty ? "" : subtitle)
        .navigationBarTitleDisplayMode(.large)
        // 页面以 daemonID 寻址，不把 DaemonInfo 捕获成值——设备会下线、改名、被移除。
        .navigationDestination(for: DeviceRoute.self) { route in
            DeviceSessionsView(client: client, daemonID: route.daemonID)
        }
        .measuresDevices(client: client)
    }

    // MARK: - Card

    private func deviceLink(_ daemon: Coflux_V1_DaemonInfo) -> some View {
        NavigationLink(value: DeviceRoute(daemonID: daemon.daemonID)) {
            deviceCard(daemon)
        }
        .buttonStyle(.plain)
        // 长按复制设备标识（plan 20260914）：整卡可点是短按，长按不抢它。
        .copyHandleContextMenu(.device, id: daemon.daemonID)
    }

    private func deviceCard(_ daemon: Coflux_V1_DaemonInfo) -> some View {
        let rtt = daemon.online ? client.deviceTransports[daemon.daemonID]?.rttMs : nil
        let running = client.deviceRunningTerminalCount(daemon.daemonID)
        return HStack(spacing: 12) {
            Image(systemName: devicePlatformSymbol(daemon.platform))
                .font(.system(size: 20))
                .foregroundStyle(daemon.online ? Theme.foreground : Theme.mutedForeground)
                .frame(width: 50, height: 50)
                .background(Theme.accentSurface, in: RoundedRectangle(cornerRadius: 16))
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(daemon.name.isEmpty ? daemon.host : daemon.name)
                        .font(Theme.Fonts.rowTitle)
                        .foregroundStyle(Theme.foreground)
                        .lineLimit(1)
                    if running > 0 {
                        Text("\(running) 个终端")
                            .font(Theme.Fonts.meta)
                            .foregroundStyle(Theme.subtleForeground)
                            .lineLimit(1)
                    }
                }
                HStack(spacing: 10) {
                    // 色只表延迟、形只表状态（桌面 2026-07-26 原则）：在线实心点、离线空心环。
                    HStack(spacing: 5) {
                        if daemon.online {
                            Circle().fill(deviceRTTTone(rtt)).frame(width: 7, height: 7)
                            Text("在线")
                        } else {
                            Circle().stroke(Theme.mutedForeground, lineWidth: 1.2).frame(width: 7, height: 7)
                            Text("离线")
                        }
                    }
                    if let rtt {
                        Text("\(Int(rtt.rounded())) ms")
                            .font(Theme.Fonts.label.monospaced().monospacedDigit())
                            .foregroundStyle(deviceRTTTone(rtt))
                    }
                    Text(platformLabel(daemon.platform))
                        .lineLimit(1)
                }
                .font(Theme.Fonts.label)
                .foregroundStyle(Theme.mutedForeground)
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.right")
                .font(Theme.Fonts.label.weight(.semibold))
                .foregroundStyle(Theme.subtleForeground)
        }
        .padding(14)
        .contentShape(Rectangle())
        .cardBackground()
        .opacity(daemon.online ? 1 : 0.55)
    }

    private func platformLabel(_ platform: String) -> String {
        let lower = platform.lowercased()
        if lower.contains("darwin") || lower.contains("mac") { return "macOS" }
        if lower.contains("linux") { return "Linux" }
        if lower.contains("windows") { return "Windows" }
        return platform
    }
}

// MARK: - Shared with the sidebar's 设备 section

extension CofluxClient {
    /// 只数这台设备 canonical 目录工作区里的 RUNNING 任务：点进去看到的就是这些，数字必须和
    /// 页面一致。按 daemonID 统计会把项目工作区的终端也算进来。
    func deviceRunningTerminalCount(_ daemonID: String) -> Int {
        guard let workspace = canonicalDirWorkspace(daemonID: daemonID, in: workspaces) else { return 0 }
        return tasks.filter { $0.workspaceID == workspace.id && $0.status == .running }.count
    }
}

func devicePlatformSymbol(_ platform: String) -> String {
    let lower = platform.lowercased()
    if lower.contains("darwin") || lower.contains("mac") { return "laptopcomputer" }
    if lower.contains("linux") { return "server.rack" }
    return "desktopcomputer"
}

/// 与桌面同档（sidebar.tsx RTT_GOOD_MS）：< 200ms 绿、≥ 200ms 黄；未测到为灰。
func deviceRTTTone(_ rtt: Double?) -> Color {
    guard let rtt else { return Theme.mutedForeground }
    return rtt < 200 ? Theme.success : Theme.warning
}

extension View {
    /// Measures RTT and route to every online device while this view is on screen (plan 077):
    /// started on appear, released on disappear or when a device goes offline — never resident.
    func measuresDevices(client: CofluxClient) -> some View {
        modifier(DeviceMeasures(client: client))
    }
}

private struct DeviceMeasures: ViewModifier {
    let client: CofluxClient
    /// 每台在线设备一个测量持有的释放闭包；页面离开或设备下线时释放。
    @State private var releases: [String: @MainActor () -> Void] = [:]

    private var onlineIDs: Set<String> {
        Set(client.daemons.filter(\.online).map(\.daemonID))
    }

    func body(content: Content) -> some View {
        content
            .onAppear { sync() }
            .onChange(of: onlineIDs) { sync() }
            .onDisappear {
                for release in releases.values { release() }
                releases.removeAll()
            }
    }

    private func sync() {
        let online = onlineIDs
        for (daemonID, release) in releases where !online.contains(daemonID) {
            release()
            releases[daemonID] = nil
        }
        for daemonID in online where releases[daemonID] == nil {
            releases[daemonID] = client.retainDeviceMeasure(daemonID: daemonID)
        }
    }
}
