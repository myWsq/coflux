import CofluxClientCore
import SwiftUI

/// Agent secret request cards (plan 20260926-ios-secret-input), anchored at the top of the
/// requesting terminal page below the status strip: the page is immune to the keyboard, so a card at
/// the bottom would have its buttons covered once the field raises it. Same content and states as
/// the desktop card (apps/desktop/.../secret-request-card.tsx). Every client of the account shows
/// the request; the first answer wins, and a request that leaves the live set (answered elsewhere,
/// expired, the agent stopped waiting) simply stops being rendered.
///
/// The cards never take focus on their own: the user taps into the field. The typed value lives only
/// in the card's own `@State` — never in the input area's draft, the compose overlay, dictation, the
/// store or the pasteboard — until it is sent once to the device's worker over the end-to-end Device
/// channel; it is cleared when the card closes.
struct SecretRequestCards: View {
    let client: CofluxClient
    let requests: [SecretRequestInfo]
    /// 设备 · 工作区 · 终端
    let source: String
    let deviceName: String

    var body: some View {
        if !requests.isEmpty {
            VStack(spacing: 8) {
                ForEach(requests) { request in
                    SecretRequestCard(client: client, request: request, source: source, deviceName: deviceName)
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)
        }
    }
}

private struct SecretRequestCard: View {
    let client: CofluxClient
    let request: SecretRequestInfo
    let source: String
    let deviceName: String
    @State private var value = ""
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
        VStack(alignment: .leading, spacing: 10) {
            header
            if !request.reason.isEmpty {
                reason
            }
            field
            if let failure {
                Text("\(failure)，可以重试。")
                    .font(Theme.Fonts.label)
                    .foregroundStyle(Theme.destructive)
                    .fixedSize(horizontal: false, vertical: true)
            }
            footer
        }
        .padding(14)
        .glassEffect(.regular, in: .rect(cornerRadius: 18))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Agent 请求输入 \(request.name)")
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "key.fill")
                .font(Theme.Fonts.label)
                .foregroundStyle(Theme.warning)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text("Agent 请求输入")
                        .font(Theme.Fonts.label.weight(.semibold))
                        .foregroundStyle(Theme.foreground)
                    Text(request.name)
                        .font(Theme.Fonts.label.monospaced())
                        .foregroundStyle(Theme.foreground)
                        .lineLimit(1)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Theme.secondarySurface, in: RoundedRectangle(cornerRadius: 4))
                }
                Text(source)
                    .font(Theme.Fonts.meta)
                    .foregroundStyle(Theme.mutedForeground)
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
                    .frame(width: 30, height: 30)
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
        return VStack(alignment: .leading, spacing: 3) {
            Text("Agent 说")
                .font(Theme.Fonts.meta)
                .foregroundStyle(Theme.mutedForeground)
            // A long reason scrolls inside a capped box instead of pushing the buttons off screen.
            ViewThatFits(in: .vertical) {
                text
                ScrollView { text }
            }
            .frame(maxHeight: 120)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.secondarySurface.opacity(0.7), in: RoundedRectangle(cornerRadius: 10))
    }

    private var field: some View {
        // Own @State binding: voice results and the terminal input area never reach this field.
        // No auto-focus: the keyboard comes up only when the user taps in.
        SecureField("粘贴或输入 \(request.name)", text: $value)
            .textContentType(.password)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .submitLabel(.send)
            .onSubmit { submit(.provide(value)) }
            .privacySensitive()
            .disabled(isSubmitting)
            .font(Theme.Fonts.body)
            .padding(.horizontal, 12)
            .frame(height: 42)
            .background(Theme.input, in: RoundedRectangle(cornerRadius: 10))
            .accessibilityLabel("\(request.name) 的值")
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("只交给 \(deviceName.isEmpty ? "该设备" : deviceName)，Agent 看不到 · \(deadline) 过期")
                .font(Theme.Fonts.meta)
                .foregroundStyle(Theme.mutedForeground)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Spacer(minLength: 0)
                Button {
                    submit(.decline)
                } label: {
                    buttonLabel("拒绝", busy: isSubmitting(.decline), tint: Theme.foreground)
                        .background(Theme.secondarySurface, in: RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)
                .disabled(isSubmitting)
                Button {
                    submit(.provide(value))
                } label: {
                    buttonLabel("提供", busy: isSubmitting(.provide), tint: Theme.primaryForeground)
                        .background(Theme.primary, in: RoundedRectangle(cornerRadius: 8))
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
                .font(Theme.Fonts.label.weight(.semibold))
                .opacity(busy ? 0 : 1)
            if busy {
                ProgressView()
                    .controlSize(.small)
                    .tint(tint)
            }
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 16)
        .frame(height: 34)
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
