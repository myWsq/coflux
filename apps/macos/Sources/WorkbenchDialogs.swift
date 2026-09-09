import AppKit
import CofluxProtocol
import SwiftUI

struct WorkbenchDialogView: View {
    let model: WorkbenchModel
    let dialog: WorkbenchDialog
    @State private var text = ""
    @State private var copiedInstallCommand = false
    @FocusState private var renameFocused: Bool
    private let installCommand = "npm i -g cofluxd && cofluxd up"
    private func removalLabel(_ entity: WorkbenchEntity) -> String {
        switch entity {
        case .project: "移除项目"
        case .workspace: "删除工作区"
        case .device: "移除设备"
        }
    }
    private func removalTitle(_ entity: WorkbenchEntity, name: String) -> String {
        "\(removalLabel(entity))「\(name)」？"
    }
    private func removalDescription(_ entity: WorkbenchEntity, name: String) -> String {
        switch entity {
        case .project: "项目记录和它的子工作区会从 coflux 中移除，主仓库本身不会被改动。此操作无法撤销。"
        case .workspace: "对应的 git worktree 目录会被移除，分支「\(name)」不会被自动删除。"
        case .device: "这台设备下的所有项目、工作区和终端记录会一并删除。若要再次接入，需要重新登记。"
        }
    }
    var body: some View {
        Group {
            switch dialog {
            case .importProject: ImportProjectView(model: model)
            case .createWorkspace(let project): CreateWorkspaceView(model: model, project: project)
            case .switchBranch(let workspace):
                if let project = model.client.projects.first(where: { $0.id == workspace.projectID }) {
                    CreateWorkspaceView(model: model, project: project, switching: workspace)
                }
            case .rename(let entity, let id, let original):
                VStack(spacing: 0) {
                    HStack(alignment: .top, spacing: 12) {
                        VStack(alignment: .leading, spacing: 0) {
                            Text(entity == .workspace ? "重命名" : entity == .device ? "重命名设备" : "重命名项目")
                                .fontWeight(.medium)
                            Text(renameSubtitle(entity, id: id, original: original))
                                .foregroundStyle(Design.color(0xa3a3a3)).fixedSize(horizontal: false, vertical: true)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                        SmallButton(symbol: "xmark", label: "关闭") { model.dialog = nil }
                    }.padding(.horizontal, 16).padding(.vertical, 13)
                    TextField(entity == .workspace ? "比如：重构登录页" : entity == .device ? "比如：家里的 MacBook Pro" : "比如：myWsq/coflux", text: $text)
                        .textFieldStyle(.plain).padding(.horizontal, 8).frame(height: 32)
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(renameFocused ? Design.foreground : Design.border))
                        .accessibilityLabel("名称").focused($renameFocused)
                        .onSubmit { model.rename(entity, id: id, name: text) }
                        .padding(.horizontal, 16)
                    HStack(spacing: 8) {
                        Spacer()
                        Button("取消") { model.dialog = nil }.keyboardShortcut(.cancelAction)
                            .buttonStyle(WorkbenchSecondaryButtonStyle())
                        Button("保存") { model.rename(entity, id: id, name: text) }
                            .buttonStyle(WorkbenchPrimaryButtonStyle(height: 32))
                            .keyboardShortcut(.defaultAction).disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && entity != .workspace)
                    }.padding(16)
                }.frame(width: 400).background(Design.color(0x262626)).onAppear {
                    let branch = model.client.workspaces.first(where: { $0.id == id })?.branch
                    text = entity == .workspace && original == branch ? "" : original
                    renameFocused = true
                }
            case .remove(let entity, let id, let name):
                WorkbenchConfirmationView(
                    title: removalTitle(entity, name: name),
                    message: removalDescription(entity, name: name),
                    confirmLabel: removalLabel(entity),
                    cancel: { model.dialog = nil },
                    confirm: { model.remove(entity, id: id) })
            case .enrollment:
                VStack(spacing: 0) {
                    HStack(alignment: .top, spacing: 12) {
                        VStack(alignment: .leading, spacing: 0) {
                            Text("添加设备").fontWeight(.medium)
                            Text("在要接入的机器上安装并启动 daemon，然后在浏览器里完成一次授权。")
                                .foregroundStyle(Design.color(0xa3a3a3)).fixedSize(horizontal: false, vertical: true)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                        SmallButton(symbol: "xmark", label: "关闭") { model.dialog = nil }
                    }.padding(.horizontal, 16).padding(.vertical, 13)
                    VStack(alignment: .leading, spacing: 12) {
                        Text("在新机器的终端中运行：").font(.system(size: 12))
                        HStack(alignment: .center, spacing: 8) {
                            Text(installCommand).font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            Button {
                                NSPasteboard.general.clearContents()
                                copiedInstallCommand = NSPasteboard.general.setString(installCommand, forType: .string)
                            } label: {
                                Image(systemName: copiedInstallCommand ? "checkmark" : "doc.on.doc")
                                    .font(.system(size: 12)).frame(width: 24, height: 24)
                            }.buttonStyle(WorkbenchButtonStyle())
                                .accessibilityLabel(copiedInstallCommand ? "已复制" : "复制")
                                .workbenchTooltip(copiedInstallCommand ? "已复制" : "复制")
                                .accessibilityIdentifier("enrollment.copy")
                        }.padding(12).background(Design.background, in: RoundedRectangle(cornerRadius: 6))
                        VStack(spacing: 8) {
                            WorkbenchIcon(symbol: "terminal", size: 20)
                            Text("daemon 启动后会打印一个授权链接，在任意设备的浏览器里打开它并确认，设备即上线。")
                                .fixedSize(horizontal: false, vertical: true).multilineTextAlignment(.center)
                        }.foregroundStyle(Design.color(0xa3a3a3)).frame(maxWidth: .infinity)
                    }.padding(.horizontal, 16)
                    HStack {
                        Spacer()
                        Button("完成") { model.dialog = nil }.keyboardShortcut(.defaultAction)
                            .buttonStyle(WorkbenchPrimaryButtonStyle(height: 32))
                    }.padding(16)
                }.frame(width: 480).background(Design.color(0x262626))
                    .onExitCommand { model.dialog = nil }
                    .task(id: copiedInstallCommand) {
                        guard copiedInstallCommand else { return }
                        do { try await Task.sleep(for: .seconds(2)) } catch { return }
                        copiedInstallCommand = false
                    }
            }
        }.font(.system(size: 13)).foregroundStyle(Design.foreground).background(Design.panel)
    }
    private func renameSubtitle(_ entity: WorkbenchEntity, id: String, original: String) -> String {
        switch entity {
        case .workspace:
            let branch = model.client.workspaces.first(where: { $0.id == id })?.branch ?? original
            return "给「\(branch)」记一句这个工作区要干什么。"
        case .device: return "给「\(original)」起一个易识别的别名。"
        case .project: return "给「\(original)」换一个展示名称。"
        }
    }
    private func dialogHeader(_ title: String) -> some View {
        HStack { Text(title).fontWeight(.medium); Spacer(); SmallButton(symbol: "xmark", label: "关闭") { model.dialog = nil } }
    }
}

