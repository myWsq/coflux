import CofluxProtocol
import CoreGraphics
import CoreMedia
import Foundation

/// The helper's authority: one session per Mac, its holder, virtual display, capture, encoder,
/// input, pasteboard, cursor, power assertions, permission reports and the orphan grace. Driven
/// entirely on the main queue by frames from the worker socket. The worker only bridges lanes:
/// every `DeviceEnvelope` here carries the lane (channel id) it came from or goes to.
public final class ScreenHelper: HelperServerDelegate {
    public static let protocolVersion: UInt32 = 1
    public static let deviceProtocolVersion: UInt32 = 1
    /// Largest `ScreenVideoFrame.data` per message (SCREEN_VIDEO_CHUNK_BYTES).
    public static let videoChunkBytes = 256 * 1024
    /// The most credit a lane may hold (the worker clamps to the same: 64 records of a chunk).
    public static let maxCreditBytes = 64 * 256 * 1024
    public static let orphanGrace: TimeInterval = 10 * 60
    public static let idleExitDelay: TimeInterval = 5

    private let server: HelperServer
    private let version: String
    private let log: (String) -> Void
    private var connection: Int?
    private var greeted = false
    private var arbiter = HolderArbiter()
    private var session: Session?
    private var permissions = PermissionState.current()
    private let prompter = PermissionPrompter()
    private let power = PowerAssertions()
    private var graceTimer: DispatchSourceTimer?
    private var exitTimer: DispatchSourceTimer?
    private var permissionTimer: DispatchSourceTimer?
    private let provider: VirtualDisplayProvider
    /// Told by the worker that this binary is stale: no longer listening, exiting once the session ends.
    private var retiring = false

    public init(server: HelperServer, version: String, provider: VirtualDisplayProvider = CGVirtualDisplayProvider(), log: @escaping (String) -> Void) {
        self.server = server
        self.version = version
        self.provider = provider
        self.log = log
        server.delegate = self
        scheduleIdleExit()
    }

    // MARK: - Worker connection

    public func serverAccepted(connection: Int) {
        if let previous = self.connection, previous != connection {
            lanesLost()
        }
        self.connection = connection
        greeted = false
        cancelIdleExit()
        log("worker connected (#\(connection))")
    }

    public func serverClosed(connection: Int) {
        guard self.connection == connection else { return }
        self.connection = nil
        greeted = false
        log("worker disconnected (#\(connection))")
        lanesLost()
        scheduleIdleExit()
    }

    public func server(connection: Int, received record: Data) {
        guard self.connection == connection else { return }
        let frame: Coflux_V1_ScreenHelperFrame
        do { frame = try Coflux_V1_ScreenHelperFrame(serializedBytes: record) } catch {
            log("malformed frame from worker: \(error)")
            return
        }
        switch frame.payload {
        case .hello(let hello)?:
            var ack = Coflux_V1_ScreenHelperHelloAck()
            ack.protocolVersion = Self.protocolVersion
            ack.helperVersion = version
            ack.ok = hello.protocolVersion == Self.protocolVersion
            if !ack.ok { ack.error = "unsupported worker protocol \(hello.protocolVersion)" }
            permissions = PermissionState.current()
            ack.permissions = permissionsMessage()
            ack.sessionActive = session != nil
            greeted = ack.ok
            var reply = Coflux_V1_ScreenHelperFrame()
            reply.payload = .helloAck(ack)
            sendFrame(reply)
            log("hello from worker \(hello.workerVersion): \(ack.ok ? "ok" : "refused")")
        case .channelClosed(let closed)?:
            laneClosed(closed.channelID)
        case .retire(let retire)?:
            // A newer desktop build shipped another helper: give up the socket now so it can take
            // the path. The connection this came on stays up, so a live session keeps being served
            // until it ends, and this process exits then (or now, holding none). With tear_down the
            // worker cannot serve through this helper at all: the session ends at once — display
            // removed, arrangement restored, no grace — before exiting. Two helpers never hold
            // virtual displays at the same time.
            retiring = true
            server.stopListening()
            if retire.tearDown, let session {
                log("retire with tear-down requested by worker; ending the session now")
                tearDown(session, restore: true)
                arbiter.end()
                self.session = nil
            } else {
                log("retire requested by worker; \(session == nil ? "exiting" : "serving the live session until it ends")")
            }
            exitIfRetired()
        case .envelope(let envelope)?:
            guard greeted else { return }
            handle(envelope)
        case .helloAck?, .none:
            break
        }
    }

