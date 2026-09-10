import CofluxClientCore
import CofluxProtocol
import SwiftUI

struct SidebarView: View {
    @Bindable var model: WorkbenchModel
    @State private var hoveredProjectID: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var deviceContentHeight: CGFloat = 54
    var body: some View {
        GeometryReader { geometry in
          VStack(spacing: 0) {
            ScrollView {
                VStack(spacing: 2) {
                    HStack {
                        Text("项目").font(.system(size: 11)).foregroundStyle(Design.muted)
                        Spacer()
                        Button { model.dialog = .importProject } label: {
                            WorkbenchIcon(symbol: "folder.badge.plus", size: 14)
                                .frame(width: 24, height: 24).contentShape(Rectangle())
                        }
                        .buttonStyle(SidebarIconButtonStyle(hoverBackground: Design.accent, cornerRadius: 6))
                        .accessibilityLabel("导入项目")
                        .accessibilityIdentifier("project.import")
                        .workbenchTooltip("导入项目")
                    }.padding(.horizontal, 8).frame(height: 28).padding(.bottom, 4)
                    if model.client.snapshotRevision > 0 && model.client.projects.isEmpty {
                        Button { model.dialog = .importProject } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("还没有项目")
                                Text("导入在线设备上的 git 仓库开始使用").font(.system(size: 11)).foregroundStyle(Design.muted)
                            }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
                        }.buttonStyle(WorkbenchButtonStyle())
                    }
                    ForEach(model.client.projects, id: \.id) { project in
                        projectSection(project)
                    }
                }.padding(.horizontal, 8).padding(.top, 6).padding(.bottom, 12)
            }
            Rectangle().fill(Design.border).frame(height: 1)
            ScrollView {
              VStack(spacing: 2) {
                HStack {
                    Text("设备").font(.system(size: 11)).foregroundStyle(Design.muted)
                    Spacer()
                    SmallButton(symbol: "plus", label: "添加设备") { model.dialog = .enrollment }
                }
                    .padding(.horizontal, 8).frame(height: 28).padding(.bottom, 6)
                if model.client.daemons.isEmpty {
                    Button { model.dialog = .enrollment } label: {
                        HStack(spacing: 8) {
                            WorkbenchIcon(symbol: "desktopcomputer", size: 14)
                            Text("添加第一台设备")
                            Spacer(minLength: 0)
                        }.foregroundStyle(Design.muted).padding(.horizontal, 8).frame(height: 32)
                    }.buttonStyle(WorkbenchButtonStyle())
                        .accessibilityIdentifier("device.addFirst")
                }
                ForEach(model.client.daemons, id: \.daemonID) { daemon in
                    DeviceRow(model: model, daemon: daemon)
                }
              }.padding(.horizontal, 8).padding(.vertical, 10)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { deviceContentHeight = $0 }
            }.frame(height: min(deviceContentHeight, max(0, geometry.size.height * 0.42 - 1)))
          }
          .background(Design.panel)
        }
        // 先扣除窗口按钮区，再按实际可用高度分配项目和设备列表。
        .padding(.top, 28)
        .background(Design.panel)
    }

    private func projectSection(_ project: Coflux_V1_Project) -> some View {
        let collapsed = model.collapsedProjects.contains(project.id)
        let daemon = model.client.daemons.first { $0.daemonID == project.daemonID }
        let deviceWarning = daemon.map { "设备「\($0.name)」离线" } ?? "设备记录缺失"
        let projectDetails = [project.repoPath, daemon?.online == true ? "" : deviceWarning]
            .filter { !$0.isEmpty }.joined(separator: "\n")
        let workspaces = model.client.workspaces.filter { $0.projectID == project.id }.sorted {
            $0.isMain != $1.isMain ? $0.isMain : $0.createdAt < $1.createdAt
        }
        return VStack(spacing: 2) {
            HStack(spacing: 0) {
              Button {
                if collapsed { model.collapsedProjects.remove(project.id) }
                else { model.collapsedProjects.insert(project.id) }
            } label: {
                HStack(spacing: 8) {
                    WorkbenchIcon(symbol: hoveredProjectID == project.id ? (collapsed ? "chevron-right" : "chevron-down") : (collapsed ? "folder" : "folder.fill"), size: 14)
                        .font(.system(size: 13)).frame(width: 14, height: 14)
                    Text(project.name).lineLimit(1)
                    Spacer(minLength: 0)
                    if daemon?.online != true {
                        Circle().fill(Design.muted.opacity(0.4)).frame(width: 6, height: 6)
                            .accessibilityLabel(deviceWarning)
                            .accessibilityIdentifier("project.deviceWarning.\(project.id)")
                    }
                }.padding(.horizontal, 8).frame(height: 32).contentShape(Rectangle())
              }.buttonStyle(WorkbenchPlainButtonStyle()).accessibilityIdentifier("project.\(project.id)")
                  .help(projectDetails)
              ProjectCreateWorkspaceButton(model: model, project: project,
                                           rowHovered: hoveredProjectID == project.id)
            }
            // Web 的 hover:bg-accent/70 属于整行，必须覆盖右侧新建按钮和留白。
            .background {
                RoundedRectangle(cornerRadius: 6)
                    .fill(hoveredProjectID == project.id ? Design.accent.opacity(0.7) : .clear)
                    .animation(reduceMotion ? nil : .timingCurve(0.4, 0, 0.2, 1, duration: 0.15),
                               value: hoveredProjectID == project.id)
            }
            .contentShape(Rectangle())
            .onHover { hovering in
                if hovering { hoveredProjectID = project.id }
                else if hoveredProjectID == project.id { hoveredProjectID = nil }
            }.onDisappear {
                if hoveredProjectID == project.id { hoveredProjectID = nil }
            }.contextMenu {
                Button("新建工作区") { model.dialog = .createWorkspace(project) }
                Button("重命名") { model.dialog = .rename(.project, project.id, project.name) }
                Divider()
                Button("移除项目", role: .destructive) { model.dialog = .remove(.project, project.id, project.name) }
            }
            if !collapsed {
                VStack(spacing: 2) {
                    ForEach(workspaces, id: \.id) { workspace in
                        workspaceRow(workspace)
                    }
                    ForEach(model.pendingWorkspaces.filter { $0.projectID == project.id }) { pending in
                        Button { model.select(.workspace(pending.id)) } label: {
                            HStack(spacing: 8) {
                                ProgressView().controlSize(.mini)
                                Text(pending.branch).lineLimit(1)
                                Spacer(minLength: 0)
                            }.padding(.horizontal, 8).frame(height: 28)
                        }.buttonStyle(WorkbenchButtonStyle(selected: model.selection == .workspace(pending.id)))
                            .accessibilityLabel("正在创建工作区「\(pending.branch)」")
                    }
                }.padding(.leading, 6)
                    .overlay(alignment: .leading) { Rectangle().fill(Design.border).frame(width: 1) }
                    .padding(.leading, 12)
            }
        }
    }

    private func workspaceRow(_ workspace: Coflux_V1_Workspace) -> some View {
        let daemon = model.client.daemons.first { $0.daemonID == workspace.daemonID }
        let activity = WorkspaceActivity(workspaceID: workspace.id, online: daemon?.online ?? false,
                                         tasks: model.client.tasks, agents: model.client.sessionAgents)
        let details = activity.details(workspace: workspace,
                                       project: model.client.projects.first { $0.id == workspace.projectID }, daemon: daemon)
        return Button { model.select(.workspace(workspace.id)) } label: {
            HStack(spacing: 8) {
                if let state = activity.state { ActivityDots(state: state) }
                else {
                    WorkbenchIcon(symbol: "arrow.branch").font(.system(size: 12))
                        .foregroundStyle(workspace.isMain ? Design.warning : Design.muted)
                }
                Text(workspace.branch).lineLimit(1)
                Spacer(minLength: 0)
                if workspace.name != workspace.branch && !workspace.name.isEmpty {
                    Text(workspace.name).font(.system(size: 11)).foregroundStyle(Design.muted).lineLimit(1)
                } else if workspace.isMain {
                    Text("主工作区").font(.system(size: 11)).foregroundStyle(Design.muted)
                }
                if workspace.additions > 0 || workspace.deletions > 0 {
                    HStack(spacing: 3) {
                        Text(verbatim: "+\(workspace.additions)").foregroundStyle(Design.success)
                        Text(verbatim: "−\(workspace.deletions)").foregroundStyle(Design.destructive)
                    }.font(.system(size: 10, design: .monospaced))
                }
            }.padding(.horizontal, 8).frame(height: 28)
        }.buttonStyle(WorkbenchButtonStyle(selected: model.selection == .workspace(workspace.id)))
            .accessibilityIdentifier("workspace.\(workspace.id)")
            .accessibilityValue(activity.label)
            .accessibilityHint(details)
            .modifier(SidebarDetailTooltip(tooltip: WorkspaceTooltipContent(workspace: workspace,
                project: model.client.projects.first { $0.id == workspace.projectID }, daemon: daemon, activity: activity)))
            .modifier(SidebarRowAction(enabled: !workspace.isMain, symbol: "xmark", label: "删除工作区",
                                       identifier: "workspace.remove.\(workspace.id)", coversTrailingText: true) {
                model.dialog = .remove(.workspace, workspace.id, workspace.branch)
            })
            .contextMenu {
                Button("重命名") { model.dialog = .rename(.workspace, workspace.id, workspace.name) }
                if !workspace.isMain {
                    Divider()
                    Button("删除工作区", role: .destructive) { model.dialog = .remove(.workspace, workspace.id, workspace.branch) }
                }
            }
    }


}

