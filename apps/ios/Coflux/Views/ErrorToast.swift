import CofluxClientCore
import SwiftUI

/// Shows the client's latest error (`client.lastError`: a centre `error` reply or a local
/// failure) as a card at the top of the window for a few seconds; a tap dismisses it early. The
/// desktop shows the same errors as toasts — before this, iOS dropped them silently.
struct ErrorToast: View {
    let client: CofluxClient
    @State private var shown: ClientError?

    var body: some View {
        ZStack {
            if let shown {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(Theme.destructive)
                    Text(shown.message)
                        .font(Theme.Fonts.label.weight(.medium))
                        .foregroundStyle(Theme.foreground)
                        .lineLimit(3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .background(Theme.card, in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Theme.destructive.opacity(0.35), lineWidth: 1))
                .frame(maxWidth: 420)
                .padding(.horizontal, 12)
                .padding(.top, 6)
                .contentShape(.rect)
                .onTapGesture { self.shown = nil }
                .transition(.move(edge: .top).combined(with: .opacity))
                .accessibilityAddTraits(.isStaticText)
            }
        }
        .animation(.smooth(duration: 0.25), value: shown)
        .onChange(of: client.lastError?.id) { _, _ in
            shown = client.lastError
        }
        // Each new error restarts the clock.
        .task(id: shown?.id) {
            guard shown != nil else { return }
            try? await Task.sleep(for: .seconds(4))
            guard !Task.isCancelled else { return }
            shown = nil
        }
    }
}