/// 关闭终端与移除实体共用 Web 对应布局，确认按钮没有默认回车快捷键。
struct WorkbenchConfirmationView: View {
    let title: String
    let message: String
    let confirmLabel: String
    let cancel: () -> Void
    let confirm: () -> Void
    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 12) {
                Text(title).fontWeight(.medium).fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                SmallButton(symbol: "xmark", label: "关闭") { cancel() }
            }.padding(.horizontal, 16).padding(.vertical, 10)
            Text(message).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16)
            HStack(spacing: 8) {
                Spacer()
                Button("取消", action: cancel).keyboardShortcut(.cancelAction)
                    .buttonStyle(WorkbenchSecondaryButtonStyle())
                Button(confirmLabel, role: .destructive, action: confirm)
                    .buttonStyle(WorkbenchDestructiveButtonStyle())
            }.padding(16)
        }.font(.system(size: 13)).foregroundStyle(Design.color(0xfafafa))
            .frame(width: 400).background(Design.color(0x262626))
    }
}

private struct WorkbenchDestructiveButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.system(size: 13)).foregroundStyle(Design.color(0xffc6c1))
            .padding(.horizontal, 12).frame(height: 32)
            .background(Design.color(0xff9e97).opacity(configuration.isPressed ? 0.32 : 0.24),
                        in: RoundedRectangle(cornerRadius: 10))
            .contentShape(RoundedRectangle(cornerRadius: 10))
    }
}