/// 对齐 Web 项目行：保留按钮占位，仅在整行悬停、键盘聚焦或菜单打开时显现。
private struct ProjectCreateWorkspaceButton: View {
    @Bindable var model: WorkbenchModel
    let project: Coflux_V1_Project
    let rowHovered: Bool
    @FocusState private var focused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var visible: Bool {
        rowHovered || focused || model.dialog?.id == WorkbenchDialog.createWorkspace(project).id
    }

    var body: some View {
        Button { model.dialog = .createWorkspace(project) } label: {
            WorkbenchIcon(symbol: "plus", size: 12)
                .frame(width: 20, height: 20).contentShape(Rectangle())
        }
        .buttonStyle(SidebarIconButtonStyle())
        .focused($focused)
        .accessibilityLabel("新建工作区")
        .accessibilityIdentifier("project.createWorkspace.\(project.id)")
        .opacity(visible ? 1 : 0)
        .animation(reduceMotion ? nil : .timingCurve(0.4, 0, 0.2, 1, duration: 0.15), value: visible)
        .workbenchTooltip("新建工作区 ⌘N")
        // 浮层放在透明度修饰符外，关闭悬停不能隐藏已打开的菜单。
        .modifier(WorkbenchBranchPopover(model: model, target: .createWorkspace(project)))
        .padding(.trailing, 4)
    }
}

