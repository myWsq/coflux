import CoreGraphics
import CVirtualDisplay
import Foundation

/// The virtual display behind an adapter, so the private `CGVirtualDisplay` classes (macOS 26 and
/// 27) can be swapped for the macOS 27 SkyLight `SLVirtualDisplay` family later without touching
/// the session. Measured facts the implementation respects (see the plan's Decisions):
///  1. re-applying settings on the same object changes resolution and keeps the displayID;
///  2. with hiDPI the mode is given in points and the system offers the HiDPI mode at twice it in
///     pixels, but may not land on it by itself: it is selected explicitly afterwards from the
///     modes the system then offers;
///  3. while every display sleeps WindowServer defers all configuration: the displays are woken
///     and the display waited for before creating, capturing or destroying — and the same serial
///     number is reused on every attempt (a lingering display is deferred, not leaked);
///  4. a process exit removes its virtual displays.
public protocol VirtualDisplayProvider: AnyObject {
    var displayID: CGDirectDisplayID { get }
    /// Create the display on first use, then change its resolution in place.
    func apply(_ geometry: DisplayGeometry) throws
    func destroy()
}

public final class CGVirtualDisplayProvider: VirtualDisplayProvider {
    private var display: CGVirtualDisplay?

    public init() {}

    public var displayID: CGDirectDisplayID { display?.displayID ?? 0 }

    public func apply(_ geometry: DisplayGeometry) throws {
        if display == nil {
            let descriptor = CGVirtualDisplayDescriptor()
            descriptor.name = "Coflux Screen"
            descriptor.maxPixelsWide = UInt32(DisplayModeSelection.maxPixels)
            descriptor.maxPixelsHigh = UInt32(DisplayModeSelection.maxPixels)
            // Roughly a 27" panel: the physical size only affects the point density the system
            // assumes, and the HiDPI mode is selected explicitly anyway.
            descriptor.sizeInMillimeters = CGSize(width: 600, height: 340)
            descriptor.vendorID = 0x434F // "CO"
            descriptor.productID = 0x4658 // "FX"
            // Fixed on purpose: WindowServer may still be deferring an earlier attempt.
            descriptor.serialNum = 1
            descriptor.queue = DispatchQueue.main
            descriptor.terminationHandler = nil
            display = CGVirtualDisplay(descriptor: descriptor)
        }
        guard let display else { throw HelperError.display("CGVirtualDisplay unavailable") }
        let settings = CGVirtualDisplaySettings()
        settings.hiDPI = geometry.scale == 2 ? 1 : 0
        // With hiDPI set, the mode's size is read as points: the system then offers the native
        // HiDPI mode at twice it in pixels. Given pixels, it would build a mode twice as large and
        // offer the wanted one only as unusable for the desktop, which a selection refuses with
        // kCGErrorFailure (measured on macOS 27).
        settings.modes = [
            CGVirtualDisplayMode(width: UInt(geometry.widthPoints), height: UInt(geometry.heightPoints), refreshRate: 60),
        ]
        guard display.apply(settings) else {
            throw HelperError.display("applySettings refused \(geometry.widthPixels)x\(geometry.heightPixels)")
        }
    }

    public func destroy() {
        display = nil
    }
}

/// Display-level operations around the provider: waking displays, waiting for the virtual display
/// to come online, selecting the HiDPI mode and mirroring the physical displays onto it. All of it
/// is applied `.forAppOnly`, so a helper crash reverts the arrangement by itself.
public enum DisplayConfiguration {
    /// Wake sleeping displays (lid closed, monitor asleep) and wait until the main display reports
    /// awake, up to `timeout`. WindowServer applies deferred configuration the moment they wake.
    public static func wakeDisplays(power: PowerAssertions, timeout: TimeInterval = 5, completion: @escaping () -> Void) {
        power.declareActivity()
        let deadline = Date().addingTimeInterval(timeout)
        func poll() {
            if CGDisplayIsAsleep(CGMainDisplayID()) == 0 || Date() >= deadline {
                completion()
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { poll() }
            }
        }
        poll()
    }

