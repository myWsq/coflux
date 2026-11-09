import SwiftUI
import UIKit

/// Lets the split view's own edge swipe win over the terminal pager. The floating sidebar comes
/// out with the system's interactive edge pan — it follows the finger, as the outer display's
/// swipe back does — but the pager's horizontal scroll view took every swipe that started at the
/// edge, so the sidebar never moved (seen on the Duo, 2026-11-10). Placed inside the pager's
/// content, this makes the pager's pan wait for that edge pan to fail: a swipe from the leading
/// edge brings the sidebar, any other swipe pages terminals at once.
///
/// The edge pan is found by the name UIKit gives it. If a later iOS renames it, nothing is
/// wired and the pager simply keeps the swipe, as before.
struct SidebarEdgeSwipe: UIViewRepresentable {
    func makeUIView(context: Context) -> WiringView {
        WiringView()
    }

    func updateUIView(_ uiView: WiringView, context: Context) {
        uiView.wire()
    }

    final class WiringView: UIView {
        private weak var wiredPan: UIGestureRecognizer?

        override init(frame: CGRect) {
            super.init(frame: frame)
            isUserInteractionEnabled = false
        }

        required init?(coder: NSCoder) {
            fatalError("init(coder:) is not used")
        }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            wire()
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            wire()
        }

        func wire() {
            guard window != nil,
                  let pager = enclosingScrollView(),
                  wiredPan !== pager.panGestureRecognizer,
                  let edgePan = splitEdgePan()
            else { return }
            pager.panGestureRecognizer.require(toFail: edgePan)
            wiredPan = pager.panGestureRecognizer
        }

        /// The nearest scroll view above this view: the pager (this view sits in its content).
        private func enclosingScrollView() -> UIScrollView? {
            var view = superview
            while let current = view {
                if let scrollView = current as? UIScrollView { return scrollView }
                view = current.superview
            }
            return nil
        }

        /// The split view's screen-edge pan on the leading edge, where the sidebar lives.
        private func splitEdgePan() -> UIGestureRecognizer? {
            var responder: UIResponder? = self
            while let current = responder, !(current is UISplitViewController) {
                responder = current.next
            }
            guard let split = responder as? UISplitViewController else { return nil }
            let side = effectiveUserInterfaceLayoutDirection == .leftToRight ? "Left" : "Right"
            let name = "InteractivePresentation\(side)ScreenEdgePanGestureRecognizer"
            return Self.recognizer(named: name, in: split.view, depth: 0)
        }

        private static func recognizer(named name: String, in view: UIView, depth: Int) -> UIGestureRecognizer? {
            if let found = view.gestureRecognizers?.first(where: { $0.name?.hasSuffix(name) == true }) {
                return found
            }
            guard depth < 3 else { return nil }
            for subview in view.subviews {
                if let found = recognizer(named: name, in: subview, depth: depth + 1) { return found }
            }
            return nil
        }
    }
}