private struct DeviceRow: View {
    let model: WorkbenchModel
    let daemon: Coflux_V1_DaemonInfo
    @State private var releaseMeasure: (@MainActor () -> Void)?
    var body: some View {
        let transport = model.client.deviceTransports[daemon.daemonID]
        let presentation = DeviceRoutePresentation(daemon: daemon, transport: transport)
        let orphans = model.client.orphanSessions(daemonID: daemon.daemonID)
        Button { model.select(.device(daemon.daemonID)) } label: {
            HStack(spacing: 8) {
                DeviceRouteIndicator(presentation: presentation).frame(width: 12)
                WorkbenchIcon(symbol: "desktopcomputer").font(.system(size: 12)).foregroundStyle(Design.muted)
                Text(daemon.name).lineLimit(1)
                Spacer(minLength: 0)
                if !orphans.isEmpty {
                    Text("本地 \(orphans.count)").font(.system(size: 10)).foregroundStyle(Design.warning)
                        .padding(.horizontal, 4).background(Design.warning.opacity(0.1), in: RoundedRectangle(cornerRadius: 3))
                        .help("本机存在 \(orphans.count) 个中心 catalog 未登记的存活 session：" + orphans.map { $0.session.sessionID }.joined(separator: ", "))
                }
            }.padding(.trailing, 24).padding(.horizontal, 8).frame(height: 28)
        }.buttonStyle(WorkbenchButtonStyle(selected: model.selection == .device(daemon.daemonID)))
            .accessibilityIdentifier("device.\(daemon.daemonID)")
            .modifier(SidebarRowAction(enabled: true, symbol: "trash-2", label: "移除设备",
                                       identifier: "device.remove.\(daemon.daemonID)", coversTrailingText: false) {
                model.dialog = .remove(.device, daemon.daemonID, daemon.name)
            })
            .contextMenu {
                Button("重命名") { model.dialog = .rename(.device, daemon.daemonID, daemon.name) }
                Divider()
                Button("移除设备", role: .destructive) { model.dialog = .remove(.device, daemon.daemonID, daemon.name) }
            }
            .accessibilityHint(presentation.accessibilityDetails)
            .modifier(SidebarDetailTooltip(tooltip: DeviceTooltipContent(presentation: presentation)))
            .onAppear { measure() }.onChange(of: daemon.online) { _, _ in measure() }
            .onDisappear { releaseMeasure?(); releaseMeasure = nil }
    }
    private func measure() {
        releaseMeasure?()
        releaseMeasure = daemon.online ? model.client.retainDeviceMeasure(daemonID: daemon.daemonID) : nil
    }
}

