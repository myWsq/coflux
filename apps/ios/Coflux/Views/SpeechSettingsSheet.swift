import CofluxClientCore
import SwiftUI

/// 「语音识别」 settings (plan 20261109-speech-providers): which provider long-press dictation uses,
/// and one configuration per provider — base URL, model and API key. Opened from the account menu
/// and from the dictation overlay's 「去设置」.
///
/// 「当前使用」 writes at once; the toolbar 「保存」 writes every provider section the user changed. Base
/// URL and model start from the stored values (empty = the default shown as the placeholder). A key
/// typed here lives only in this view's state until it is sent once; the field never shows the
/// stored key (the sheet does not fetch it) and is cleared when the sheet closes.
struct SpeechSettingsSheet: View {
    let client: CofluxClient
    @Environment(\.dismiss) private var dismiss

    /// Edited base URL and model per provider; absent = showing the stored values.
    @State private var drafts: [SpeechProviderID: Draft] = [:]
    /// Typed keys per provider; never prefilled.
    @State private var keys: [SpeechProviderID: String] = [:]
    @State private var errors: [SpeechProviderID: String] = [:]
    @State private var activeError: String?
    @State private var pendingActive: SpeechProviderID?
    @State private var busy = false

    private struct Draft: Equatable {
        var baseURL: String
        var model: String
    }

    private var config: SpeechConfig? { client.speechConfig }

    private var outdatedServer: Bool {
        client.status == .connected && client.authState == .authed && !client.speechConfigSupported
    }

    private var editable: Bool {
        client.speechConfigSupported && config != nil && !busy && pendingActive == nil
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if outdatedServer {
                        LabeledContent("状态") {
                            Text("服务器版本过旧，不支持语音识别设置")
                                .foregroundStyle(Theme.mutedForeground)
                        }
                    } else if let config {
                        Picker("当前使用", selection: activeBinding(config)) {
                            ForEach(SpeechProviderID.allCases) { provider in
                                Text(provider.displayName).tag(provider)
                            }
                        }
                        .pickerStyle(.menu)
                        .disabled(!editable)
                    } else {
                        LabeledContent("状态") {
                            HStack(spacing: 6) {
                                if client.speechConfigSupported { ProgressView().controlSize(.small) }
                                Text("正在读取…").foregroundStyle(Theme.mutedForeground)
                            }
                        }
                    }
                    if let activeError {
                        Text(activeError)
                            .font(Theme.Fonts.meta)
                            .foregroundStyle(Theme.destructive)
                    }
                } footer: {
                    Text("长按说话时调用这里选中的服务；设置保存在账号上，账号下的所有设备共用；API Key 加密保存。")
                }
                .listRowBackground(Theme.secondarySurface)

