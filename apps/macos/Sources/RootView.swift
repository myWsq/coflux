import AppKit
import CofluxClientCore
import SwiftUI

struct RootView: View {
    @Bindable var model: WorkbenchModel
    @State private var loginUsername = ""
    @State private var loginPassword = ""
    private var closingTerminalTitle: String {
        guard let title = model.pendingClose?.title, !title.isEmpty else { return "终端" }
        return title
    }
    var body: some View {
        ZStack {
            Design.background
            switch model.client.authState {
            case .needLogin, .authFailed: LoginView(client: model.client, username: $loginUsername, password: $loginPassword)
            case .authenticating: ProgressView().controlSize(.small)
            case .outdated:
                VStack(spacing: 12) {
                    Text("客户端需要更新").fontWeight(.medium)
                    Text("请安装与服务器兼容的 coflux 版本。")
                        .foregroundStyle(Design.muted)
                }
            case .authed: WorkbenchView(model: model)
            }
        }
        .background(WorkbenchShortcutMonitor(model: model).frame(width: 0, height: 0))
        .foregroundStyle(Design.foreground).font(.system(size: 13))
        .onChange(of: model.client.authState) { _, state in
            if state == .authed { loginPassword = "" }
        }
        .onChange(of: model.client.snapshotRevision) { _, _ in model.reconcile() }
        .onChange(of: model.client.workspaces) { _, _ in model.reconcile() }
        .onChange(of: model.client.tasks) { _, _ in model.reconcile() }
        .onChange(of: model.client.daemons) { _, _ in model.reconcile() }
        .onChange(of: model.client.lastError) { _, _ in model.finishCreate(); model.finishWorkspaceCreates() }
        .sheet(item: Binding(get: { model.dialog?.isBranchMenu == true ? nil : model.dialog },
                             set: { if model.dialog?.isBranchMenu != true { model.dialog = $0 } })) {
            dialog in WorkbenchDialogView(model: model, dialog: dialog)
        }
        .sheet(isPresented: $model.showHelp) {
            ShortcutHelpView { model.showHelp = false }
        }
        .sheet(isPresented: Binding(get: { model.pendingClose != nil }, set: { if !$0 { model.pendingClose = nil } })) {
            WorkbenchConfirmationView(
                title: "关闭终端「\(closingTerminalTitle)」？",
                message: "正在运行的 shell 会先停止，随后永久删除这个 Tab。终端中的历史输出不会保留。",
                confirmLabel: "停止并关闭",
                cancel: { model.pendingClose = nil },
                confirm: { model.confirmClose() })
        }
    }
}

private struct LoginView: View {
    let client: CofluxClient
    @Binding var username: String
    @Binding var password: String
    @FocusState private var field: Int?
    var body: some View {
        VStack(spacing: 16) {
            Text("coflux").font(.system(size: 16, weight: .bold)).frame(height: 22)
            VStack(spacing: 16) {
                VStack(spacing: 4) {
                    WorkbenchIcon(symbol: "lock.open", size: 20).font(.system(size: 20))
                    Text("登录到 coflux").font(.system(size: 20, weight: .semibold)).frame(height: 28)
                    Text("使用你的账号访问远程工作区").font(.system(size: 12)).foregroundStyle(Design.color(0xa3a3a3)).frame(height: 17)
                }
                if !client.loginError.isEmpty {
                    HStack(alignment: .top, spacing: 12) {
                        WorkbenchIcon(symbol: "circle-x", size: 20).foregroundStyle(Design.color(0xff9e97))
                        Text(client.loginError).font(.system(size: 14, weight: .medium))
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }.padding(.vertical, 12).padding(.horizontal, 16)
                        .background(Design.color(0xff9e97).opacity(0.24), in: RoundedRectangle(cornerRadius: 12))
                        .accessibilityElement(children: .combine).accessibilityIdentifier("login.error")
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("账号").font(.system(size: 14, weight: .medium)).foregroundStyle(Design.color(0xa3a3a3)).frame(height: 20)
                    TextField("输入账号", text: $username).focused($field, equals: 1)
                        .textFieldStyle(.plain).padding(.horizontal, 8).frame(height: 32).background(Design.color(0x262626), in: RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(field == 1 ? Design.color(0xd4d4d4) : Design.color(0x525252)))
                        .onSubmit { field = 2 }.accessibilityIdentifier("login.username")
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("密码").font(.system(size: 14, weight: .medium)).foregroundStyle(Design.color(0xa3a3a3)).frame(height: 20)
                    SecureField("输入密码", text: $password).focused($field, equals: 2)
                        .textFieldStyle(.plain).padding(.horizontal, 8).frame(height: 32).background(Design.color(0x262626), in: RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(field == 2 ? Design.color(0xd4d4d4) : Design.color(0x525252)))
                        .onSubmit(login).accessibilityIdentifier("login.password")
                }
                Button(action: login) {
                    Text("登录").frame(maxWidth: .infinity)
                }.buttonStyle(WorkbenchPrimaryButtonStyle(height: 32)).disabled(username.isEmpty || password.isEmpty)
                    .accessibilityIdentifier("login.submit")
            }.padding(32).background(Design.color(0x1b1b1b), in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Design.color(0x525252)))
            Text("安全连接到你的远程工作区").font(.system(size: 12)).foregroundStyle(Design.color(0xa3a3a3)).frame(height: 17)
        }.frame(width: 400).frame(maxWidth: .infinity, maxHeight: .infinity)
            .foregroundStyle(Design.color(0xfafafa)).background(Design.color(0x1b1b1b))
            .onAppear { field = username.isEmpty ? 1 : 2 }
    }
    private func login() {
        guard !username.isEmpty, !password.isEmpty else { return }
        client.login(username: username, password: password)
    }
}

