import SwiftUI

@main
struct CofluxApp: App {
    var body: some Scene {
        WindowGroup {
            VStack(spacing: 12) {
                Image(systemName: "terminal")
                    .font(.system(size: 32, weight: .medium))
                Text("Coflux Native Probe")
                    .font(.headline)
                Text("原生终端、传输与本机身份互通验证中")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            .frame(minWidth: 520, minHeight: 320)
        }
        .windowStyle(.hiddenTitleBar)
    }
}
