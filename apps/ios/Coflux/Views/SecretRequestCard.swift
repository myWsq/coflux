import CofluxClientCore
import SwiftUI
import UIKit

/// Agent secret request cards (plan 20260926-ios-secret-input), shown in `SecretRequestSheet`, the
/// bottom sheet opened from a home card or the terminal page (Duo redesign, mockup O8; the sheet
/// rises with the keyboard, so the buttons stay reachable). Same content and states as the desktop
/// card (apps/desktop/.../secret-request-card.tsx). Every client of the account shows
/// the request; the first answer wins, and a request that leaves the live set (answered elsewhere,
/// expired, the agent stopped waiting) simply stops being rendered.
///
/// The cards never take focus on their own: the user taps into the field. The typed value lives only
/// in the card's own `@State` — never in the input area's draft, the compose overlay, dictation, the
/// store or the pasteboard — until it is sent once to the device's worker over the end-to-end Device
/// channel; it is cleared when the card closes.
///
/// Multi-line values (plan 20261002-secret-skill): `SecureField` is single-line, so a paste button
/// beside it reads the pasteboard and applies `SecretPaste`. A value with an inner line break is
/// kept as a masked summary (line count only, never the text) instead of the field; anything else
/// lands in the field as before. Values that reach the field by the system paste menu go through the
/// same rule, so a line break never sneaks in unnormalized.
struct SecretRequestCards: View {
    let client: CofluxClient
    let requests: [SecretRequestInfo]
    /// 设备 · 工作区 · 终端
    let source: String
    let deviceName: String

    var body: some View {
        if !requests.isEmpty {
            VStack(spacing: 22) {
                ForEach(requests) { request in
                    SecretRequestCard(client: client, request: request, source: source, deviceName: deviceName)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 22)
        }
    }
}

private struct SecretRequestCard: View {
    let client: CofluxClient
    let request: SecretRequestInfo
    let source: String
    let deviceName: String
    @State private var value = ""
    /// The value holds an inner line break: the field is replaced by a masked summary.
    @State private var multiline = false
    @State private var phase: SecretCardPhase = .pending

    private var isClosed: Bool {
        if case .closed = phase { return true }
        return false
    }

    private var isSubmitting: Bool {
        if case .submitting = phase { return true }
        return false
    }

    private func isSubmitting(_ kind: SecretAnswer.Kind) -> Bool {
        if case .submitting(let current) = phase { return current == kind }
        return false
    }

    private var failure: String? {
        if case .failed(let error) = phase { return error }
        return nil
    }

    private var deadline: String {
        Date(timeIntervalSince1970: request.expiresAt / 1000).formatted(date: .omitted, time: .shortened)
    }

    var body: some View {
        if !isClosed {
            card
        }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            if !request.reason.isEmpty {
                reason
            }
            field
            if let failure {
                Text("\(failure)，请重试。")
                    .font(Theme.Fonts.label)
                    .foregroundStyle(Theme.destructive)
                    .fixedSize(horizontal: false, vertical: true)
            }
            footer
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Agent 请求输入 \(request.name)")
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 10) {
            AgentAvatar(mark: .secret, size: 34)
            VStack(alignment: .leading, spacing: 2) {
                Text(request.name)
                    .font(Theme.Fonts.body.weight(.semibold).monospaced())
                    .foregroundStyle(Theme.foreground)
                    .lineLimit(1)
                Text("Agent 请求输入")
                    .font(Theme.Fonts.label)
                    .foregroundStyle(Theme.mutedForeground)
                Text(source)
                    .font(Theme.Fonts.meta)
                    .foregroundStyle(Theme.subtleForeground)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 0)
            // Closing tells the agent this request was cancelled; it is not a local hide.
            Button {
                submit(.cancel)
            } label: {
                Image(systemName: "xmark")
                    .font(Theme.Fonts.label.weight(.semibold))
                    .foregroundStyle(Theme.mutedForeground)
                    .frame(width: Theme.Metrics.roundButton, height: Theme.Metrics.roundButton)
                    .background(Theme.accentSurface, in: Circle())
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(isSubmitting)
            .accessibilityLabel("取消请求")
        }
    }

