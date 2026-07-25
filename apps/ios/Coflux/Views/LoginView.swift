import SwiftUI

/// 登录表单：模式由编译期配置决定（server 无从探测，与 web 同策略）——
/// supabase 模式 = 邮箱密码换票；local 模式 = 用户名密码直发（plan 044 决策）。
/// 视觉对标 Raycast iOS 登录：填充式圆角输入框 + 高对比单色主按钮。
struct LoginView: View {
    let client: CofluxClient
    @State private var username = ""
    @State private var password = ""
    @FocusState private var focus: Field?

    private enum Field { case username, password }

    private var isAuthenticating: Bool { client.authState == .authenticating }

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            Text("coflux")
                .font(.system(size: 40, weight: .bold, design: .monospaced))
            Text("Agent 指挥中心")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .padding(.top, 6)

            VStack(spacing: 12) {
                TextField(Config.useSupabase ? "邮箱" : "用户名", text: $username)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(Config.useSupabase ? .emailAddress : .asciiCapable)
                    .focused($focus, equals: .username)
                    .submitLabel(.next)
                    .onSubmit { focus = .password }
                    .loginFieldStyle(focused: focus == .username)
                SecureField("密码", text: $password)
                    .focused($focus, equals: .password)
                    .submitLabel(.go)
                    .onSubmit { submit() }
                    .loginFieldStyle(focused: focus == .password)
            }
            .padding(.top, 40)

            if !client.loginError.isEmpty {
                Label(client.loginError, systemImage: "exclamationmark.circle.fill")
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 12)
            }

            Button(action: submit) {
                Group {
                    if isAuthenticating {
                        ProgressView()
                            .tint(Color(.systemBackground))
                    } else {
                        Text("登录")
                            .font(.body.weight(.semibold))
                    }
                }
                .frame(maxWidth: .infinity)
                .frame(height: 50)
            }
            .buttonStyle(.plain)
            .background(Color.primary, in: RoundedRectangle(cornerRadius: 12))
            .foregroundStyle(Color(.systemBackground))
            .opacity(username.isEmpty || password.isEmpty || isAuthenticating ? 0.4 : 1)
            .disabled(username.isEmpty || password.isEmpty || isAuthenticating)
            .padding(.top, 20)

            Spacer()
            Spacer()
        }
        .padding(.horizontal, 28)
        .background(Color(.systemBackground))
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
            .padding(.horizontal, 16)
            .frame(height: 50)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(focused ? Color.primary.opacity(0.35) : .clear, lineWidth: 1)
            )
            .animation(.easeOut(duration: 0.15), value: focused)
    }
}
