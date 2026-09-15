import CofluxClientCore
import CofluxProtocol
import SwiftUI

/// 设备面板（plan 077）：机群的健康（在线+RTT）、路径（relay 节点）、版本与身份一页扫完。
/// 行三层的健康布局不变，但整行可点（plan 20260914）：进这台设备的设备级会话页。
/// 原「无详情页」的取舍挡的是把健康信息搬进二级页面，不该顺带挡住 iOS 唯一一条
/// 通往设备级终端（目录工作区）的入口。
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
                // 整行可点（行尾 chevron 由 NavigationLink 提供）；页面以 daemonID 寻址，
                // 不把 DaemonInfo 捕获成值——设备会下线、改名、被移除。
                NavigationLink {
                    DeviceSessionsView(client: client, daemonID: daemon.daemonID)
                } label: {
                    deviceRow(daemon)
                }
                // 长按复制设备标识（plan 20260914）：整行可点是短按，长按不抢它。
                .copyHandleContextMenu(.device, id: daemon.daemonID)
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

    private func thirdLine(_ daemon: Coflux_V1_DaemonInfo, transport: CofluxClient.DeviceTransportInfo?) -> some View {
        let running = runningSessionCount(daemon.daemonID)
        return HStack(spacing: 8) {
            if daemon.online {
                // 路径是实测出来的：direct/relay 来自 Tailcat 的 disco 探测，
                // 没有测量结果时如实说「未连接」，不冒充任何一种链路。
                HStack(spacing: 4) {
                    Image(systemName: pathSymbol(transport?.mode)).font(.system(size: 9))
                    Text(pathLabel(transport?.mode))
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
            Spacer(minLength: 8)
            // 运行中的设备级会话数：与项目列表的工作区行同一套词汇（绿点 + 数字，
            // WorkspaceListView:147-156）。落在第三行行尾而不是首行，是为了不和
            // 首行那颗「延迟色」的点挨在一起——两颗绿点连读会被当成同一件事。
            if running > 0 {
                HStack(spacing: 4) {
                    Circle()
                        .fill(Theme.success)
                        .frame(width: 6, height: 6)
                    Text("\(running)")
                        .font(Theme.Fonts.meta.monospacedDigit().weight(.semibold))
                }
                .foregroundStyle(Theme.success)
            }
        }
        .padding(.top, 2)
    }

    /// 只数这台设备 canonical 目录工作区里的 RUNNING 任务：点进去看到的就是这些，
    /// 数字必须和页面一致。按 daemonID 统计会把项目工作区的终端也算进来——
    /// 行上写 5、点开只有 1 个 tab，比不给数字更糟。
    private func runningSessionCount(_ daemonID: String) -> Int {
        guard let workspace = canonicalDirWorkspace(daemonID: daemonID, in: client.workspaces) else { return 0 }
        return client.tasks.filter { $0.workspaceID == workspace.id && $0.status == .running }.count
    }

    /// mode 的真相源是 DeviceRouter：direct/relay 为实测路径，unknown 表示通道已建成
    /// 但还没测出路径，probing 是正在建连，offline/nil 是当前没有通道。
    private func pathLabel(_ mode: String?) -> String {
        switch mode {
        case "direct": "直连"
        case "relay": "DERP 中转"
        case "unknown": "已连接"
        case "probing": "连接中"
        default: "未连接"
        }
    }

    private func pathSymbol(_ mode: String?) -> String {
        switch mode {
        case "direct": "bolt.horizontal.fill"
        case "relay": "arrow.triangle.swap"
        case "probing": "ellipsis"
        default: "cloud.fill"
        }
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
