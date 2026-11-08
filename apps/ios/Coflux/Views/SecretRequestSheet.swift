import CofluxClientCore
import CofluxProtocol
import SwiftUI

/// The secret requests of one terminal as a bottom sheet (plan D6, mockup frame O8), opened from
/// a home card or from the terminal page. The cards keep every rule of `SecretRequestCard`: the
/// value lives only in the card's own state, is masked, goes once to the requesting device and is
/// cleared when the card closes. The sheet closes itself once the terminal has nothing pending.
struct SecretRequestSheet: View {
    let client: CofluxClient
    let taskID: String
    @Environment(\.dismiss) private var dismiss

    private var requests: [SecretRequestInfo] {
        client.pendingSecretRequests(taskID: taskID)
    }

    var body: some View {
        ScrollView {
            SecretRequestCards(
                client: client,
                requests: requests,
                source: Self.source(taskID: taskID, client: client),
                deviceName: Self.deviceName(taskID: taskID, client: client)
            )
            .padding(.top, 8)
        }
        .scrollBounceBehavior(.basedOnSize)
        .background(Theme.card)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(34)
        .presentationBackground(Theme.card)
        .onChange(of: requests.isEmpty, initial: true) { _, empty in
            if empty { dismiss() }
        }
    }

    /// The device the request goes to: only it receives the value.
    @MainActor
    static func deviceName(taskID: String, client: CofluxClient) -> String {
        guard let task = client.tasks.first(where: { $0.id == taskID }) else {
            return client.secretRequests.values.first { $0.taskID == taskID }.map { client.deviceName($0.daemonID) } ?? ""
        }
        return client.deviceName(task.daemonID)
    }

    /// 设备 · 工作区 · 终端 — where a secret request comes from, as on the desktop card.
    @MainActor
    static func source(taskID: String, client: CofluxClient) -> String {
        let task = client.tasks.first { $0.id == taskID }
        let workspace = task.flatMap { task in client.workspaces.first { $0.id == task.workspaceID } }
        let terminal = task.map { $0.title.isEmpty ? "终端 \($0.id.prefix(6))" : $0.title } ?? ""
        return [deviceName(taskID: taskID, client: client), workspace?.displayTitle ?? "", terminal]
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
    }
}
