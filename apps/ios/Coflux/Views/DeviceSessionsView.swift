import CofluxClientCore
import CofluxProtocol
import SwiftUI

/// 设备级会话页（plan 20260914）：设备面板某一行点进来的二级页，承载这台设备
/// **目录工作区**（projectID 为空、根在 daemon 用户 HOME）的任务台。桌面端同一
/// 语义在 workbench.tsx 的 device 选中分支。
///
/// 页面以 daemonID 寻址，设备与工作区都在每次 render 时从 client 活状态解析、
/// 一律不捕获成值：目录工作区可能被桌面端删除、设备可能下线/改名/被移除，
/// 捕获值会让本页对着一台已经不存在的设备继续给出可点的「新建终端」。
struct DeviceSessionsView: View {
    let client: CofluxClient
    let daemonID: String

    /// 首次开终端的忙态：HOME 解析走 elevated 通道、冷链路可能要数秒，
    /// 与设备面板的测量通道无关，忙态必须是本页自己的。
    @State private var creating = false
    /// 本页自己渲染的失败文案。client.lastError 在 iOS 侧没有任何视图消费，
    /// 不落到这里就等于把用户留在一个永远转圈的按钮上。
    @State private var createError: String?
    /// 发起前的 lastError.id 基线：server 的拒绝（「终端目录路径为空」/
    /// 「daemon 不在线或不属于本账号」）走 error 广播而非抛错，只能靠 id 变化识别
    /// （桌面 workbench.tsx:470-473 同装置）。
    @State private var errorBaseline: Int?
    /// 发起前的全量已知 task id：canonical 工作区出现后据此认出「本页这次创建
    /// 产生的那个任务」并启动它。既存的 IDLE 任务、它端建的任务不在此列，
    /// 保留各自的手动「启动」横幅。
    @State private var knownTaskIDsBeforeCreate: Set<String>?

    /// 设备名回退与设备面板同规则（DevicesView 行标题）：name 为空退到 host。
    private var daemon: Coflux_V1_DaemonInfo? {
        client.daemons.first { $0.daemonID == daemonID }
    }

    private var workspace: Coflux_V1_Workspace? {
        canonicalDirWorkspace(daemonID: daemonID, in: client.workspaces)
    }

    private var deviceName: String {
        guard let daemon else { return "设备" }
        return daemon.name.isEmpty ? daemon.host : daemon.name
    }

    /// 目录工作区当前的任务 id（创建序）：自建任务的识别只看这一份增量。
    private var workspaceTaskIDs: [String] {
        guard let workspace else { return [] }
        return client.tasks
            .filter { $0.workspaceID == workspace.id }
            .sorted { $0.createdAt < $1.createdAt }
            .map(\.id)
    }

    var body: some View {
        Group {
            if let workspace {
                // 终端页原样复用（翻页 / dock / 按键面板 / 对讲 / 窗口归属全部照旧）。
                // .id 绑工作区：目录工作区被删后又新建时，结构位置不变会让
                // 旧 deck 的 activeTaskID 等实例状态被复用到另一个工作区上。
                // 标题由 deck 自己按「目录工作区用设备名」解析，本页不再设，
                // 免得两处 navigationTitle 互相盖。
                WorkspaceDetailView(client: client, workspace: workspace)
                    .id(workspace.id)
            } else {
                emptyState
                    .navigationTitle(deviceName)
                    .navigationBarTitleDisplayMode(.inline)
                    .sidebarToggleItem(client: client)
            }
        }
        // 目录工作区到达 = 创建成功的完成信号（terminalCreate 无请求-响应关联，
        // 工作区与任务在 server 同一事务里建出）。
        .onChange(of: workspace?.id) { _, id in
            guard id != nil else { return }
            creating = false
            createError = nil
        }
        // server 把工作区和任务放在同一事务，但广播可能分两帧到；等任务 id 增量
        // 出现再启动，避免对着空工作区空发 taskStart。
        .onChange(of: workspaceTaskIDs) { _, ids in
            guard let known = knownTaskIDsBeforeCreate else { return }
            guard let mine = ids.first(where: { !known.contains($0) }) else { return }
            knownTaskIDsBeforeCreate = nil
            creating = false
            // server 建出的任务是 IDLE：不补这发，用户点完「新建终端」会落在
            // 「任务尚未启动」横幅前，而不是一个能用的终端。cols/rows 用任务台
            // 的默认 80×24（deck 自建任务路径同值）。
            client.startTask(taskID: mine, cols: 80, rows: 24)
        }
        .onChange(of: client.lastError?.id) { _, id in
            guard creating, id != errorBaseline else { return }
            creating = false
            knownTaskIDsBeforeCreate = nil
            createError = client.lastError?.message ?? "新建终端失败"
        }
    }