private struct WorkbenchView: View {
    @Bindable var model: WorkbenchModel
    @State private var sidebarWidth = 260.0
    @State private var dragStart: Double?
    var body: some View {
        VStack(spacing: 0) {
            if model.client.status != .connected {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.mini).tint(Design.warning)
                        .frame(width: 12, height: 12).accessibilityHidden(true)
                    Text("连接已断开，正在自动重连…下方显示的是最后一次同步的状态。")
                        .font(.system(size: 12))
                }.foregroundStyle(Design.warning)
                    .frame(maxWidth: .infinity).frame(height: 28)
                    .background(Design.warning.opacity(0.1))
                    .overlay(alignment: .bottom) { Rectangle().fill(Design.warning.opacity(0.2)).frame(height: 1) }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("connection.reconnecting")
            }
            HStack(spacing: 0) {
                SidebarView(model: model).frame(width: sidebarWidth - 1)
                Rectangle().fill(Design.border).frame(width: 1)
                    .overlay {
                        Color.clear.frame(width: 7).contentShape(Rectangle())
                            .accessibilityLabel("调整侧栏宽度")
                            .accessibilityIdentifier("sidebar.resize")
                            .onHover { over in if over { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() } }
                            .gesture(DragGesture(minimumDistance: 0).onChanged { value in
                                if dragStart == nil { dragStart = sidebarWidth }
                                sidebarWidth = WorkbenchState.sidebarWidth((dragStart ?? 260) + value.translation.width)
                            }.onEnded { _ in
                                model.preferences.set(sidebarWidth, forKey: "sidebarWidth")
                                dragStart = nil
                            })
                            .simultaneousGesture(TapGesture(count: 2).onEnded {
                                sidebarWidth = 260
                                dragStart = nil
                                model.preferences.set(sidebarWidth, forKey: "sidebarWidth")
                            })
                    }.zIndex(10)
                TerminalWorkspaceView(model: model)
            }
        }.onAppear {
            sidebarWidth = WorkbenchState.sidebarWidth(model.preferences.object(forKey: "sidebarWidth") as? Double ?? 260)
            model.reconcile()
        }
        .overlay(alignment: .bottomTrailing) {
            if let error = model.client.lastError, error.id != model.dismissedError {
                WorkbenchErrorToast(message: error.message) { model.dismissedError = error.id }
            }
        }
    }
}

struct WorkbenchErrorToast: View {
    let message: String
    let dismiss: () -> Void
    var body: some View {
                HStack(alignment: .top, spacing: 12) {
                    WorkbenchIcon(symbol: "circle-alert", size: 16)
                        .foregroundStyle(Design.destructive).padding(.top, 2)
                    ViewThatFits(in: .vertical) {
                        errorText(message).fixedSize(horizontal: false, vertical: true)
                        ScrollView { errorText(message).frame(maxWidth: .infinity, alignment: .leading) }
                    }.frame(maxHeight: 320)
                    SmallButton(symbol: "xmark", label: "关闭提示") { dismiss() }
                }.padding(.horizontal, 16).padding(.vertical, 12)
                    .background(Design.panel, in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Design.destructive.opacity(0.3)))
                    .shadow(color: .black.opacity(0.25), radius: 20, y: 8)
                    .frame(maxWidth: 448)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(16)
                    .accessibilityIdentifier("workbench.error")
    }
    private func errorText(_ message: String) -> some View {
        Text(message.replacingOccurrences(of: "任务", with: "终端"))
            .font(.system(size: 14)).foregroundStyle(Design.foreground)
            .lineSpacing(3).textSelection(.enabled)
    }
}


struct ShortcutHelpView: View {
    let dismiss: () -> Void
    private let rows: [(String, String)] = [
        ("新建终端", "T"), ("关闭当前终端", "W"), ("切换到第 N 个终端", "1-9"),
        ("上一个终端", "["), ("下一个终端", "]"), ("新建工作区", "N"), ("显示 / 隐藏本面板", "/")
    ]
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                Text("快捷键").fontWeight(.medium).foregroundStyle(Design.color(0xfafafa))
                Spacer()
                Button(action: dismiss) {
                    WorkbenchIcon(symbol: "xmark").font(.system(size: 16))
                        .frame(width: 28, height: 28)
                }.buttonStyle(WorkbenchButtonStyle()).accessibilityLabel("关闭")
                    .foregroundStyle(Design.color(0xfafafa)).workbenchTooltip("关闭")
            }.padding(.horizontal, 16).frame(height: 44)
            VStack(spacing: 8) {
                ForEach(rows, id: \.0) { description, key in
                    HStack(spacing: 12) {
                        Text(description)
                        Spacer(minLength: 0)
                        HStack(spacing: 4) { keyCap("⌘"); keyCap(key) }
                    }
                }
            }.padding(.horizontal, 16).padding(.bottom, 16)
        }.font(.system(size: 13)).foregroundStyle(.white)
            .frame(width: 380).background(Design.color(0x262626))
            .onExitCommand(perform: dismiss)
    }
    private func keyCap(_ key: String) -> some View {
        Text(key).font(.system(size: 11, design: .monospaced))
            .foregroundStyle(Design.foreground)
            .padding(.horizontal, 4).frame(minWidth: 20, minHeight: 20)
            .background(Design.color(0x1b1b1a), in: RoundedRectangle(cornerRadius: 4))
            .overlay(RoundedRectangle(cornerRadius: 4).stroke(Design.border))
    }
}