    // MARK: - Envelopes

    private func handle(_ envelope: Coflux_V1_DeviceEnvelope) {
        let lane = envelope.channelID
        switch envelope.payload {
        case .screenSessionOpen(let open)?:
            handleOpen(open, lane: lane)
        case .screenSessionClose(let close)?:
            handleClose(close, lane: lane)
        case .screenSessionResize(let resize)?:
            guard let session, arbiter.isCurrent(epoch: resize.holderEpoch), session.id == resize.sessionID else { return }
            guard resize.resizeSeq > session.resizeSeq else { return }
            session.resizeSeq = resize.resizeSeq
            guard let geometry = DisplayModeSelection.requested(widthPoints: Int(resize.widthPoints), heightPoints: Int(resize.heightPoints), scale: Int(resize.scale)) else { return }
            applyGeometry(geometry, to: session) { [weak self] error in
                guard let self, self.session === session else { return }
                if let error { session.lastError = "\(error)" }
                self.sendState(session)
                self.restartCapture(session)
            }
        case .screenSessionPause(let pause)?:
            guard let session, arbiter.isCurrent(epoch: pause.holderEpoch), session.id == pause.sessionID else { return }
            session.paused = true
            stopCapture(session)
            sendState(session)
        case .screenSessionResume(let resume)?:
            guard let session, arbiter.isCurrent(epoch: resume.holderEpoch), session.id == resume.sessionID else { return }
            session.paused = false
            session.credit.requireKeyframe()
            startCaptureIfPossible(session)
            sendState(session)
        case .screenVideoAttach(let attach)?:
            guard let session, session.id == attach.sessionID, arbiter.attachVideo(lane: lane, epoch: attach.holderEpoch) else {
                var refused = Coflux_V1_ScreenVideoAttached()
                refused.sessionID = attach.sessionID
                refused.ok = false
                refused.error = "no such session or stale holder epoch"
                send(lane, .screenVideoAttached(refused))
                return
            }
            let credit = min(Int(clamping: attach.creditBytes), Self.maxCreditBytes)
            session.videoLane = lane
            session.credit.reset(initialCredit: credit)
            session.window = credit
            session.bitrate = BitrateController(initialCredit: credit)
            session.encoder?.setBitrate(session.bitrate.bitsPerSecond)
            var attached = Coflux_V1_ScreenVideoAttached()
            attached.sessionID = session.id
            attached.ok = true
            send(lane, .screenVideoAttached(attached))
            startCaptureIfPossible(session)
        case .screenVideoCredit(let credit)?:
            guard let session, session.id == credit.sessionID, session.videoLane == lane else { return }
            session.stats.creditGranted += Int(clamping: credit.bytes)
            session.credit.grant(Int(clamping: credit.bytes))
        case .screenKeyframeRequest(let request)?:
            guard let session, session.id == request.sessionID else { return }
            session.credit.requireKeyframe()
        case .screenInput(let input)?:
            guard let session, arbiter.isCurrent(epoch: input.holderEpoch), session.id == input.sessionID else { return }
            guard permissions.accessibility else { return }
            switch input.event {
            case .key(let key)?:
                session.input.key(code: key.code, down: key.down, modifiers: key.modifiers, repeat: key.`repeat`)
            case .pointer(let pointer)?:
                let action: InputInjector.PointerAction
                switch pointer.action {
                case .down: action = .down
                case .up: action = .up
                default: action = .move
                }
                session.input.pointer(action, x: pointer.x, y: pointer.y, button: pointer.button, modifiers: pointer.modifiers, clickCount: pointer.clickCount)
            case .scroll(let scroll)?:
                session.input.scroll(x: scroll.x, y: scroll.y, deltaX: scroll.deltaX, deltaY: scroll.deltaY, modifiers: scroll.modifiers, precise: scroll.precise)
            case .none:
                break
            }
        case .screenClipboardSet(let set)?:
            guard let session, arbiter.isCurrent(epoch: set.holderEpoch), session.id == set.sessionID else { return }
            switch set.content.content {
            case .text(let text)?:
                session.pasteboard.apply(.text(text))
            case .png(let png)?:
                guard png.count <= PasteboardSync.maxBytes else { return }
                session.pasteboard.apply(.png(png))
            case .none:
                break
            }
        default:
            break
        }
    }

