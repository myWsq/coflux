import AppKit
import CofluxClientCore
import CofluxProtocol
import SwiftUI

struct TerminalWorkspaceView: View {
    // macOS Menu 会读取 NSImage 的固有尺寸，忽略 SwiftUI label 上的 frame。
    private static let portMenuImage: NSImage = {
        let image = (NSImage(named: "router")?.copy() as? NSImage) ?? NSImage(size: NSSize(width: 12, height: 12))
        image.size = NSSize(width: 12, height: 12)
        image.isTemplate = true
        image.accessibilityDescription = "转发端口"
        return image
    }()
    @Bindable var model: WorkbenchModel
    @State private var completions = AgentCompletions()
    @State private var hoveredTab: String?
    @FocusState private var focusedCloseTab: String?
    private var completionInput: AgentCompletionInput {
        let visible = model.showingChanges.contains(model.workspace?.id ?? "") ? nil : model.activeTask?.sessionID
        return AgentCompletionInput(entries: model.client.tasks.filter { $0.hasSessionID }.map {
            .init(sessionID: $0.sessionID, state: model.client.sessionAgents[$0.sessionID]?.session.state ?? "")
        }, visibleSessionID: visible)
    }
    private var selectedTabID: String? {
        guard let workspace = model.workspace else { return nil }
        if model.showingChanges.contains(workspace.id) { return "changes." + workspace.id }
        if model.selectedPendingTerminal != nil { return "pending." + workspace.id }
        return model.activeTask?.id
    }
    var body: some View {
        VStack(spacing: 0) {
            if let workspace = model.workspace {
                header(workspace)
            }
            ZStack {
                Design.terminal
                // 稳定 task ID 保留 TerminalView；隐藏不注销 consumer、不丢 scrollback。
                ForEach(model.client.tasks.filter { model.visitedTasks.contains($0.id) }, id: \.id) { task in
                    let active = task.id == model.activeTask?.id && !model.showingChanges.contains(task.workspaceID)
                    NativeTerminal(client: model.client, task: task, active: active,
                                   activationRequest: model.activationRequests[task.id, default: 0],
                                   onTitle: { session, title in model.terminalTitles[session] = title },
                                   onUploadState: { busy in
                                       if busy { model.uploadingTasks.insert(task.id) } else { model.uploadingTasks.remove(task.id) }
                                   }, onDragState: { over in
                                       if over { model.draggingTasks.insert(task.id) } else { model.draggingTasks.remove(task.id) }
                                   })
                        // 对齐 xterm 容器 pl-3 pt-2 pb-3；缩小实际表面，行列数随可用面积计算。
                        .padding(.leading, 12).padding(.top, 8).padding(.bottom, 12)
                        .opacity(active ? 1 : 0).allowsHitTesting(active).accessibilityHidden(!active)
                }
                ForEach(model.client.workspaces.filter { model.visitedChanges.contains($0.id) }, id: \.id) { workspace in
                    let visible = model.workspace?.id == workspace.id && model.showingChanges.contains(workspace.id)
                    ChangesView(client: model.client, workspace: workspace, active: visible,
                                defaultBranch: model.client.projects.first { $0.id == workspace.projectID }?.defaultBranch ?? "")
                        .opacity(visible ? 1 : 0).allowsHitTesting(visible).accessibilityHidden(!visible)
                }
                if let pending = model.pendingWorkspace {
                    VStack(spacing: 0) {
                        ProgressView().controlSize(.small).frame(width: 20, height: 20)
                        Text("正在创建工作区「\(pending.branch)」")
                            .font(.system(size: 13, weight: .medium)).multilineTextAlignment(.center).padding(.top, 16)
                        Text("正在设备上准备 git worktree，完成后会自动切换过去。")
                            .font(.system(size: 12)).lineSpacing(6)
                            .foregroundStyle(Design.muted).multilineTextAlignment(.center).padding(.top, 6)
                    }.frame(maxWidth: 384).padding(24)
                } else if model.selectedPendingTerminal != nil && !model.showingChanges.contains(model.workspace?.id ?? "") {
                    VStack(spacing: 16) {
                        ProgressView().controlSize(.small)
                        Text("正在创建终端…").foregroundStyle(Design.muted)
                    }.accessibilityIdentifier("terminal.creating")
                } else if model.workspace == nil && model.selection == nil {
                    if model.client.snapshotRevision == 0 {
                        ProgressView().controlSize(.small).accessibilityLabel("正在加载工作区")
                    } else {
                        VStack(spacing: 0) {
                            WorkbenchIcon(symbol: "folder-git-2", size: 20).foregroundStyle(Design.muted)
                                .frame(width: 40, height: 40)
                                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Design.border))
                                .padding(.bottom, 16)
                            Text(model.client.projects.isEmpty ? "从一个项目开始" : "选择一个工作区")
                                .font(.system(size: 13, weight: .medium))
                            Text(model.client.projects.isEmpty ? "导入在线设备上的 git 仓库，主工作区会自动创建。" : "从左侧项目或子工作区进入终端工作台。")
                                .font(.system(size: 12)).lineSpacing(6).foregroundStyle(Design.muted)
                                .multilineTextAlignment(.center).padding(.top, 6)
                            if model.client.projects.isEmpty {
                                Button("导入项目") { model.dialog = .importProject }
                                    .buttonStyle(WorkbenchPrimaryButtonStyle()).padding(.top, 20)
                                    .accessibilityIdentifier("onboarding.import")
                            }
                        }.frame(maxWidth: 384).padding(24)
                    }
                } else if model.activeTask == nil && !model.showingChanges.contains(model.workspace?.id ?? "") {
                    VStack(spacing: 12) {
                        WorkbenchIcon(symbol: "terminal", size: 20).foregroundStyle(Design.muted)
                            .frame(width: 40, height: 40)
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Design.border))
                        if model.workspace != nil {
                            VStack(spacing: 0) {
                                Text(model.workspace?.projectID.isEmpty == true ? "这台设备还没有终端" : "这个工作区还没有终端")
                                    .font(.system(size: 13, weight: .medium))
                                Text("创建后会立即启动 shell，并作为一个新 Tab 打开。也可以按 ⌘T 快速新建。")
                                    .font(.system(size: 12)).lineSpacing(6)
                                    .foregroundStyle(Design.muted).multilineTextAlignment(.center)
                                    .frame(maxWidth: 384).padding(.top, 6)
                                Button { model.createTerminal() } label: {
                                    HStack(spacing: 6) {
                                        WorkbenchIcon(symbol: "plus", size: 14)
                                        Text("新建终端")
                                    }
                                }.buttonStyle(WorkbenchPrimaryButtonStyle(isLoading: model.creatingTerminal))
                                    .accessibilityLabel(model.creatingTerminal ? "正在创建终端" : "新建终端")
                                    .disabled(model.creatingTerminal).padding(.top, 20)
                            }.padding(.top, 4)
                        } else if case .device(let id) = model.selection,
                                  let daemon = model.client.daemons.first(where: { $0.daemonID == id }) {
                            VStack(spacing: 0) {
                                Text("在「\(daemon.name)」上开一个终端").font(.system(size: 13, weight: .medium))
                                Text(daemon.online ? "终端会打开在这台设备的 HOME 目录，之后可以在顶栏继续开更多 Tab。"
                                     : "设备当前离线，上线后才能新建终端。")
                                    .font(.system(size: 12)).lineSpacing(6)
                                    .foregroundStyle(Design.muted).multilineTextAlignment(.center)
                                    .frame(maxWidth: 384).padding(.top, 6)
                                Button { Task { await model.createDeviceTerminal(id) } } label: {
                                    HStack(spacing: 6) {
                                        WorkbenchIcon(symbol: "plus", size: 14)
                                        Text("新建终端")
                                    }
                                }.buttonStyle(WorkbenchPrimaryButtonStyle(isLoading: model.creatingDeviceTerminals.contains(id)))
                                    .accessibilityLabel(model.creatingDeviceTerminals.contains(id) ? "正在创建终端" : "新建终端")
                                    .disabled(!daemon.online || model.creatingDeviceTerminals.contains(id))
                                    .accessibilityIdentifier("device.terminal.create").padding(.top, 20)
                                if let error = model.deviceTerminalErrors[id] {
                                    Text(error).font(.system(size: 12)).lineSpacing(6)
                                        .foregroundStyle(Design.destructive).multilineTextAlignment(.center)
                                        .frame(maxWidth: 384).padding(.top, 12)
                                }
                            }.padding(.top, 4)
                        } else {
                            Text("选择一个工作区")
                        }
                    }
                }
                if let task = model.activeTask, !model.showingChanges.contains(task.workspaceID) {
                    sessionStatus(task)
                    if model.draggingTasks.contains(task.id) {
                        Text("松开以上传文件到终端").padding(24)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .background(Design.warning.opacity(0.1))
                            .overlay(Rectangle().stroke(Design.warning.opacity(0.4))).padding(12).allowsHitTesting(false)
                    } else if model.uploadingTasks.contains(task.id) {
                        VStack { Spacer(); Text("正在上传文件…").padding(12).background(Design.panel) }.padding(12).allowsHitTesting(false)
                    }
                }
            }
        }.frame(maxWidth: .infinity, maxHeight: .infinity).background(Design.terminal)
            .onChange(of: completionInput, initial: true) { _, input in completions.update(input) }
    }

    private func header(_ workspace: Coflux_V1_Workspace) -> some View {
        HStack(spacing: 8) {
            if !workspace.projectID.isEmpty {
                Button { model.dialog = .switchBranch(workspace) } label: {
                    HStack(spacing: 6) {
                        if model.pendingBranches[workspace.id] != nil { ProgressView().controlSize(.mini) }
                        else { WorkbenchIcon(symbol: "arrow.branch") }
                        Text(model.pendingBranches[workspace.id] ?? workspace.branch).font(.system(size: 13)).lineLimit(1)
                    }.padding(.horizontal, 6).frame(height: 24)
                }.buttonStyle(WorkbenchButtonStyle()).disabled(model.pendingBranches[workspace.id] != nil)
                    .modifier(WorkbenchBranchPopover(model: model, target: .switchBranch(workspace)))
                Rectangle().fill(Design.border).frame(width: 1, height: 16)
            }
            ScrollViewReader { reader in
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 2) {
                        if !workspace.projectID.isEmpty {
                            Button { model.openChanges(workspace.id) } label: {
                                HStack(spacing: 6) {
                                    WorkbenchIcon(symbol: "file-diff")
                                    Text("变更")
                                    if workspace.additions > 0 || workspace.deletions > 0 {
                                        Text(verbatim: "+\(workspace.additions)").foregroundStyle(Design.success)
                                        Text(verbatim: "−\(workspace.deletions)").foregroundStyle(Design.destructive)
                                    }
                                }.font(.system(size: 13)).padding(.horizontal, 10).frame(minWidth: 96, minHeight: 28, alignment: .leading)
                            }.buttonStyle(WorkbenchButtonStyle(selected: model.showingChanges.contains(workspace.id)))
                                .id("changes." + workspace.id)
                        }
                        ForEach(model.workspaceTasks, id: \.id) { task in
                            let title = model.terminalTitles[task.sessionID].flatMap { $0.isEmpty ? nil : $0 }
                                ?? (task.title.isEmpty ? "终端" : task.title)
                            HStack(spacing: 0) {
                                Button { model.activate(task) } label: {
                                    HStack(spacing: 6) {
                                        if model.client.attachingTaskIDs.contains(task.id) {
                                            ProgressView().controlSize(.mini).frame(width: 12, height: 12)
                                        } else if model.client.detachedTaskIDs.contains(task.id) {
                                            Image("unplug").renderingMode(.template).resizable().frame(width: 12, height: 12).foregroundStyle(Design.warning)
                                        } else if let agent = model.client.sessionAgents[task.sessionID]?.session {
                                            AgentGlyph(agent: agent.agent, state: agent.state,
                                                       seen: completions.seen.contains(task.sessionID) || completionInput.visibleSessionID == task.sessionID)
                                                .opacity(task.id == model.activeTask?.id && !model.showingChanges.contains(workspace.id) ? 0.9 : 0.7)
                                        } else {
                                            WorkbenchIcon(symbol: "terminal").font(.system(size: 12))
                                                .opacity(task.id == model.activeTask?.id && !model.showingChanges.contains(workspace.id) ? 0.9 : 0.5)
                                        }
                                        if title != task.title && model.terminalTitles[task.sessionID]?.isEmpty == false {
                                            Text(title).lineLimit(1).workbenchTooltip(title, below: true)
                                        } else {
                                            Text(title).lineLimit(1)
                                        }
                                    }.padding(.horizontal, 10).frame(height: 28)
                                }.buttonStyle(WorkbenchPlainButtonStyle()).accessibilityIdentifier("tab.\(task.id)")
                                if let ports = model.client.ports[task.id], !ports.isEmpty {
                                    Menu {
                                        ForEach(ports, id: \.port) { port in
                                            Button(":\(String(port.port))") { openPreview(port) }
                                        }
                                    } label: { Image(nsImage: Self.portMenuImage) }
                                    .menuStyle(.borderlessButton).menuIndicator(.hidden)
                                    .frame(width: 20, height: 20).padding(.trailing, 2)
                                    .foregroundStyle(Design.muted)
                                    .accessibilityLabel("转发端口")
                                    .accessibilityIdentifier("ports.\(task.id)")
                                    .workbenchTooltip("转发端口")
                                }
                                Button { model.requestClose(task) } label: {
                                    WorkbenchIcon(symbol: "xmark", size: 12)
                                        .opacity(hoveredTab == task.id || focusedCloseTab == task.id ? 1 : 0)
                                        .frame(width: 20, height: 20).contentShape(Rectangle())
                                }.buttonStyle(WorkbenchButtonStyle())
                                    .focused($focusedCloseTab, equals: task.id)
                                    .accessibilityLabel("关闭终端")
                                    .accessibilityIdentifier("tab.close.\(task.id)")
                                    .workbenchTooltip("关闭终端 ⌘W").padding(.trailing, 2)
                            }.font(.system(size: 12))
                                .frame(maxWidth: 208)
                                .background(task.id == model.activeTask?.id && !model.showingChanges.contains(workspace.id)
                                            ? Design.accent : hoveredTab == task.id ? Design.accent.opacity(0.6) : .clear,
                                            in: RoundedRectangle(cornerRadius: 6))
                                .onHover { over in
                                    if over { hoveredTab = task.id }
                                    else if hoveredTab == task.id { hoveredTab = nil }
                                }
                        }
                        if let pending = model.pendingTerminals[workspace.id] {
                            Button { model.selectPendingTerminal(workspaceID: workspace.id) } label: {
                                HStack(spacing: 6) {
                                    ProgressView().controlSize(.mini)
                                    Text(pending.title).font(.system(size: 12)).lineLimit(1)
                                }.padding(.horizontal, 10).frame(height: 28)
                            }.buttonStyle(WorkbenchButtonStyle(selected: model.selectedPendingTerminal != nil && !model.showingChanges.contains(workspace.id)))
                                .frame(maxWidth: 208).accessibilityIdentifier("tab.pending.\(workspace.id)")
                                .id("pending." + workspace.id)
                        }
                        Button { model.createTerminal() } label: {
                            Group {
                                if model.creatingTerminal { ProgressView().controlSize(.mini) }
                                else { WorkbenchIcon(symbol: "plus", size: 14) }
                            }.frame(width: 24, height: 24)
                        }.buttonStyle(WorkbenchButtonStyle())
                            .opacity(model.creatingTerminal ? 0.5 : 1)
                            .disabled(model.creatingTerminal)
                            .accessibilityLabel(model.creatingTerminal ? "正在创建终端" : "新建终端 ⌘T")
                            .accessibilityIdentifier("terminal.create")
                            .workbenchTooltip("新建终端 ⌘T")
                    }
                }
                .task(id: selectedTabID) {
                    // 让本轮标签布局先提交；新建/恢复时 onChange 内立即滚动可能找不到目标。
                    // 仅选择改变时跟随，不因终端输出或标题更新抢回用户的手动滚动。
                    await Task.yield()
                    guard !Task.isCancelled, let target = selectedTabID else { return }
                    reader.scrollTo(target)
                }
            }
            if let task = model.activeTask, let ports = model.client.ports[task.id], !ports.isEmpty {
                HStack(spacing: 4) {
                    ForEach(ports, id: \.port) { port in
                        Button { openPreview(port) } label: {
                            HStack(spacing: 4) {
                                Text(":\(String(port.port))").font(.system(size: 11, design: .monospaced))
                                WorkbenchIcon(symbol: "external-link", size: 10)
                            }.padding(.horizontal, 6).frame(height: 20)
                        }.buttonStyle(WorkbenchButtonStyle())
                            .accessibilityLabel("打开端口 \(String(port.port))")
                    }
                }.fixedSize()
            }
        }.padding(.horizontal, 12).frame(height: 44).background(Design.background)
            .overlay(alignment: .bottom) { Rectangle().fill(Design.border).frame(height: 1) }
    }

    private func openPreview(_ port: Coflux_V1_PortPreview) {
        guard let url = URL(string: port.url), ["http", "https"].contains(url.scheme), url.host != nil else { return }
        NSWorkspace.shared.open(url)
    }

    @ViewBuilder private func sessionStatus(_ task: Coflux_V1_Task) -> some View {
        if model.client.detachedTaskIDs.contains(task.id) {
            VStack {
                HStack {
                    WorkbenchIcon(symbol: "unplug", size: 14)
                    Text("此终端已被其它客户端接管，当前输入已锁定。")
                    Spacer(minLength: 8)
                    Button("重新接管") {
                        model.activate(task)
                    }
                }.font(.system(size: 12)).foregroundStyle(Design.warning)
                    .padding(.horizontal, 16).padding(.vertical, 8).frame(maxWidth: .infinity)
                    .background(Design.warning.opacity(0.1))
                    .overlay(alignment: .bottom) { Rectangle().fill(Design.warning.opacity(0.2)).frame(height: 1) }
                Spacer()
            }
        } else if task.status == .exited {
            VStack {
                Spacer()
                HStack {
                    Text("进程已退出\(task.hasExitCode ? "（\(task.exitCode)）" : "")")
                    Button("重新启动") { model.activate(task) }
                }.font(.system(size: 12)).padding(8).frame(maxWidth: .infinity).background(Design.panel)
            }
        } else if model.client.blockedSessionIDs.contains(task.sessionID) {
            VStack {
                Text("正在等待终端确认输入…").font(.system(size: 12)).padding(8).background(Design.panel)
                Spacer()
            }
        }
    }
}
