import CofluxClientCore
import CofluxProtocol
import SwiftUI

/// 设备 tab of the compact layout (plan 077; reads like the inner display's sidebar since
/// 2026-11-10): one header "设备 · N 台在线" and a row per device (`DeviceRowContent`), online first,
/// no page title. A row opens the device's terminal page (its directory workspace), which is the
/// same terminal page as a workspace's. RTT/路径只在本页在场时测量（measuresDevices，不常驻耗电）。
struct DevicesView: View {
    let client: CofluxClient

    /// Online devices first, then by name.
    private var sorted: [Coflux_V1_DaemonInfo] {
        client.daemons.sorted { lhs, rhs in
            if lhs.online != rhs.online { return lhs.online }
            return lhs.name.localizedCompare(rhs.name) == .orderedAscending
        }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if !client.daemons.isEmpty {
                    HomeSectionHeader(title: "设备", detail: "\(client.daemons.filter(\.online).count) 台在线")
                        .padding(.horizontal, 16)
                        .padding(.top, 16)
                        .padding(.bottom, 4)
                }
                ForEach(sorted, id: \.daemonID) { daemon in
                    NavigationLink(value: DeviceRoute(daemonID: daemon.daemonID)) {
                        DeviceRowContent(client: client, daemon: daemon)
                            .padding(.leading, 16)
                            .padding(.trailing, 14)
                            .padding(.vertical, 9)
                    }
                    .buttonStyle(.plain)
                    // 长按复制设备标识（plan 20260914）：整行可点是短按，长按不抢它。
                    .copyHandleContextMenu(.device, id: daemon.daemonID)
                }
            }
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
        // Named for the back button and VoiceOver; not drawn.
        .navigationTitle("设备")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(removing: .title)
        // 页面以 daemonID 寻址，不把 DaemonInfo 捕获成值——设备会下线、改名、被移除。
        .navigationDestination(for: DeviceRoute.self) { route in
            DeviceSessionsView(client: client, daemonID: route.daemonID)
        }
        .measuresDevices(client: client)
    }
}

// MARK: - Shared with the sidebar's 设备 section

/// A device row, the same in the inner display's sidebar and the outer display's 设备 page (as on
/// the desktop's sidebar): the OS mark with a dot whose colour is the latency (hollow when
/// offline), the name, and online · RTT · its terminals below. Offline rows are dimmed.
struct DeviceRowContent: View {
    let client: CofluxClient
    let daemon: Coflux_V1_DaemonInfo

    var body: some View {
        let rtt = daemon.online ? client.deviceTransports[daemon.daemonID]?.rttMs : nil
        let running = client.deviceRunningTerminalCount(daemon.daemonID)
        HStack(spacing: 10) {
            RoundedRectangle(cornerRadius: 26 * 0.32)
                .fill(Theme.accentSurface)
                .frame(width: 26, height: 26)
                .overlay {
                    Image(systemName: devicePlatformSymbol(daemon.platform))
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Theme.foreground)
                }
                .overlay(alignment: .topTrailing) {
                    Group {
                        if daemon.online {
                            Circle().fill(deviceRTTTone(rtt))
                        } else {
                            Circle().fill(Theme.card)
                                .overlay(Circle().strokeBorder(Theme.mutedForeground, lineWidth: 1.2))
                        }
                    }
                    .frame(width: 26 * 0.34, height: 26 * 0.34)
                    .overlay(Circle().strokeBorder(Theme.card, lineWidth: 2).padding(-2))
                    .offset(x: 26 * 0.1, y: -26 * 0.1)
                }
            VStack(alignment: .leading, spacing: 2) {
                Text(daemon.name.isEmpty ? daemon.host : daemon.name)
                    .font(Theme.Fonts.rowTitle)
                    .foregroundStyle(Theme.foreground)
                    .lineLimit(1)
                line(rtt: rtt, running: running)
                    .font(Theme.Fonts.meta)
                    .foregroundStyle(Theme.mutedForeground)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
        .opacity(daemon.online ? 1 : 0.55)
    }

    private func line(rtt: Double?, running: Int) -> Text {
        guard daemon.online else { return Text("离线") }
        var line = Text("在线")
        if let rtt {
            line = line + Text(" · ") + Text("\(Int(rtt.rounded())) ms").foregroundStyle(deviceRTTTone(rtt))
        }
        if running > 0 {
            line = line + Text(" · \(running) 个终端")
        }
        return line
    }
}

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