    private func handleOpen(_ open: Coflux_V1_ScreenSessionOpen, lane: String) {
        func refuse(_ code: String, _ message: String) {
            var opened = Coflux_V1_ScreenSessionOpened()
            opened.requestID = open.requestID
            opened.sessionID = open.sessionID
            opened.ok = false
            opened.code = code
            opened.error = message
            opened.status = statusMessage(session)
            send(lane, .screenSessionOpened(opened))
        }
        guard !open.sessionID.isEmpty,
              let geometry = DisplayModeSelection.requested(widthPoints: Int(open.widthPoints), heightPoints: Int(open.heightPoints), scale: Int(open.scale))
        else { return refuse("invalid", "empty session id or zero size") }
        guard open.codecs.contains(.h264) else { return refuse("unsupported_codec", "only H.264 is available") }
        switch arbiter.open(clientInstanceID: open.clientInstanceID, controlLane: lane, force: open.force) {
        case .refused:
            refuse("held", "another client holds this screen")
            return
        case .held(let epoch, let detachedLane):
            if let detachedLane {
                var detached = Coflux_V1_ScreenSessionDetached()
                detached.sessionID = session?.id ?? open.sessionID
                detached.holderEpoch = epoch - 1
                detached.reason = "taken over"
                send(detachedLane, .screenSessionDetached(detached))
            }
            cancelGrace()
            prompter.reset()
            let session: Session
            if let existing = self.session, existing.id == open.sessionID {
                session = existing
                session.controlLane = lane
                // A preempting or reconnecting holder starts with a fresh video lane; whatever the
                // previous holder still held down is released.
                if detachedLane != nil {
                    stopCapture(session)
                    session.videoLane = nil
                    session.input.releaseAll()
                }
            } else {
                if let existing = self.session { tearDown(existing, restore: false) }
                session = Session(id: open.sessionID, controlLane: lane, geometry: geometry)
                self.session = session
                power.acquire()
                startPermissionPolling()
                wireSession(session)
            }
            session.epoch = epoch
            permissions = PermissionState.current()
            prompter.promptIfMissing(permissions)
            let previous = session.geometry
            session.geometry = geometry
            let needsApply = session.displayReady == false || previous != geometry
            let finish: (Error?) -> Void = { [weak self] error in
                guard let self, self.session === session, self.arbiter.isCurrent(epoch: epoch) else { return }
                if let error {
                    session.lastError = "\(error)"
                    self.log("display failed: \(error)")
                    var opened = Coflux_V1_ScreenSessionOpened()
                    opened.requestID = open.requestID
                    opened.sessionID = session.id
                    opened.ok = false
                    opened.code = "no_display"
                    opened.error = "\(error)"
                    opened.holderEpoch = epoch
                    opened.status = self.statusMessage(session)
                    self.send(lane, .screenSessionOpened(opened))
                    return
                }
                var opened = Coflux_V1_ScreenSessionOpened()
                opened.requestID = open.requestID
                opened.sessionID = session.id
                opened.ok = true
                opened.holderEpoch = epoch
                opened.codec = .h264
                opened.status = self.statusMessage(session)
                self.send(lane, .screenSessionOpened(opened))
                self.startCaptureIfPossible(session)
            }
            if needsApply {
                applyGeometry(geometry, to: session, completion: finish)
            } else {
                finish(nil)
            }
        }
    }