    private var reason: some View {
        let text = Text(request.reason)
            .font(Theme.Fonts.label)
            .foregroundStyle(Theme.foreground)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
        return VStack(alignment: .leading, spacing: 4) {
            Text("Agent 说明")
                .font(Theme.Fonts.meta)
                .foregroundStyle(Theme.mutedForeground)
            // A long reason scrolls inside a capped box instead of pushing the buttons off screen.
            ViewThatFits(in: .vertical) {
                text
                ScrollView { text }
            }
            .frame(maxHeight: 120)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.accentSurface, in: RoundedRectangle(cornerRadius: 16))
    }

    @ViewBuilder
    private var field: some View {
        if multiline {
            multilineSummary
        } else {
            HStack(spacing: 8) {
                singleLineField
                pasteButton
            }
            .padding(.leading, 16)
            .padding(.trailing, 7)
            .frame(height: 52)
            .background(Theme.terminal, in: RoundedRectangle(cornerRadius: 18))
            .overlay {
                RoundedRectangle(cornerRadius: 18)
                    .strokeBorder(Theme.mutedForeground.opacity(0.45), lineWidth: 1)
            }
        }
    }

    private var singleLineField: some View {
        // Own @State binding: voice results and the terminal input area never reach this field.
        // No auto-focus: the keyboard comes up only when the user taps in.
        SecureField("粘贴或输入 \(request.name)", text: $value)
            .textContentType(.password)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .submitLabel(.send)
            .onSubmit { submit(.provide(value)) }
            .onChange(of: value) { _, newValue in
                // Whatever the system paste menu let through, line breaks follow the same rule.
                guard newValue.unicodeScalars.contains(where: { $0 == "\n" || $0 == "\r" }) else { return }
                accept(newValue)
            }
            .privacySensitive()
            .disabled(isSubmitting)
            .font(Theme.Fonts.body.monospaced())
            .frame(maxHeight: .infinity)
            .accessibilityLabel("\(request.name) 的值")
    }

    /// Reads the pasteboard straight into the card's state: the only way a multi-line value gets in.
    private var pasteButton: some View {
        Button {
            guard let text = UIPasteboard.general.string, !text.isEmpty else { return }
            accept(text)
        } label: {
            Image(systemName: "doc.on.clipboard")
                .font(Theme.Fonts.label.weight(.semibold))
                .foregroundStyle(Theme.foreground)
                .frame(width: Theme.Metrics.roundButton, height: Theme.Metrics.roundButton)
                .background(Theme.accentSurface, in: Circle())
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isSubmitting)
        .opacity(isSubmitting ? 0.5 : 1)
        .accessibilityLabel("粘贴 \(request.name)")
    }

