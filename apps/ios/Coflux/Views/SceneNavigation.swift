import SwiftUI

/// The three layouts a window can take (AGENTS.md, "iOS app": designed for iPhone Duo). The choice
/// comes from the window's own size only — never from the display, the pose, the orientation or a
/// size class — so a Split View half of the inner display gets the same layout as the outer
/// display, and a window keeps its layout wherever it is shown.
enum ShellLayout: Equatable, Sendable {
    /// Tab bar + navigation stacks: the outer display, Split View halves, short wide windows.
    case compact
    /// A large window wider than tall (the inner display, open wide): sidebar + terminal.
    case split
    /// A large window taller than wide (the inner display, open tall): tab bar + stacks, with
    /// the tall terminal arrangement (laptop pose when half folded).
    case tall

    /// A window is "large" only when both of its sides are; then its aspect picks split or tall.
    /// Pinned sizes: 466×678, 678×466, 440×626 and 626×440 are compact, 890×626 is split and
    /// 626×890 is tall.
    static let largeLongSide: CGFloat = 760
    static let largeShortSide: CGFloat = 560

    static func choose(for window: CGSize) -> ShellLayout {
        let long = max(window.width, window.height)
        let short = min(window.width, window.height)
        guard long >= largeLongSide, short >= largeShortSide else { return .compact }
        return window.width > window.height ? .split : .tall
    }
}

extension EnvironmentValues {
    /// The layout the enclosing window chose; the terminal page arranges itself from it.
    @Entry var shellLayout: ShellLayout = .compact
}

/// A pushed workspace page in the 首页 stack.
struct HomeRoute: Hashable {
    let workspaceID: String
}

/// A pushed device page in the 设备 stack.
struct DeviceRoute: Hashable {
    let daemonID: String
}

/// Navigation state of one window (scene). Owned by the scene's root view and shared through the
/// environment, so switching between the compact, split and tall layouts — which rebuilds the
/// containers — keeps the selected tab, workspace and terminal. Two windows have two instances
/// and therefore independent selections.
@MainActor
@Observable
final class SceneNavigation {
    enum Tab: Hashable {
        case home
        case devices
    }

    /// Identifies this window to the terminal ownership registry.
    let sceneID = UUID()
    var tab: Tab = .home
    /// The workspace shown by the 首页 stack (compact/tall) or the split detail.
    var workspaceID: String?
    /// The active terminal per workspace: the terminal page reads and writes it, so the page that
    /// a layout switch rebuilds lands on the same terminal.
    private(set) var activeTaskByWorkspace: [String: String] = [:]
    var devicePath: [DeviceRoute] = []
    var columnVisibility: NavigationSplitViewVisibility = .all
    /// A terminal created from home that opens once it appears in the snapshot.
    var pendingTerminal: PendingTerminal?

    struct PendingTerminal: Equatable {
        let workspaceID: String
        let knownTaskIDs: Set<String>
    }

    /// The 首页 stack holds at most the selected workspace; popping it clears the selection.
    var homePath: [HomeRoute] {
        get { workspaceID.map { [HomeRoute(workspaceID: $0)] } ?? [] }
        set { workspaceID = newValue.last?.workspaceID }
    }

    /// The terminal selected in this window, if a workspace is selected.
    var selectedTaskID: String? {
        workspaceID.flatMap { activeTaskByWorkspace[$0] }
    }

    func activeTaskID(in workspaceID: String) -> String? {
        activeTaskByWorkspace[workspaceID]
    }

    func setActiveTask(_ taskID: String?, in workspaceID: String) {
        guard activeTaskByWorkspace[workspaceID] != taskID else { return }
        activeTaskByWorkspace[workspaceID] = taskID
    }

    /// The single entry point for "show workspace W with terminal T active" (home cards, sidebar
    /// rows, the new-terminal picker). A nil terminal keeps the workspace's last active one.
    func show(workspaceID: String, taskID: String?) {
        tab = .home
        if let taskID { activeTaskByWorkspace[workspaceID] = taskID }
        self.workspaceID = workspaceID
    }

    func reset() {
        tab = .home
        workspaceID = nil
        activeTaskByWorkspace = [:]
        devicePath = []
        columnVisibility = .all
        pendingTerminal = nil
    }
}