private struct ImportProjectView: View {
    let model: WorkbenchModel
    @State private var daemonID: String?
    @State private var home = ""
    @State private var path = ""
    @State private var draftPath = ""
    @State private var editingPath = false
    @State private var selected = -1
    @State private var filter = ""
    @State private var entries: [Coflux_V1_FsEntry] = []
    @State private var showHidden = false
    @State private var busy = false
    @State private var error = ""
    @State private var request: Task<Void, Never>?
    @State private var generation = 0

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("导入项目").fontWeight(.medium)
                Spacer()
                if daemonID != nil {
                    Toggle("显示隐藏项", isOn: $showHidden).toggleStyle(.checkbox).font(.system(size: 11))
                }
                Text(daemonID == nil ? "第 1 步（共 2 步）" : "第 2 步（共 2 步）")
                    .font(.system(size: 13)).foregroundStyle(Design.muted)
                SmallButton(symbol: "xmark", label: "关闭") { model.dialog = nil }
            }.padding(.horizontal, 16).frame(height: 44)
            VStack(spacing: 12) {
                if let daemonID {
                    HStack(spacing: 2) {
                        SmallButton(symbol: "arrow.up", label: "上级目录") {
                            navigate(daemonID, (path as NSString).deletingLastPathComponent)
                        }
                        if editingPath {
                            NativeSearchField(text: $draftPath, placeholder: "目录路径", onMove: { _ in },
                                onSubmit: { navigate(daemonID, draftPath) },
                                onCancel: { editingPath = false; draftPath = path }).frame(height: 26)
                            Button("取消") { editingPath = false; draftPath = path }
                        } else {
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 4) {
                                    ForEach(RemotePath.breadcrumbs(path), id: \.path) { crumb in
                                        Button(crumb.name) { navigate(daemonID, crumb.path) }.buttonStyle(WorkbenchPlainButtonStyle())
                                        if crumb.path != path { Text("/").foregroundStyle(Design.muted) }
                                    }
                                }
                            }
                            Button("编辑") { draftPath = path; editingPath = true }.accessibilityIdentifier("import.edit-path")
                        }
                    }.padding(4).overlay(RoundedRectangle(cornerRadius: 6).stroke(Design.border))
                    NativeSearchField(text: $filter, placeholder: "过滤或进入文件夹",
                        onMove: move, onSubmit: enterSelected, onCancel: backToDevices,
                        onTab: complete, onEmptyBackspace: {
                            if let parent = RemotePath.parent(path) { navigate(daemonID, parent) }
                        }, onCommandSubmit: importCurrent).frame(height: 26).id(path)
                    if !error.isEmpty { Text(error).foregroundStyle(Design.destructive).frame(maxWidth: .infinity, alignment: .leading) }
                    KeyboardChoiceList(selection: selectedDirectoryPath) {
                        LazyVStack(spacing: 0) {
                            if visibleEntries.isEmpty && error.isEmpty {
                                Text(busy ? "读取目录中…" : normalizedFilter.isEmpty ? "此目录下没有子文件夹。" : "没有匹配的文件夹。")
                                    .foregroundStyle(Design.muted).frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.vertical, 8).accessibilityIdentifier("import.directory.empty")
                            }
                            ForEach(Array(visibleEntries.enumerated()), id: \.element.name) { index, entry in
                                let target = (path as NSString).appendingPathComponent(entry.name)
                                let imported = model.client.projects.contains { $0.daemonID == daemonID && $0.repoPath == target }
                                Button { navigate(daemonID, target) } label: {
                                    HStack(spacing: 6) {
                                        WorkbenchIcon(symbol: "folder").font(.system(size: 12)).foregroundStyle(Design.muted)
                                        Text(entry.name).lineLimit(1)
                                        Spacer()
                                        if imported { Text("已导入").foregroundStyle(Design.muted) }
                                    }.padding(.horizontal, 2).padding(.vertical, 4)
                                }.buttonStyle(WorkbenchButtonStyle(selected: index == selected)).disabled(busy).id(target).onHover { if $0 { selected = index } }
                            }
                        }
                    }
                } else if onlineDaemons.isEmpty {
                    VStack(spacing: 12) {
                        WorkbenchIcon(symbol: "monitor-up", size: 20)
                        VStack(spacing: 4) {
                            Text("没有在线设备").font(.system(size: 13, weight: .bold))
                            Text("先登记一台设备并启动 daemon，才能导入这台机器上的仓库。")
                                .foregroundStyle(Design.muted).multilineTextAlignment(.center)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Button("登记设备") { model.dialog = .enrollment }
                            .buttonStyle(WorkbenchPrimaryButtonStyle(height: 32)).accessibilityIdentifier("import.enroll")
                    }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                        .accessibilityElement(children: .contain).accessibilityIdentifier("import.devices.offline")
                } else {
                    NativeSearchField(text: $filter, placeholder: "搜索设备名或主机",
                        onMove: move, onSubmit: enterSelected, onCancel: { model.dialog = nil }).frame(height: 26)
                    KeyboardChoiceList(selection: visibleDaemons.indices.contains(selected) ? visibleDaemons[selected].daemonID : nil) {
                        LazyVStack(spacing: 2) {
                            if visibleDaemons.isEmpty {
                                Text("没有匹配的设备。").foregroundStyle(Design.muted)
                                    .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 8)
                                    .accessibilityIdentifier("import.devices.no-match")
                            }
                            ForEach(Array(visibleDaemons.enumerated()), id: \.element.daemonID) { index, daemon in
                                Button { selectDevice(daemon.daemonID) } label: {
                                    HStack(spacing: 6) {
                                        WorkbenchIcon(symbol: "desktopcomputer").font(.system(size: 12))
                                        Text(daemon.name)
                                        Spacer()
                                        Text("设备").foregroundStyle(Design.muted).lineLimit(1)
                                    }.padding(.vertical, 6)
                                }.buttonStyle(WorkbenchButtonStyle(selected: index == selected)).id(daemon.daemonID).onHover { if $0 { selected = index } }
                            }
                        }
                    }
                }
            }.padding(.horizontal, 16).font(.system(size: 12))
            HStack {
                if daemonID != nil {
                    Button("上一步 Esc", action: backToDevices).keyboardShortcut(.cancelAction)
                    Spacer()
                    if busy { ProgressView().controlSize(.small) }
                    Button("导入「\((path as NSString).lastPathComponent)」 ⌘↵") {
                        importCurrent()
                    }.keyboardShortcut(.return, modifiers: .command)
                        .disabled(!canImport)
                } else if !onlineDaemons.isEmpty {
                    Text("↑↓ 选择，Enter 进入").font(.system(size: 12)).foregroundStyle(Design.muted)
                    Spacer()
                    Button("登记设备") { model.dialog = .enrollment }
                }
            }.padding(daemonID == nil && onlineDaemons.isEmpty ? 0 : 16)
        }.frame(width: 520, height: 420).background(Design.color(0x262626))
            .onDisappear { request?.cancel(); generation += 1 }
            .onChange(of: filter) { _, _ in selected = -1 }
            .onChange(of: entries) { _, _ in selected = -1 }
            .onChange(of: showHidden) { _, _ in selected = -1 }
            .onChange(of: visibleDaemons) { _, _ in if daemonID == nil { selected = -1 } }
    }

    private var normalizedFilter: String { filter.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var onlineDaemons: [Coflux_V1_DaemonInfo] { model.client.daemons.filter(\.online) }
    private var visibleDaemons: [Coflux_V1_DaemonInfo] {
        onlineDaemons.filter { normalizedFilter.isEmpty || $0.name.localizedCaseInsensitiveContains(normalizedFilter) || $0.host.localizedCaseInsensitiveContains(normalizedFilter) }
    }
    private var canImport: Bool {
        !home.isEmpty && model.client.status == .connected && model.client.daemons.contains { $0.daemonID == daemonID && $0.online } &&
        !busy && !editingPath && !path.isEmpty && path != home && error.isEmpty &&
        !model.client.projects.contains { $0.daemonID == daemonID && $0.repoPath == path }
    }
    private func move(_ delta: Int) {
        let count = daemonID == nil ? visibleDaemons.count : visibleEntries.count
        guard count > 0 else { selected = -1; return }
        // 与 Web 一致：-1 表示尚未选择，首行再按上键可撤销选择。
        selected = max(-1, min(count - 1, selected + delta))
    }
    private func selectDevice(_ id: String) {
        daemonID = id; path = ""; home = ""; entries = []; filter = ""; selected = -1
        navigate(id, "~")
    }
    private func enterSelected() {
        guard !busy else { return }
        if let daemonID {
            guard visibleEntries.indices.contains(selected) else { return }
            navigate(daemonID, (path as NSString).appendingPathComponent(visibleEntries[selected].name))
        } else if visibleDaemons.indices.contains(selected) { selectDevice(visibleDaemons[selected].daemonID) }
    }
    private func complete() {
        guard !busy, visibleEntries.indices.contains(selected) else { return }
        let name = visibleEntries[selected].name
        if filter.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == name.lowercased() { enterSelected() }
        else { filter = name }
    }
    private func importCurrent() {
        guard canImport, let daemonID else { return }
        var value = Coflux_V1_ProjectImport(); value.daemonID = daemonID; value.path = path
        if model.client.sendWorkbenchCommand(.projectImport(value)) { model.dialog = nil }
    }
    private func backToDevices() {
        request?.cancel(); generation += 1; daemonID = nil; filter = ""; busy = false; editingPath = false; error = ""
    }

    private var selectedDirectoryPath: String? {
        guard visibleEntries.indices.contains(selected) else { return nil }
        return (path as NSString).appendingPathComponent(visibleEntries[selected].name)
    }

    private var visibleEntries: [Coflux_V1_FsEntry] {
        entries.filter { entry in
            entry.kind == .dir &&
            (showHidden || normalizedFilter.hasPrefix(".") || !entry.name.hasPrefix(".")) &&
            (normalizedFilter.isEmpty || entry.name.localizedCaseInsensitiveContains(normalizedFilter))
        }
    }
    private func navigate(_ daemonID: String, _ target: String) {
        guard model.client.daemons.contains(where: { $0.daemonID == daemonID && $0.online }) else {
            error = "设备已离线，请返回设备列表重试"; return
        }
        request?.cancel()
        generation += 1
        let ticket = generation
        busy = true
        error = ""
        request = Task {
            do {
                let result = try await model.client.listDeviceDirectory(daemonID: daemonID, path: target)
                guard !Task.isCancelled, generation == ticket else { return }
                if result.ok {
                    path = result.path
                    draftPath = result.path
                    editingPath = false
                    entries = result.entries
                    filter = ""
                    if target == "~" { home = result.path }
                } else { error = result.error }
            } catch {
                guard !Task.isCancelled, generation == ticket else { return }
                self.error = String(describing: error)
            }
            busy = false
        }
    }
}