    // MARK: - 空态（这台设备还没有目录工作区）

    @ViewBuilder
    private var emptyState: some View {
        if let daemon {
            ContentUnavailableView {
                Label {
                    Text("在「\(deviceName)」上新建终端")
                } icon: {
                    Image("square-terminal")
                        .resizable()
                        .scaledToFit()
                        .frame(width: 42, height: 42)
                }
            } description: {
                Text(daemon.online ? "终端将在该设备的主目录中打开" : "设备离线，上线后才能新建终端")
            } actions: {
                Button {
                    createTerminal()
                } label: {
                    if creating {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text("新建终端")
                        }
                    } else {
                        Text("新建终端")
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.primary)
                .foregroundStyle(Theme.primaryForeground)
                .disabled(!daemon.online || creating)
                if let createError {
                    Text(createError)
                        .font(Theme.Fonts.label)
                        .foregroundStyle(Theme.destructive)
                        .multilineTextAlignment(.center)
                }
            }
            .background(Theme.background)
        } else {
            // 设备已被移除（daemonRemoved 会连带删掉它的工作区与任务）：
            // 没有可寻址的设备就不给创建入口，否则点下去只会换回 server 的
            //「daemon 不在线或不属于本账号」。
            ContentUnavailableView(
                "设备不可用",
                systemImage: "exclamationmark.triangle",
                description: Text("这台设备已不在当前账号中")
            )
            .background(Theme.background)
        }
    }

    // MARK: - 首次开终端

    /// 先经设备浏览通道把 `~` 解析成 HOME 绝对路径，再发 terminalCreate；
    /// `~` 绝不外发——server 对 TerminalCreate.path 不做任何展开，原样落成工作区路径。
    private func createTerminal() {
        guard let daemon, daemon.online, !creating else { return }
        creating = true
        createError = nil
        errorBaseline = client.lastError?.id
        knownTaskIDsBeforeCreate = Set(client.tasks.map(\.id))
        let targetID = daemon.daemonID
        Task {
            do {
                let listed = try await client.listDeviceDirectory(daemonID: targetID, path: "~")
                // FsListed 的失败是带内的：ok=false 或 path 缺失时继续发，
                // 只会换来 server 的「终端目录路径为空」。
                guard listed.ok, listed.hasPath, !listed.path.isEmpty else {
                    let reason = listed.hasError && !listed.error.isEmpty ? listed.error : "无法获取设备的主目录"
                    failCreate(reason)
                    return
                }
                var create = Coflux_V1_TerminalCreate()
                create.daemonID = targetID
                create.path = listed.path
                guard client.sendWorkbenchCommand(.terminalCreate(create)) else {
                    failCreate(client.lastError?.message ?? "无法发送新建终端请求")
                    return
                }
                // 成功不在此处判定：等 canonical 目录工作区出现（或 lastError 变化）。
            } catch {
                failCreate(error.localizedDescription)
            }
        }
    }

    private func failCreate(_ message: String) {
        creating = false
        knownTaskIDsBeforeCreate = nil
        createError = message
    }
}