    private func handleClose(_ close: Coflux_V1_ScreenSessionClose, lane: String) {
        var closed = Coflux_V1_ScreenSessionClosed()
        closed.requestID = close.requestID
        closed.sessionID = close.sessionID
        guard let session, session.id == close.sessionID, arbiter.isCurrent(epoch: close.holderEpoch) else {
            closed.ok = false
            closed.error = "no such session or stale holder epoch"
            send(lane, .screenSessionClosed(closed))
            return
        }
        let videoLane = session.videoLane
        tearDown(session, restore: true)
        arbiter.end()
        self.session = nil
        closed.ok = true
        send(lane, .screenSessionClosed(closed))
        exitIfRetired()
        if let videoLane, videoLane != lane {
            var ended = Coflux_V1_ScreenSessionEnded()
            ended.sessionID = close.sessionID
            ended.reason = "closed"
            send(videoLane, .screenSessionEnded(ended))
        }
        if connection == nil { scheduleIdleExit() }
    }

    // MARK: - Lanes

    private func laneClosed(_ lane: String) {
        guard let session else { return }
        if session.videoLane == lane {
            session.videoLane = nil
            stopCapture(session)
        }
        if session.controlLane == lane {
            session.controlLane = nil
            session.input.releaseAll()
        }
        if arbiter.laneClosed(lane) {
            startGrace()
        }
    }

    /// The worker went away: every lane with it. The session stays for the grace period.
    private func lanesLost() {
        guard let session else { return }
        if let lane = session.videoLane { laneClosed(lane) }
        if let lane = session.controlLane { laneClosed(lane) }
        if !(arbiter.holder?.hasLane ?? false) { startGrace() }
    }

