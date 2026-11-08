import CoreGraphics
import Foundation

/// Logs the display reconfigurations WindowServer notifies this process of, one line per burst.
///
/// CoreGraphics keeps a process's view of the displays (the online list, each display's modes)
/// current only by handling those notifications, which reach the process through AppKit's event
/// loop. A helper that does not run NSApplication handles them late or never (WindowServer may log
/// a 0.25 s timeout naming the pid) and keeps a stale view: a display it creates has no modes or
/// never shows up. This witness is the evidence, in the helper's own log, that notifications
/// arrive: a display created, resized, mirrored or destroyed without a matching line within a
/// second means they do not; a line that names a display both added and removed came too late.
public final class DisplayReconfigurationWitness {
    private let log: (String) -> Void
    /// Flags per display since the last line, in the order the displays first reported.
    private var pending: [(display: CGDirectDisplayID, flags: CGDisplayChangeSummaryFlags)] = []
    private var flushScheduled = false
    /// One configuration reports every display it touched, often twice, within a few ms; a resize
    /// or a mirror touches each display: gather them into one line.
    private static let coalesceDelay: TimeInterval = 0.25

    public init(log: @escaping (String) -> Void) {
        self.log = log
    }

    /// Register with CoreGraphics. Never unregistered: the witness lives as long as the process.
    public func start() {
        let context = Unmanaged.passRetained(self).toOpaque()
        let status = CGDisplayRegisterReconfigurationCallback({ display, flags, context in
            guard let context else { return }
            let witness = Unmanaged<DisplayReconfigurationWitness>.fromOpaque(context).takeUnretainedValue()
            DispatchQueue.main.async { witness.record(display, flags) }
        }, context)
        if status != .success {
            log("cannot register for display reconfiguration notifications (CGError \(status.rawValue))")
        }
    }

    private func record(_ display: CGDirectDisplayID, _ flags: CGDisplayChangeSummaryFlags) {
        // The "about to reconfigure" call carries nothing the completed one does not.
        guard !flags.contains(.beginConfigurationFlag) else { return }
        if let index = pending.firstIndex(where: { $0.display == display }) {
            pending[index].flags.formUnion(flags)
        } else {
            pending.append((display, flags))
        }
        guard !flushScheduled else { return }
        flushScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.coalesceDelay) { [weak self] in
            self?.flush()
        }
    }

    private func flush() {
        flushScheduled = false
        guard !pending.isEmpty else { return }
        let displays = pending.map { "\($0.display) [\(Self.describe($0.flags))]" }
        pending.removeAll()
        log("displays reconfigured: \(displays.joined(separator: ", "))")
    }

    private static let names: [(CGDisplayChangeSummaryFlags, String)] = [
        (.addFlag, "added"),
        (.removeFlag, "removed"),
        (.enabledFlag, "enabled"),
        (.disabledFlag, "disabled"),
        (.movedFlag, "moved"),
        (.setMainFlag, "main"),
        (.setModeFlag, "mode"),
        (.mirrorFlag, "mirror"),
        (.unMirrorFlag, "unmirror"),
        (.desktopShapeChangedFlag, "shape"),
    ]

    private static func describe(_ flags: CGDisplayChangeSummaryFlags) -> String {
        let named = names.filter { flags.contains($0.0) }.map(\.1)
        return named.isEmpty ? "0x\(String(flags.rawValue, radix: 16))" : named.joined(separator: " ")
    }
}
