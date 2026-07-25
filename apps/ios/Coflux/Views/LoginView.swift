import SwiftUI

/// 登录表单：模式由编译期配置决定（server 无从探测，与 web 同策略）——
/// supabase 模式 = 邮箱密码换票；local 模式 = 用户名密码直发（plan 044 决策）。
struct LoginView: View {
    let client: CofluxClient
    @State private var username = ""
    @State private var password = ""

    var body: some View {
        VStack(spacing: 16) {
            Spacer()
            Text("coflux")
                .font(.largeTitle.monospaced().bold())
            TextField(Config.useSupabase ? "邮箱" : "用户名", text: $username)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(Config.useSupabase ? .emailAddress : .asciiCapable)
                .textFieldStyle(.roundedBorder)
            SecureField("密码", text: $password)
                .textFieldStyle(.roundedBorder)
            if !client.loginError.isEmpty {
                Text(client.loginError)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
            Button {
                client.login(username: username, password: password)
            } label: {
                Text("登录")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(username.isEmpty || password.isEmpty)
            Spacer()
            Spacer()
        }
        .padding(.horizontal, 32)
    }
}