    private func startGrace() {
        guard graceTimer == nil, session != nil else { return }
        log("no lane holds the session; ending it in \(Int(Self.orphanGrace)) s unless one returns")
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + Self.orphanGrace)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            self.graceTimer = nil
            guard let session = self.session, !(self.arbiter.holder?.hasLane ?? false) else { return }
            self.log("orphan grace expired; ending the session")
            self.tearDown(session, restore: true)
            self.arbiter.end()
            self.session = nil
            self.exitIfRetired()
            if self.connection == nil { self.scheduleIdleExit() }
        }
        timer.resume()
        graceTimer = timer
    }

    private func cancelGrace() {
        graceTimer?.cancel()
        graceTimer = nil
    }

    // MARK: - Session plumbing

    private func wireSession(_ session: Session) {
        session.capture.onFrame = { [weak self, weak session] sample in
            guard let self, let session, self.session === session else { return }
            self.captured(sample, session)
        }
        session.capture.onStopped = { [weak self, weak session] error in
            guard let self, let session, self.session === session else { return }
            self.log("capture stopped: \(error.map { "\($0)" } ?? "-")")
            session.encoder?.invalidate()
            session.encoder = nil
            if !session.paused {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                    guard let self, self.session === session else { return }
                    self.startCaptureIfPossible(session)
                }
            }
        }
        session.pasteboard.onChanged = { [weak self, weak session] content in
            guard let self, let session, let lane = session.controlLane else { return }
            var changed = Coflux_V1_ScreenClipboardChanged()
            changed.sessionID = session.id
            switch content {
            case .text(let text): changed.content.text = text
            case .png(let png): changed.content.png = png
            }
            self.send(lane, .screenClipboardChanged(changed))
        }
        session.cursor.onUpdate = { [weak self, weak session] update in
            guard let self, let session, let lane = session.controlLane, !session.paused else { return }
            var cursor = Coflux_V1_ScreenCursor()
            cursor.sessionID = session.id
            cursor.x = update.x
            cursor.y = update.y
            cursor.visible = update.visible
            if let shape = update.shape {
                cursor.shape.png = shape.png
                cursor.shape.widthPoints = UInt32(shape.widthPoints)
                cursor.shape.heightPoints = UInt32(shape.heightPoints)
                cursor.shape.hotspotX = shape.hotspotX
                cursor.shape.hotspotY = shape.hotspotY
            }
            self.send(lane, .screenCursor(cursor))
        }
        let tick = DispatchSource.makeTimerSource(queue: .main)
        tick.schedule(deadline: .now() + 1, repeating: 1)
        tick.setEventHandler { [weak self, weak session] in
            guard let self, let session, self.session === session else { return }
            // One line every 30 s while streaming: enough to tell, after the fact, which stage a
            // frozen picture stalled in (capture, credit, encoder, lane) without flooding the log.
            session.ticks += 1
            if session.ticks % 30 == 0, !session.paused {
                let stats = session.stats
                session.stats = PipelineStats()
                self.log("stats 30s: captured \(stats.captured), no-credit \(stats.noCredit), encode \(stats.encodeCalls), encoded \(stats.encoded), sent \(stats.sent) (\(stats.sentBytes) B), credit back \(stats.creditGranted) B; available \(session.credit.available) B, outstanding \(session.credit.outstanding) B; capture \(session.capture.running ? "on" : "off"), paused \(session.paused), video lane \(session.videoLane != nil), display ready \(session.displayReady)")
            }
            guard let encoder = session.encoder else { return }
            let dropped = session.credit.droppedFrames - session.droppedAtLastTick
            session.droppedAtLastTick = session.credit.droppedFrames
            if session.bitrate.tick(droppedFrames: dropped, outstanding: session.credit.outstanding, window: session.window) {
                encoder.setBitrate(session.bitrate.bitsPerSecond)
            }
        }
        tick.resume()
        session.bitrateTimer = tick
    }

    /// Wake displays, create/resize the virtual display, select its HiDPI mode and mirror the
    /// physical displays onto it; the callback carries the first failure.
    private func applyGeometry(_ geometry: DisplayGeometry, to session: Session, completion: @escaping (Error?) -> Void) {
        session.phase = .starting
        stopCapture(session)
        DisplayConfiguration.wakeDisplays(power: power) { [weak self] in
            guard let self, self.session === session else { return }
            do {
                try self.provider.apply(geometry)
            } catch {
                session.displayReady = false
                completion(error)
                return
            }
            let displayID = self.provider.displayID
            DisplayConfiguration.waitOnline(displayID) { [weak self] online in
                guard let self, self.session === session else { return }
                guard online else {
                    session.displayReady = false
                    completion(HelperError.display("virtual display did not come online (displays asleep?)"))
                    return
                }
                let fail: (Error) -> Void = { error in
                    session.displayReady = false
                    completion(error)
                }
                DisplayConfiguration.settle({ try DisplayConfiguration.selectMode(geometry, on: displayID) }) { [weak self] error in
                    guard let self, self.session === session else { return }
                    if let error { return fail(error) }
                    DisplayConfiguration.settle({ try DisplayConfiguration.mirrorAll(onto: displayID) }) { [weak self] error in
                        guard let self, self.session === session else { return }
                        if let error { return fail(error) }
                        session.displayReady = true
                        session.lastError = nil
                        completion(nil)
                    }
                }
            }
        }
    }

    private func startCaptureIfPossible(_ session: Session) {
        guard session.displayReady, !session.paused, session.videoLane != nil, !session.capture.running, !session.captureStarting else {
            updatePhase(session)
            return
        }
        permissions = PermissionState.current()
        guard permissions.screenRecording else {
            updatePhase(session)
            return
        }
        let geometry = session.geometry
        let cursorInVideo = !CursorTracker.probeShapeSupport()
        if cursorInVideo { log("cursor shape unavailable; falling back to cursor-in-video") }
        session.captureStarting = true
        session.capture.start(displayID: provider.displayID, width: geometry.widthPixels, height: geometry.heightPixels, showsCursor: cursorInVideo) { [weak self] error in
            guard let self, self.session === session else { return }
            session.captureStarting = false
            if let error {
                session.lastError = "\(error)"
                self.log("capture failed: \(error)")
                self.updatePhase(session)
                return
            }
            do {
                session.encoder = try VideoEncoder(width: geometry.widthPixels, height: geometry.heightPixels, bitrate: session.bitrate.bitsPerSecond)
            } catch {
                session.lastError = "\(error)"
                self.log("encoder failed: \(error)")
                session.capture.stop()
                self.updatePhase(session)
                return
            }
            session.encoder?.onOutput = { [weak self, weak session] output in
                guard let self, let session, self.session === session else { return }
                self.encoded(output, session)
            }
            session.credit.requireKeyframe()
            if !cursorInVideo { session.cursor.start() }
            session.pasteboard.start()
            session.lastError = nil
            self.updatePhase(session)
        }
    }

    private func stopCapture(_ session: Session) {
        session.capture.stop()
        session.encoder?.invalidate()
        session.encoder = nil
        session.cursor.stop()
    }

    private func restartCapture(_ session: Session) {
        stopCapture(session)
        session.credit.requireKeyframe()
        startCaptureIfPossible(session)
    }

    private func captured(_ sample: CMSampleBuffer, _ session: Session) {
        session.stats.captured += 1
        guard let encoder = session.encoder, session.videoLane != nil, !session.paused else { return }
        guard session.credit.shouldEncode else {
            session.stats.noCredit += 1
            session.credit.requireKeyframe()
            return
        }
        session.stats.encodeCalls += 1
        encoder.encode(sample, forceKeyframe: session.credit.needsKeyframe)
    }

    private func encoded(_ output: VideoEncoder.Output, _ session: Session) {
        session.stats.encoded += 1
        guard let lane = session.videoLane else { return }
        if session.credit.needsKeyframe && !output.keyframe {
            // A non-keyframe after a drop cannot be decoded: drop it too and keep asking.
            session.credit.drop()
            return
        }
        guard session.credit.trySend(bytes: output.data.count) else { return }
        session.stats.sent += 1
        session.stats.sentBytes += output.data.count
        session.frameSeq += 1
        let chunks = AnnexB.chunks(output.data, chunkBytes: Self.videoChunkBytes)
        for (index, chunk) in chunks.enumerated() {
            var frame = Coflux_V1_ScreenVideoFrame()
            frame.sessionID = session.id
            frame.frameSeq = session.frameSeq
            frame.keyframe = output.keyframe
            frame.ptsUs = output.ptsMicros
            frame.widthPixels = UInt32(output.width)
            frame.heightPixels = UInt32(output.height)
            frame.codec = .h264
            frame.data = chunk.data
            frame.last = chunk.last
            frame.chunkIndex = UInt32(index)
            frame.chunkCount = UInt32(chunks.count)
            send(lane, .screenVideoFrame(frame))
        }
    }

    private func tearDown(_ session: Session, restore: Bool) {
        stopCapture(session)
        session.bitrateTimer?.cancel()
        session.bitrateTimer = nil
        session.pasteboard.stop()
        session.input.releaseAll()
        cancelGrace()
        stopPermissionPolling()
        provider.destroy()
        if restore { DisplayConfiguration.restoreArrangement() }
        power.release()
    }

    // MARK: - State reports

    private func startPermissionPolling() {
        guard permissionTimer == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + 2, repeating: 2)
        timer.setEventHandler { [weak self] in
            guard let self, let session = self.session else { return }
            let current = PermissionState.current()
            guard current != self.permissions else { return }
            self.permissions = current
            self.updatePhase(session)
            if current.screenRecording, !session.capture.running { self.startCaptureIfPossible(session) }
        }
        timer.resume()
        permissionTimer = timer
    }

    private func stopPermissionPolling() {
        permissionTimer?.cancel()
        permissionTimer = nil
    }

    private func updatePhase(_ session: Session) {
        let phase: Coflux_V1_ScreenSessionPhase
        if !permissions.screenRecording {
            phase = .noPermission
        } else if permissions.locked {
            phase = .locked
        } else if session.paused {
            phase = .paused
        } else if session.capture.running {
            phase = .streaming
        } else {
            phase = .starting
        }
        let changed = phase != session.phase || session.reportedPermissions != permissions
        session.phase = phase
        session.reportedPermissions = permissions
        if changed { sendState(session) }
    }

    private func sendState(_ session: Session) {
        guard let lane = session.controlLane else { return }
        var state = Coflux_V1_ScreenSessionState()
        state.sessionID = session.id
        state.status = statusMessage(session)
        send(lane, .screenSessionState(state))
    }

    private func permissionsMessage() -> Coflux_V1_ScreenPermissions {
        var message = Coflux_V1_ScreenPermissions()
        message.screenRecording = permissions.screenRecording
        message.accessibility = permissions.accessibility
        return message
    }

    private func statusMessage(_ session: Session?) -> Coflux_V1_ScreenSessionStatus {
        var status = Coflux_V1_ScreenSessionStatus()
        status.permissions = permissionsMessage()
        status.locked = permissions.locked
        guard let session else {
            status.phase = .unspecified
            return status
        }
        status.phase = session.phase
        var display = Coflux_V1_ScreenDisplayGeometry()
        display.widthPoints = UInt32(session.geometry.widthPoints)
        display.heightPoints = UInt32(session.geometry.heightPoints)
        display.scale = UInt32(session.geometry.scale)
        display.widthPixels = UInt32(session.geometry.widthPixels)
        display.heightPixels = UInt32(session.geometry.heightPixels)
        status.display = display
        if let error = session.lastError { status.error = error }
        return status
    }

    // MARK: - Sending

    private func send(_ lane: String, _ payload: Coflux_V1_DeviceEnvelope.OneOf_Payload) {
        var envelope = Coflux_V1_DeviceEnvelope()
        envelope.protocolVersion = Self.deviceProtocolVersion
        envelope.channelID = lane
        envelope.payload = payload
        var frame = Coflux_V1_ScreenHelperFrame()
        frame.payload = .envelope(envelope)
        sendFrame(frame)
    }

    private func sendFrame(_ frame: Coflux_V1_ScreenHelperFrame) {
        guard let connection else { return }
        let bytes: Data
        do { bytes = try frame.serializedBytes() } catch { return }
        server.send(connection: connection, record: bytes)
    }

    // MARK: - Lifecycle

    /// End everything and let the process exit (SIGTERM, or the idle timer).
    public func shutdown() {
        if let session {
            tearDown(session, restore: true)
            arbiter.end()
            self.session = nil
        }
        server.stop()
    }

    /// Stale and holding nothing: leave now (the socket is already gone; the worker reconnects to
    /// the shipped helper on its own).
    private func exitIfRetired() {
        guard retiring, session == nil else { return }
        log("retired; exiting")
        server.stop()
        exit(0)
    }

    private func scheduleIdleExit() {
        cancelIdleExit()
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + Self.idleExitDelay)
        timer.setEventHandler { [weak self] in
            guard let self, self.connection == nil, self.session == nil else { return }
            self.log("idle: no session and no worker; exiting")
            self.server.stop()
            exit(0)
        }
        timer.resume()
        exitTimer = timer
    }

    private func cancelIdleExit() {
        exitTimer?.cancel()
        exitTimer = nil
    }
}

