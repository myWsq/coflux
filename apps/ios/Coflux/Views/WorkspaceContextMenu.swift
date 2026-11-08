import CofluxClientCore
import CofluxProtocol
import SwiftUI
import UIKit

extension View {
    /// A workspace row's long press: copy its handle and, for any workspace but the project's main
    /// one, delete it (the desktop sidebar's menu; the centre refuses the main workspace too).
    func workspaceContextMenu(client: CofluxClient, workspace: Coflux_V1_Workspace) -> some View {
        modifier(WorkspaceContextMenu(client: client, workspace: workspace))
    }
}

/// Deleting asks first, with the desktop's wording: the worktree directory goes, the branch stays.
/// The row leaves at once (optimistic, `CofluxClient.removeWorkspace`) and comes back with an
/// error toast if the centre refuses.
private struct WorkspaceContextMenu: ViewModifier {
    let client: CofluxClient
    let workspace: Coflux_V1_Workspace
    @Environment(SceneNavigation.self) private var navigation
    @State private var confirmingRemove = false

    private var branch: String {
        workspace.branch.isEmpty ? workspace.displayTitle : workspace.branch
    }

    func body(content: Content) -> some View {
        content
            .contextMenu {
                if let handle = EntityHandle.make(.workspace, id: workspace.id) {
                    Button("复制 ID", systemImage: "doc.on.doc") {
                        UIPasteboard.general.string = handle
                    }
                }
                if !workspace.isMain {
                    Divider()
                    Button("删除工作区", systemImage: "trash", role: .destructive) {
                        confirmingRemove = true
                    }
                }
            }
            .confirmationDialog("删除工作区「\(branch)」？", isPresented: $confirmingRemove, titleVisibility: .visible) {
                Button("删除工作区", role: .destructive) { remove() }
            } message: {
                Text("对应的 git worktree 目录会被移除，分支「\(branch)」不会被自动删除。")
            }
    }

    private func remove() {
        guard client.removeWorkspace(workspaceID: workspace.id) else { return }
        // A window showing it (the split detail) goes back to no selection rather than to
        // "工作区不可用".
        if navigation.workspaceID == workspace.id {
            navigation.workspaceID = nil
        }
    }
}