    /// Wait until `displayID` is in the online display list (the reconfiguration landed).
    public static func waitOnline(_ displayID: CGDirectDisplayID, timeout: TimeInterval = 5, completion: @escaping (Bool) -> Void) {
        let deadline = Date().addingTimeInterval(timeout)
        func poll() {
            if onlineDisplays().contains(displayID) {
                completion(true)
            } else if Date() >= deadline {
                completion(false)
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { poll() }
            }
        }
        poll()
    }

    /// Run `attempt` until it stops throwing, every `interval` up to `timeout`; the completion carries
    /// the last failure. A virtual display that just came online (or was just re-applied) is still
    /// being reconfigured: WindowServer refuses a mode change or a mirror with kCGErrorFailure until
    /// it settles, and accepts the same request a moment later (measured on macOS 27).
    public static func settle(timeout: TimeInterval = 3, interval: TimeInterval = 0.2, _ attempt: @escaping () throws -> Void, completion: @escaping (Error?) -> Void) {
        let deadline = Date().addingTimeInterval(timeout)
        func poll() {
            do {
                try attempt()
                completion(nil)
            } catch {
                if Date() >= deadline {
                    completion(error)
                } else {
                    DispatchQueue.main.asyncAfter(deadline: .now() + interval) { poll() }
                }
            }
        }
        poll()
    }

    public static func onlineDisplays() -> [CGDirectDisplayID] {
        var count: UInt32 = 0
        var ids = [CGDirectDisplayID](repeating: 0, count: 32)
        guard CGGetOnlineDisplayList(32, &ids, &count) == .success else { return [] }
        return Array(ids[0..<Int(count)])
    }

    /// Select the mode that is exactly `geometry` (pixels and points) on `displayID`.
    public static func selectMode(_ geometry: DisplayGeometry, on displayID: CGDirectDisplayID) throws {
        let options: [CFString: Any] = [kCGDisplayShowDuplicateLowResolutionModes: kCFBooleanTrue!]
        guard let modes = CGDisplayCopyAllDisplayModes(displayID, options as CFDictionary) as? [CGDisplayMode] else {
            throw HelperError.display("no display modes for \(displayID)")
        }
        let candidates = modes.map {
            DisplayModeSelection.Candidate(
                pixelWidth: $0.pixelWidth, pixelHeight: $0.pixelHeight,
                pointWidth: $0.width, pointHeight: $0.height, refreshRate: $0.refreshRate
            )
        }
        guard let index = DisplayModeSelection.select(geometry, from: candidates) else {
            throw HelperError.display("no \(geometry.widthPoints)x\(geometry.heightPoints)@\(geometry.scale)x mode offered")
        }
        if let current = CGDisplayCopyDisplayMode(displayID),
           current.pixelWidth == modes[index].pixelWidth, current.pixelHeight == modes[index].pixelHeight,
           current.width == modes[index].width, current.height == modes[index].height {
            return
        }
        var config: CGDisplayConfigRef?
        guard CGBeginDisplayConfiguration(&config) == .success, let config else {
            throw HelperError.display("cannot begin display configuration")
        }
        CGConfigureDisplayWithDisplayMode(config, displayID, modes[index], nil)
        let status = CGCompleteDisplayConfiguration(config, .forAppOnly)
        guard status == .success else {
            throw HelperError.display("mode selection refused (CGError \(status.rawValue))")
        }
    }

    /// Make the virtual display main and every other online display a mirror of it, so both
    /// sides see the same thing and the lid can stay closed.
    public static func mirrorAll(onto virtualDisplay: CGDirectDisplayID) throws {
        var config: CGDisplayConfigRef?
        guard CGBeginDisplayConfiguration(&config) == .success, let config else {
            throw HelperError.display("cannot begin display configuration")
        }
        CGConfigureDisplayOrigin(config, virtualDisplay, 0, 0)
        for display in onlineDisplays() where display != virtualDisplay {
            CGConfigureDisplayMirrorOfDisplay(config, display, virtualDisplay)
        }
        let status = CGCompleteDisplayConfiguration(config, .forAppOnly)
        guard status == .success else {
            throw HelperError.display("mirroring refused (CGError \(status.rawValue))")
        }
    }

    /// Back to the arrangement saved by the user; what a process exit does implicitly.
    public static func restoreArrangement() {
        CGRestorePermanentDisplayConfiguration()
    }
}
