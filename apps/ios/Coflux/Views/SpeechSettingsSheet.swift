import CofluxClientCore
import SwiftUI

/// 「语音识别」 settings (plan 20261108-ios-seed-asr): the account's 豆包 Seed-ASR key, which long-press
/// dictation uses. Opened from 「设置」 (`SettingsSheet`) and from the dictation overlay's 「去设置」.
///
/// The key typed here lives only in this view's state until it is sent once; the field never shows
/// the stored key (the sheet does not fetch it) and is cleared when the sheet closes.
struct SpeechSettingsSheet: View {
    let client: CofluxClient
    @Environment(\.dismiss) private var dismiss
    @State private var apiKey = ""
    @State private var busy = false
    @State private var error: String?

    private var configured: Bool { client.speechKeyStatus?.configured == true }

    private var statusText: String {
        if client.status == .connected, client.authState == .authed, !client.speechKeySupported {
            return "服务器版本过旧"
        }
        guard let status = client.speechKeyStatus else { return "正在读取…" }
        return status.configured ? "已配置" : "未配置"
    }

    private var editable: Bool {
        client.speechKeySupported && client.speechKeyStatus != nil && !busy
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("状态") {
                        HStack(spacing: 6) {
                            if client.speechKeyStatus == nil, client.speechKeySupported {
                                ProgressView().controlSize(.small)
                            }
                            Text(statusText)
                                .foregroundStyle(configured ? Theme.success : Theme.mutedForeground)
                        }
                    }
                }
                .listRowBackground(Theme.secondarySurface)

                Section {
                    SecureField(configured ? "填入新 Key 可替换" : "粘贴 API Key", text: $apiKey)
                        .textContentType(.password)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .disabled(!editable)
                    if let error {
                        Text(error)
                            .font(Theme.Fonts.meta)
                            .foregroundStyle(Theme.destructive)
                    }
                } header: {
                    Text("API Key")
                } footer: {
                    Text("火山方舟 Agent Plan 的 API Key，用于豆包语音识别 2.0；加密保存在账号上，账号下的所有设备共用。")
                }
                .listRowBackground(Theme.secondarySurface)

                if configured {
                    Section {
                        Button("清除", role: .destructive) {
                            Task { await write("") }
                        }
                        .disabled(!editable)
                    }
                    .listRowBackground(Theme.secondarySurface)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.card)
            .navigationTitle("语音识别")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭", systemImage: "xmark") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if busy {
                        ProgressView()
                    } else {
                        Button("保存", systemImage: "checkmark") {
                            Task {
                                if await write(apiKey) { dismiss() }
                            }
                        }
                        .disabled(!editable || apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(34)
        .presentationBackground(Theme.card)
        .preferredColorScheme(.dark)
        .onDisappear { apiKey = "" }
    }

    /// Send the key (empty = clear). True on success; the error stays inline otherwise.
    @discardableResult
    private func write(_ key: String) async -> Bool {
        busy = true
        error = nil
        let result = await client.setSpeechKey(key)
        busy = false
        switch result {
        case .ok:
            apiKey = ""
            return true
        case .failed(let message):
            error = message
            return false
        }
    }
}