/// Everything one screen session owns. A class so callbacks can identity-check it.
final class Session {
    let id: String
    var epoch: UInt64 = 0
    var controlLane: String?
    var videoLane: String?
    var geometry: DisplayGeometry
    var displayReady = false
    var paused = false
    var phase: Coflux_V1_ScreenSessionPhase = .starting
    var reportedPermissions: PermissionState?
    var lastError: String?
    var resizeSeq: UInt64 = 0
    var frameSeq: UInt64 = 0
    var credit = CreditAccount(initialCredit: 0)
    var window = 0
    var bitrate = BitrateController(initialCredit: 2 * 1024 * 1024)
    var droppedAtLastTick = 0
    var bitrateTimer: DispatchSourceTimer?
    /// Pipeline counters since the last stats line (see `wireSession`): what was captured, skipped
    /// for lack of credit, handed to the encoder, encoded and sent.
    var stats = PipelineStats()
    var ticks = 0
    var captureStarting = false
    let capture = CaptureEngine()
    var encoder: VideoEncoder?
    let input = InputInjector()
    let pasteboard = PasteboardSync()
    let cursor = CursorTracker()

    init(id: String, controlLane: String, geometry: DisplayGeometry) {
        self.id = id
        self.controlLane = controlLane
        self.geometry = geometry
    }
}

struct PipelineStats {
    var captured = 0
    var noCredit = 0
    var encodeCalls = 0
    var encoded = 0
    var sent = 0
    var sentBytes = 0
    var creditGranted = 0
}