    /// A multi-line value is never shown, not even masked glyph by glyph: only its line count.
    private var multilineSummary: some View {
        HStack(spacing: 10) {
            Image(systemName: "lock.doc")
                .font(Theme.Fonts.body)
                .foregroundStyle(Theme.mutedForeground)
            VStack(alignment: .leading, spacing: 1) {
                Text("已粘贴 \(SecretPaste.lineCount(value)) 行内容")
                    .font(Theme.Fonts.label.weight(.semibold))
                    .foregroundStyle(Theme.foreground)
                Text("内容已隐藏，换行会原样保留")
                    .font(Theme.Fonts.meta)
                    .foregroundStyle(Theme.mutedForeground)
            }
            Spacer(minLength: 0)
            Button {
                value = ""
                multiline = false
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(Theme.Fonts.body)
                    .foregroundStyle(Theme.mutedForeground)
                    .frame(width: 30, height: 30)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(isSubmitting)
            .accessibilityLabel("清除粘贴的值")
        }
        .privacySensitive()
        .padding(.leading, 16)
        .padding(.trailing, 8)
        .frame(minHeight: 52)
        .background(Theme.terminal, in: RoundedRectangle(cornerRadius: 18))
        .overlay {
            RoundedRectangle(cornerRadius: 18)
                .strokeBorder(Theme.mutedForeground.opacity(0.45), lineWidth: 1)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(request.name) 的值，多行，已隐藏")
    }

    private func accept(_ text: String) {
        if let pasted = SecretPaste.multiline(text) {
            value = pasted
            multiline = true
        } else {
            value = SecretPaste.singleLine(text)
        }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("仅发送到\(deviceName.isEmpty ? "该设备" : "「\(deviceName)」")，Agent 无法查看 · \(deadline) 过期")
                .font(Theme.Fonts.label)
                .foregroundStyle(Theme.mutedForeground)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 10) {
                Button {
                    submit(.decline)
                } label: {
                    buttonLabel("拒绝", busy: isSubmitting(.decline), tint: Theme.foreground)
                        .background(Theme.accentSurface, in: Capsule())
                }
                .buttonStyle(.plain)
                .disabled(isSubmitting)
                Button {
                    submit(.provide(value))
                } label: {
                    buttonLabel("提供", busy: isSubmitting(.provide), tint: Theme.primaryForeground)
                        .background(Theme.primary, in: Capsule())
                }
                .buttonStyle(.plain)
                .disabled(isSubmitting || value.isEmpty)
                .opacity(isSubmitting || value.isEmpty ? 0.4 : 1)
            }
        }
    }

    private func buttonLabel(_ title: String, busy: Bool, tint: Color) -> some View {
        ZStack {
            Text(title)
                .font(Theme.Fonts.body.weight(.semibold))
                .opacity(busy ? 0 : 1)
            if busy {
                ProgressView()
                    .controlSize(.small)
                    .tint(tint)
            }
        }
        .foregroundStyle(tint)
        .frame(maxWidth: .infinity)
        .frame(height: 50)
        .contentShape(Capsule())
    }

    private func submit(_ answer: SecretAnswer) {
        guard !isSubmitting else { return }
        if case .provide(let secret) = answer, secret.isEmpty { return }
        let kind = answer.kind
        phase = .submitting(kind)
        Task {
            let result = await client.answerSecretRequest(requestID: request.requestID, answer: answer)
            let next = SecretCardPhase.after(kind, result: result)
            // A closed card forgets the value; a failed one keeps it for the retry.
            if case .closed = next { value = "" }
            phase = next
        }
    }
}

/// The paste rule shared with the desktop card (`multilineSecretFromPaste` in
/// apps/desktop/src/renderer/components/workbench/secret-request.ts, which carries the tests). A line
/// break is LF, CRLF or a lone CR. Line breaks only at the start or end — a key copied with a
/// trailing newline — keep the value single-line, with those line breaks dropped. A line break left
/// between content switches to multi-line, and the value is the pasted text with every CRLF and lone
/// CR normalized to LF and nothing else changed, trailing newline included.
enum SecretPaste {
    /// The multi-line value for a paste, or nil when it stays single-line.
    static func multiline(_ text: String) -> String? {
        // Foundation matches on UTF-16, so "\r\n" is found even though Swift treats it as one Character.
        let normalized = text
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        let scalars = normalized.unicodeScalars
        guard let first = scalars.firstIndex(where: { $0 != "\n" }),
              let last = scalars.lastIndex(where: { $0 != "\n" })
        else { return nil }
        return scalars[first...last].contains("\n") ? normalized : nil
    }

    /// A single-line paste: its surrounding line breaks dropped, as the password field does.
    static func singleLine(_ text: String) -> String {
        var kept = String.UnicodeScalarView()
        kept.append(contentsOf: text.unicodeScalars.lazy.filter { $0 != "\n" && $0 != "\r" })
        return String(kept)
    }

    /// Lines in an LF-normalized value; a trailing newline does not start another line.
    static func lineCount(_ value: String) -> Int {
        let breaks = value.unicodeScalars.reduce(0) { $0 + ($1 == "\n" ? 1 : 0) }
        return value.hasSuffix("\n") ? breaks : breaks + 1
    }
}