/// 行尾动作与选择按钮独立；悬停或键盘聚焦时显示，点击只打开既有确认框。
private struct SidebarRowAction: ViewModifier {
    let enabled: Bool
    let symbol: String
    let label: String
    let identifier: String
    let coversTrailingText: Bool
    let action: () -> Void
    @State private var hovering = false
    @FocusState private var focused: Bool

    private var visible: Bool { hovering || focused }

    func body(content: Content) -> some View {
        if enabled {
            ZStack(alignment: .trailing) {
                content
                if coversTrailingText && visible {
                    LinearGradient(colors: [Design.accent.opacity(0), Design.accent, Design.accent],
                                   startPoint: .leading, endPoint: .trailing)
                        .frame(width: 44).allowsHitTesting(false).accessibilityHidden(true)
                }
                Button(action: action) {
                    WorkbenchIcon(symbol: symbol, size: 12)
                        .frame(width: 20, height: 20).contentShape(Rectangle())
                }.buttonStyle(SidebarIconButtonStyle())
                    .focused($focused)
                    .opacity(visible ? 1 : 0)
                    .accessibilityLabel(label).accessibilityIdentifier(identifier)
                    .workbenchTooltip(label)
                    .padding(.trailing, 4)
            }
                // 行尾渐变也必须受行圆角约束，不能把右上、右下角涂成方角。
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .background(hovering ? Design.accent : .clear, in: RoundedRectangle(cornerRadius: 6))
                .onHover { hovering = $0 }
        } else {
            content
        }
    }
}

/// 侧栏图标按钮默认灰色，悬停时显示各入口在 Web 中指定的背景与亮色图标。
private struct SidebarIconButtonStyle: ButtonStyle {
    var hoverBackground: Color = Design.color(0x1b1b1a)
    var cornerRadius: CGFloat = 4

    func makeBody(configuration: Configuration) -> some View {
        ActionContent(configuration: configuration, hoverBackground: hoverBackground, cornerRadius: cornerRadius)
    }

    private struct ActionContent: View {
        let configuration: Configuration
        let hoverBackground: Color
        let cornerRadius: CGFloat
        @State private var hovering = false
        @Environment(\.accessibilityReduceMotion) private var reduceMotion

        var body: some View {
            configuration.label
                .foregroundStyle(hovering || configuration.isPressed ? Design.foreground : Design.muted)
                .background(hovering || configuration.isPressed ? hoverBackground : .clear,
                            in: RoundedRectangle(cornerRadius: cornerRadius))
                .animation(reduceMotion ? nil : .timingCurve(0.4, 0, 0.2, 1, duration: 0.15), value: hovering)
                .onHover { hovering = $0 }
        }
    }
}