                if let config {
                    ForEach(SpeechProviderID.allCases) { provider in
                        providerSection(provider, stored: config[provider])
                    }
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
                                if await saveChanged() { dismiss() }
                            }
                        }
                        .disabled(!editable || changedProviders.isEmpty)
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(34)
        .presentationBackground(Theme.card)
        .preferredColorScheme(.dark)
        .onDisappear { keys = [:] }
    }

    @ViewBuilder
    private func providerSection(_ provider: SpeechProviderID, stored: SpeechProviderState) -> some View {
        Section {
            LabeledContent("状态") {
                Text(stored.keyConfigured ? "已配置" : "未配置")
                    .foregroundStyle(stored.keyConfigured ? Theme.success : Theme.mutedForeground)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("Base URL")
                    .font(Theme.Fonts.meta)
                    .foregroundStyle(Theme.mutedForeground)
                TextField("Base URL", text: draftBinding(provider, \.baseURL), prompt: Text(provider.defaultBaseURL))
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            .disabled(!editable)
            VStack(alignment: .leading, spacing: 4) {
                Text("模型")
                    .font(Theme.Fonts.meta)
                    .foregroundStyle(Theme.mutedForeground)
                TextField("模型", text: draftBinding(provider, \.model), prompt: Text(provider.defaultModel))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            .disabled(!editable)
            VStack(alignment: .leading, spacing: 4) {
                Text("API Key")
                    .font(Theme.Fonts.meta)
                    .foregroundStyle(Theme.mutedForeground)
                SecureField(stored.keyConfigured ? "已保存（留空则不改）" : "粘贴 API Key", text: keyBinding(provider))
                    .textContentType(.password)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            .disabled(!editable)
            if let error = errors[provider] {
                Text(error)
                    .font(Theme.Fonts.meta)
                    .foregroundStyle(Theme.destructive)
            }
            if stored.keyConfigured {
                Button("清除 API Key", role: .destructive) {
                    Task { await clearKey(provider, stored: stored) }
                }
                .disabled(!editable)
            }
        } header: {
            Text(provider.displayName)
        } footer: {
            Text(footer(for: provider))
        }
        .listRowBackground(Theme.secondarySurface)
    }

    private func footer(for provider: SpeechProviderID) -> String {
        switch provider {
        case .doubao:
            "火山方舟 Agent Plan 的豆包语音识别 2.0。Base URL 与模型留空即用默认值。"
        case .openai:
            "OpenAI Realtime 实时转写，只支持 gpt-live-transcribe 系列模型。Base URL 与模型留空即用默认值。"
        }
    }

    // MARK: - Bindings

    private func stored(_ provider: SpeechProviderID) -> SpeechProviderState {
        config?[provider] ?? SpeechProviderState()
    }

    private func current(_ provider: SpeechProviderID) -> Draft {
        drafts[provider] ?? Draft(baseURL: stored(provider).baseURL, model: stored(provider).model)
    }

    private func draftBinding(_ provider: SpeechProviderID, _ field: WritableKeyPath<Draft, String>) -> Binding<String> {
        Binding(
            get: { current(provider)[keyPath: field] },
            set: { value in
                var draft = current(provider)
                draft[keyPath: field] = value
                drafts[provider] = draft
                errors[provider] = nil
            }
        )
    }

    private func keyBinding(_ provider: SpeechProviderID) -> Binding<String> {
        Binding(
            get: { keys[provider] ?? "" },
            set: { value in
                keys[provider] = value
                errors[provider] = nil
            }
        )
    }

    private func activeBinding(_ config: SpeechConfig) -> Binding<SpeechProviderID> {
        Binding(
            get: { pendingActive ?? config.active },
            set: { provider in
                guard provider != config.active, pendingActive == nil else { return }
                Task { await setActive(provider) }
            }
        )
    }

    // MARK: - Writes

    private static func trimmed(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Providers whose base URL or model differ from the stored values, or with a typed key.
    private var changedProviders: [SpeechProviderID] {
        SpeechProviderID.allCases.filter { provider in
            let draft = current(provider)
            let slot = stored(provider)
            return Self.trimmed(draft.baseURL) != slot.baseURL
                || Self.trimmed(draft.model) != slot.model
                || !Self.trimmed(keys[provider] ?? "").isEmpty
        }
    }

    private func setActive(_ provider: SpeechProviderID) async {
        pendingActive = provider
        activeError = nil
        let result = await client.setSpeechActiveProvider(provider)
        pendingActive = nil
        if case .failed(let message) = result { activeError = message }
    }

    /// Write every changed provider section, the key only when typed. True when all were accepted;
    /// otherwise the failed section keeps the user's input and shows the error inline.
    private func saveChanged() async -> Bool {
        let changed = changedProviders
        var invalid = false
        for provider in changed {
            let draft = current(provider)
            if let message = speechConfigInputError(
                provider: provider, baseURL: draft.baseURL, model: draft.model, apiKey: keys[provider] ?? ""
            ) {
                errors[provider] = message
                invalid = true
            }
        }
        guard !invalid else { return false }
        busy = true
        defer { busy = false }
        for provider in changed {
            errors[provider] = nil
            let draft = current(provider)
            let typedKey = Self.trimmed(keys[provider] ?? "")
            let result = await client.setSpeechProviderConfig(
                provider, baseURL: draft.baseURL, model: draft.model,
                key: typedKey.isEmpty ? .keep : .replace(typedKey)
            )
            switch result {
            case .ok:
                drafts[provider] = nil
                keys[provider] = nil
            case .failed(let message):
                errors[provider] = message
                return false
            }
        }
        return true
    }

    /// Remove one provider's key, keeping its stored base URL and model.
    private func clearKey(_ provider: SpeechProviderID, stored: SpeechProviderState) async {
        busy = true
        errors[provider] = nil
        let result = await client.setSpeechProviderConfig(
            provider, baseURL: stored.baseURL, model: stored.model, key: .clear
        )
        busy = false
        if case .failed(let message) = result { errors[provider] = message }
    }
}