/// 同一个受控状态供按钮、右键菜单和快捷键使用；关闭旧菜单不能清除新目标。
struct WorkbenchBranchPopover: ViewModifier {
    @Bindable var model: WorkbenchModel
    let target: WorkbenchDialog

    func body(content: Content) -> some View {
        content.popover(isPresented: Binding(
            get: { model.dialog?.id == target.id },
            set: { if !$0 && model.dialog?.id == target.id { model.dialog = nil } }
        ), arrowEdge: .bottom) {
            WorkbenchDialogView(model: model, dialog: target)
                .id(target.id).preferredColorScheme(.dark)
        }
    }
}

private struct CreateWorkspaceView: View {
    let model: WorkbenchModel
    let project: Coflux_V1_Project
    var switching: Coflux_V1_Workspace?
    @State private var query = ""
    @State private var branches: [String] = []
    @State private var error = ""
    @State private var busy = true
    @State private var selected = -1
    @State private var revision = 0
    private var entries: [BranchChoice] {
        BranchChoices.entries(query: query, branches: branches,
            taken: Set(model.client.workspaces.filter { $0.projectID == project.id }.map(\.branch)),
            current: switching?.branch, loaded: !busy && error.isEmpty)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            NativeSearchField(text: $query, placeholder: "搜索或输入新分支名",
                onMove: { selected = BranchChoices.move(selected, delta: $0, entries: entries) },
                onSubmit: { if entries.indices.contains(selected) { choose(entries[selected]) } },
                onCancel: { model.dialog = nil }).frame(height: 26)
            Rectangle().fill(Design.border).frame(height: 1)
            if busy { Text("正在获取分支列表…").foregroundStyle(Design.muted) }
            if !error.isEmpty {
                Text(error).foregroundStyle(Design.destructive)
                Button("重试") { revision += 1 }
            }
            ScrollViewReader { reader in
                ScrollView {
                    LazyVStack(spacing: 2) {
                        ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                            Button { choose(entry) } label: {
                                HStack {
                                    if entry.createNew {
                                        Image(systemName: "plus").font(.system(size: 12)).accessibilityHidden(true)
                                    }
                                    Text(entry.createNew ? "从 HEAD 新建「\(entry.name)」" : entry.name)
                                    Spacer()
                                    if entry.current {
                                        Image(systemName: "checkmark").foregroundStyle(Design.success)
                                            .accessibilityLabel("当前分支")
                                    }
                                    else if entry.taken { Text("已被检出").foregroundStyle(Design.muted) }
                                }.padding(.horizontal, 8).frame(height: 28).contentShape(Rectangle())
                            }.buttonStyle(WorkbenchPlainButtonStyle())
                                .background(selected == index ? Design.accent : .clear,
                                            in: RoundedRectangle(cornerRadius: 6))
                                .onContinuousHover { phase in
                                    if case .active = phase, entry.actionable { selected = index }
                                }
                                .accessibilityIdentifier("branch.choice." + entry.id)
                                .disabled(!entry.actionable).id(entry.id)
                        }
                        if !busy && error.isEmpty && entries.isEmpty { Text("没有匹配的分支").foregroundStyle(Design.muted) }
                    }
                }.frame(height: min(240, CGFloat(max(1, entries.count)) * 30))
                    .onChange(of: selected) { _, index in
                        if entries.indices.contains(index) { reader.scrollTo(entries[index].id) }
                    }
            }
        }.padding(8).frame(width: 320)
            .onChange(of: entries) { _, rows in selected = rows.firstIndex(where: \.actionable) ?? -1 }
            .task(id: revision) { await load() }
    }
    private func load() async {
        busy = true; error = ""
        guard let workspace = switching ?? model.client.workspaces.first(where: { $0.projectID == project.id && $0.isMain }) else {
            error = "项目主工作区不存在"; busy = false; return
        }
        do {
            let result = try await model.client.executeInWorkspace(workspaceID: workspace.id, command: "git", args: ["for-each-ref", "--format=%(refname:short)", "refs/heads"])
            guard !Task.isCancelled else { return }
            branches = try BranchChoices.loadedBranches(result)
        } catch {
            guard !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
        busy = false
    }
    private func choose(_ entry: BranchChoice) {
        guard entry.actionable else { return }
        if entry.current { model.dialog = nil; return }
        if let switching {
            model.switchBranch(workspaceID: switching.id, branch: entry.name, createNew: entry.createNew)
        } else {
            if model.createWorkspace(project: project, branch: entry.name, createNew: entry.createNew) { model.dialog = nil }
        }
    }
}

/// 原生滚动容器随键盘高亮定位；列表本身保留焦点在输入框。
private struct KeyboardChoiceList<Content: View>: View {
    let selection: String?
    @ViewBuilder let content: () -> Content
    var body: some View {
        ScrollViewReader { reader in
            ScrollView { content() }
                .onChange(of: selection) { _, value in
                    if let value { reader.scrollTo(value) }
                }
        }
    }
}
