import CofluxClientCore
import SwiftUI

/// 登录表单：账号密码直发 clientAuth 帧（plan 061——server 侧 local/password 两模式同帧，
/// 文案中性化「账号」，生产输邮箱、本机 dev 输用户名均可）。
/// Duo redesign: the fields and the button sit on one card with the redesign's radii (fields 18,
/// pill buttons), capped in width so wide windows keep a phone-sized form.
struct LoginView: View {
    let client: CofluxClient
    @State private var username = ""
    @State private var password = ""
    @FocusState private var focus: Field?

    private enum Field { case username, password }

    private var isAuthenticating: Bool { client.authState == .authenticating }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                Text("coflux")
                    .font(Theme.Fonts.brand)
                Text("Agent 指挥中心")
                    .font(Theme.Fonts.subtitle)
                    .foregroundStyle(Theme.mutedForeground)
                    .padding(.top, 6)

                VStack(spacing: 12) {
                    TextField("账号", text: $username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.emailAddress)
                        .focused($focus, equals: .username)
                        .submitLabel(.next)
                        .onSubmit { focus = .password }
                        .loginFieldStyle(focused: focus == .username)
                    SecureField("密码", text: $password)
                        .focused($focus, equals: .password)
                        .submitLabel(.go)
                        .onSubmit { submit() }
                        .loginFieldStyle(focused: focus == .password)

                    if !client.loginError.isEmpty {
                        Label(client.loginError, systemImage: "exclamationmark.circle.fill")
                            .font(Theme.Fonts.label)
                            .foregroundStyle(Theme.destructive)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 4)
                    }

                    Button(action: submit) {
                        Group {
                            if isAuthenticating {
                                ProgressView()
                                    .tint(Theme.primaryForeground)
                            } else {
                                Text("登录")
                                    .font(Theme.Fonts.body.weight(.semibold))
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .frame(height: 50)
                        .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .background(Theme.primary, in: Capsule())
                    .foregroundStyle(Theme.primaryForeground)
                    .opacity(username.isEmpty || password.isEmpty || isAuthenticating ? 0.4 : 1)
                    .disabled(username.isEmpty || password.isEmpty || isAuthenticating)
                    .padding(.top, 4)
                }
                .padding(16)
                .cardBackground(radius: 26)
                .padding(.top, 36)
            }
            .frame(maxWidth: 420)
            .padding(.horizontal, 24)
            .frame(maxWidth: .infinity)
            .containerRelativeFrame(.vertical, alignment: .center) { length, _ in length * 0.9 }
        }
        .scrollBounceBehavior(.basedOnSize)
        .background(Theme.background)
        .task {
            #if DEBUG
            // 无头验收/开发循环便利：经 SIMCTL_CHILD_* 注入即自动登录，仅 Debug 构建生效
            let env = ProcessInfo.processInfo.environment
            if let user = env["COFLUX_DEBUG_USERNAME"], let pass = env["COFLUX_DEBUG_PASSWORD"],
               client.authState == .needLogin {
                client.login(username: user, password: pass)
            }
            #endif
        }
    }

    private func submit() {
        guard !username.isEmpty, !password.isEmpty, !isAuthenticating else { return }
        client.login(username: username, password: password)
    }
}

private extension View {
    func loginFieldStyle(focused: Bool) -> some View {
        self
            .font(Theme.Fonts.body)
            .padding(.horizontal, 16)
            .frame(height: 52)
            .background(Theme.terminal, in: RoundedRectangle(cornerRadius: 18))
            .overlay(
                RoundedRectangle(cornerRadius: 18)
                    .strokeBorder(focused ? Theme.foreground.opacity(0.35) : Theme.border, lineWidth: 1)
            )
            .animation(.easeOut(duration: 0.15), value: focused)
    }
}
