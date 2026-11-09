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
///
/// 「识别后整理」 (plan 20261109-dictation-refine) follows: its switch writes at once with the stored
/// base URL and model and keeps the key; its fields are saved with the toolbar 「保存」. It is not an
/// engine and never appears under 「当前使用」.
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
    /// The correction section's edited base URL and model; nil = showing the stored values.
    @State private var refineDraft: Draft?
    /// The correction key typed here; never prefilled.
    @State private var refineKey = ""
    @State private var refineError: String?

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

    /// The centre stores provider configurations but not the correction record.
    private var refineOutdated: Bool { client.speechConfigSupported && !client.speechRefineSupported }

    private var refineEditable: Bool { editable && client.speechRefineSupported }

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
                    refineSection(stored: config.refine)
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
                        .disabled(!editable || (changedProviders.isEmpty && !refineChanged))
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(34)
        .presentationBackground(Theme.card)
        .preferredColorScheme(.dark)
        .onDisappear {
            keys = [:]
            refineKey = ""
        }
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

    /// 「识别后整理」: switch and status, then the same three fields as an engine.
    @ViewBuilder
    private func refineSection(stored: SpeechRefineState) -> some View {
        Section {
            if refineOutdated {
                LabeledContent("状态") {
                    Text("服务器版本过旧")
                        .foregroundStyle(Theme.mutedForeground)
                }
            }
            Toggle(isOn: refineEnabledBinding(stored)) {
                HStack(spacing: 8) {
                    Text("识别后整理")
                    if !refineOutdated {
                        Text(refineStatus(stored).text)
                            .font(Theme.Fonts.meta)
                            .foregroundStyle(refineStatus(stored).color)
                    }
                }
            }
            .disabled(!refineEditable)
            VStack(alignment: .leading, spacing: 4) {
                Text("Base URL")
                    .font(Theme.Fonts.meta)
                    .foregroundStyle(Theme.mutedForeground)
                TextField("Base URL", text: refineDraftBinding(\.baseURL), prompt: Text("https://api.example.com/v1"))
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            .disabled(!refineEditable)
            VStack(alignment: .leading, spacing: 4) {
                Text("模型")
                    .font(Theme.Fonts.meta)
                    .foregroundStyle(Theme.mutedForeground)
                TextField("模型", text: refineDraftBinding(\.model), prompt: Text("model id"))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            .disabled(!refineEditable)
            VStack(alignment: .leading, spacing: 4) {
                Text("API Key")
                    .font(Theme.Fonts.meta)
                    .foregroundStyle(Theme.mutedForeground)
                SecureField(stored.keyConfigured ? "已保存（留空则不改）" : "粘贴 API Key", text: refineKeyBinding)
                    .textContentType(.password)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            .disabled(!refineEditable)
            if let refineError {
                Text(refineError)
                    .font(Theme.Fonts.meta)
                    .foregroundStyle(Theme.destructive)
            }
            if stored.keyConfigured {
                Button("清除 API Key", role: .destructive) {
                    Task { await clearRefineKey(stored: stored) }
                }
                .disabled(!refineEditable)
            }
        } header: {
            Text("识别后整理")
        } footer: {
            Text("用大模型按对话和仓库术语纠正识别结果。建议选不带深度思考的快速模型。")
        }
        .listRowBackground(Theme.secondarySurface)
    }

    /// ● 已配置 (on and complete), ○ 未启用 (off), ○ 未配置 (on but something missing).
    private func refineStatus(_ stored: SpeechRefineState) -> (text: String, color: Color) {
        if !stored.enabled { return ("○ 未启用", Theme.mutedForeground) }
        return stored.isUsable ? ("● 已配置", Theme.success) : ("○ 未配置", Theme.warning)
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

    private var storedRefine: SpeechRefineState { config?.refine ?? SpeechRefineState() }

    private var currentRefine: Draft {
        refineDraft ?? Draft(baseURL: storedRefine.baseURL, model: storedRefine.model)
    }

    private func refineDraftBinding(_ field: WritableKeyPath<Draft, String>) -> Binding<String> {
        Binding(
            get: { currentRefine[keyPath: field] },
            set: { value in
                var draft = currentRefine
                draft[keyPath: field] = value
                refineDraft = draft
                refineError = nil
            }
        )
    }

    private var refineKeyBinding: Binding<String> {
        Binding(
            get: { refineKey },
            set: { value in
                refineKey = value
                refineError = nil
            }
        )
    }

    /// The switch writes at once with the stored base URL and model, keeping the key. Turning it on
    /// without a stored base URL or model shows the error and leaves it off.
    private func refineEnabledBinding(_ stored: SpeechRefineState) -> Binding<Bool> {
        Binding(
            get: { stored.enabled },
            set: { enabled in
                guard enabled != stored.enabled, refineEditable else { return }
                if enabled, stored.baseURL.isEmpty || stored.model.isEmpty {
                    refineError = "开启识别后整理前请先填写并保存 Base URL 和模型"
                    return
                }
                Task { await setRefineEnabled(enabled, stored: stored) }
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

    /// The correction section's base URL or model differ from the stored values, or a key is typed.
    private var refineChanged: Bool {
        guard client.speechRefineSupported else { return false }
        let draft = currentRefine
        return Self.trimmed(draft.baseURL) != storedRefine.baseURL
            || Self.trimmed(draft.model) != storedRefine.model
            || !Self.trimmed(refineKey).isEmpty
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
        let refineWrite = refineChanged
        if refineWrite {
            let draft = currentRefine
            if let message = speechRefineInputError(
                enabled: storedRefine.enabled, baseURL: draft.baseURL, model: draft.model, apiKey: refineKey
            ) {
                refineError = message
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
        if refineWrite {
            refineError = nil
            let draft = currentRefine
            let typedKey = Self.trimmed(refineKey)
            let result = await client.setSpeechRefine(
                enabled: storedRefine.enabled, baseURL: draft.baseURL, model: draft.model,
                key: typedKey.isEmpty ? .keep : .replace(typedKey)
            )
            switch result {
            case .ok:
                refineDraft = nil
                refineKey = ""
            case .failed(let message):
                refineError = message
                return false
            }
        }
        return true
    }

    private func setRefineEnabled(_ enabled: Bool, stored: SpeechRefineState) async {
        busy = true
        refineError = nil
        let result = await client.setSpeechRefine(enabled: enabled, baseURL: stored.baseURL, model: stored.model, key: .keep)
        busy = false
        if case .failed(let message) = result { refineError = message }
    }

    /// Remove the correction key, keeping the stored switch, base URL and model.
    private func clearRefineKey(stored: SpeechRefineState) async {
        busy = true
        refineError = nil
        let result = await client.setSpeechRefine(enabled: stored.enabled, baseURL: stored.baseURL, model: stored.model, key: .clear)
        busy = false
        if case .failed(let message) = result { refineError = message }
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
