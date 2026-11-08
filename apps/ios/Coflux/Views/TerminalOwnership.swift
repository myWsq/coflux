import Foundation
import Observation

/// Which window owns each terminal (task id). Shared by every scene and created once next to the
/// `CofluxClient`: a session has a single consumer in the client, so a terminal is bound in at most
/// one window at a time. The unit is the mounted terminal view — a window's terminal page builds
/// `TerminalHostView` only for the tasks its scene owns and shows "已在另一个窗口打开" for the rest.
///
/// Rules (plan D12):
/// - a page claims each of its terminals on mount when nobody owns it, so a single window keeps
///   every terminal of the workspace alive, as before;
/// - activating a terminal (selecting it, swiping to it, opening it from a card, the sidebar or
///   the terminal list) claims it even when another window owns it;
/// - a page releases its claims when it is torn down (its holder deallocates), including when the
///   window closes.
///
/// A claim records the scene and the holder (one per mounted page). Ownership is per scene; the
/// holder only makes a release precise, so a page that a layout switch rebuilt in the same window
/// cannot drop the claim its replacement already took.
@MainActor
@Observable
final class TerminalOwnership {
    struct Owner: Equatable {
        let scene: UUID
        let holder: UUID
    }

    private(set) var owners: [String: Owner] = [:]

    func owner(of taskID: String) -> Owner? {
        owners[taskID]
    }

    func isOwned(_ taskID: String, by scene: UUID) -> Bool {
        owners[taskID]?.scene == scene
    }

    /// Claims `taskID` for `scene`. Without `force`, a terminal owned by another window is left
    /// alone; a terminal owned by this window passes to the newest holder.
    func claim(_ taskID: String, scene: UUID, holder: UUID, force: Bool) {
        let next = Owner(scene: scene, holder: holder)
        if let current = owners[taskID] {
            guard current != next else { return }
            guard force || current.scene == scene else { return }
        }
        owners[taskID] = next
    }

    /// Drops every claim the holder still has; claims taken over since are untouched.
    func release(holder: UUID) {
        guard owners.values.contains(where: { $0.holder == holder }) else { return }
        owners = owners.filter { $0.value.holder != holder }
    }
}

/// One mounted terminal page's handle on the registry. It lives in the page's `@State`, so its
/// claims are released when SwiftUI tears the page down (navigation pop, layout switch, window
/// close) — not on `onDisappear`, which also fires when a tab is merely hidden.
@MainActor
final class TerminalClaimHolder {
    let id = UUID()
    private weak var ownership: TerminalOwnership?

    func attach(_ ownership: TerminalOwnership) {
        self.ownership = ownership
    }

    isolated deinit {
        // Teardown can happen inside a view update; publish the change on the next turn.
        guard let ownership else { return }
        let holder = id
        Task { @MainActor [ownership] in ownership.release(holder: holder) }
    }
}
