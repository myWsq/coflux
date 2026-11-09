import CofluxClientCore
import SwiftUI

/// 「设置」: the one settings page, opened from the gear of the inner display's sidebar and of the
/// outer display's home (user's call, 2026-11-10: a settings page, not an account button). The
/// account and its connection first, then 语音识别, then 退出登录.
struct SettingsSheet: View {
    let client: CofluxClient
    @Environment(\.dismiss) private var dismiss
    @State private var showingSpeech = false
    @State private var confirmingLogout = false

    var body: some View {
        NavigationStack {
            Form {
                Section("账号") {
                    LabeledContent("登录身份") {
                        Text(client.loginName.isEmpty ? "已登录" : client.loginName)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    LabeledContent("连接") {
                        connectionText
                    }
                }
                .listRowBackground(Theme.secondarySurface)

                Section {
                    Button {
                        showingSpeech = true
                    } label: {
                        HStack {
                            Label("语音识别", systemImage: "waveform")
                                .foregroundStyle(Theme.foreground)
                            Spacer()
                            Text(speechStatus)
                                .foregroundStyle(Theme.mutedForeground)
                            Image(systemName: "chevron.right")
                                .font(Theme.Fonts.label.weight(.semibold))
                                .foregroundStyle(Theme.subtleForeground)
                        }
                    }
                } footer: {
                    Text("长按输入键说话时使用的豆包语音识别。")
                }
                .listRowBackground(Theme.secondarySurface)

                Section {
                    Button("退出登录", role: .destructive) {
                        confirmingLogout = true
                    }
                }
                .listRowBackground(Theme.secondarySurface)
            }
            .scrollContentBackground(.hidden)
            .background(Theme.card)
            .navigationTitle("设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭", systemImage: "xmark") { dismiss() }
                }
            }
            .confirmationDialog("退出登录？", isPresented: $confirmingLogout, titleVisibility: .visible) {
                Button("退出登录", role: .destructive) {
                    dismiss()
                    client.logout()
                }
            } message: {
                Text("这台 iPhone 上的终端连接会断开，重新登录后恢复。")
            }
        }
        .sheet(isPresented: $showingSpeech) {
            SpeechSettingsSheet(client: client)
        }
    }

    @ViewBuilder
    private var connectionText: some View {
        switch client.status {
        case .connected:
            Text("已连接").foregroundStyle(Theme.success)
        case .connecting:
            Text("连接中…").foregroundStyle(Theme.warning)
        case .disconnected:
            Text("已断开").foregroundStyle(Theme.warning)
        }
    }

    private var speechStatus: String {
        guard client.speechKeySupported else { return "" }
        guard let status = client.speechKeyStatus else { return "" }
        return status.configured ? "已配置" : "未配置"
    }
}
