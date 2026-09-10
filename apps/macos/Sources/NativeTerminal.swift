import AppKit
import CofluxClientCore
import CofluxProtocol
import SwiftUI

struct NativeTerminal: NSViewRepresentable {
    let client: CofluxClient
    let task: Coflux_V1_Task
    let active: Bool
    let activationRequest: Int
    let onTitle: (String, String) -> Void
    let onUploadState: (Bool) -> Void
    let onDragState: (Bool) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(client: client, taskID: task.id, onTitle: onTitle, onUploadState: onUploadState)
    }
    static func configuredView() -> UploadTerminalView {
        let view = UploadTerminalView(frame: CGRect(x: 0, y: 0, width: 800, height: 600))
        view.registerForDraggedTypes([.fileURL])
        return view
    }
    func makeNSView(context: Context) -> GhosttyTerminalView {
        let view = Self.configuredView()
        let coordinator = context.coordinator
        view.canUpload = { [weak coordinator] in coordinator?.canUpload == true }
        view.onImage = { [weak coordinator] data, type in coordinator?.uploadImage(data, type: type) }
        view.onFiles = { [weak coordinator] urls in coordinator?.uploadFiles(urls) }
        view.onDragState = onDragState
        view.sessionCoordinator = coordinator
        view.onInput = { [weak coordinator, weak view] data in
            guard let view else { return }; coordinator?.send(source: view, data: Array(data)[...])
        }
        view.onResize = { [weak coordinator, weak view] cols, rows in
            guard let view else { return }; coordinator?.sizeChanged(source: view, newCols: cols, newRows: rows)
        }
        view.onTitle = { [weak coordinator, weak view] title in
            guard let view else { return }; coordinator?.setTerminalTitle(source: view, title: title)
        }
        view.onOpenLink = { [weak coordinator, weak view] link, explicit in
            guard let view else { return }; coordinator?.requestOpenLink(source: view, link: link, explicit: explicit)
        }
        context.coordinator.view = view
        context.coordinator.output.view = view
        return view
    }
    func updateNSView(_ view: GhosttyTerminalView, context: Context) {
        context.coordinator.update(task: task, active: active, activationRequest: activationRequest)
    }
    static func dismantleNSView(_ view: GhosttyTerminalView, coordinator: Coordinator) { coordinator.release() }

    @MainActor final class Coordinator: NSObject {
        let client: CofluxClient
        let taskID: String
        let output = TerminalOutputPump()
        weak var view: GhosttyTerminalView?
        var sessionID: String?
        var releaseConsumer: (@MainActor () -> Void)?
        var active = false
        var starting = false
        var launchFailed = false
        var handledActivation = 0
        var launchTimeout: Task<Void, Never>?
        var launchRequest: Task<Void, Never>?
        var resize: Task<Void, Never>?
        var uploadTask: Task<Void, Never>?
        private var uploadGeneration: UInt64 = 0
        var pendingPaste = ""
        let onTitle: (String, String) -> Void
        let onUploadState: (Bool) -> Void
        let openURL: (URL) -> Void
        let confirmLink: @MainActor (URL, NSWindow?, @escaping (Bool) -> Void) -> Void

        init(client: CofluxClient, taskID: String, onTitle: @escaping (String, String) -> Void,
             onUploadState: @escaping (Bool) -> Void,
             openURL: @escaping (URL) -> Void = { NSWorkspace.shared.open($0) },
             confirmLink: @escaping @MainActor (URL, NSWindow?, @escaping (Bool) -> Void) -> Void = Coordinator.confirmExplicitLink) {
            self.client = client; self.taskID = taskID
            self.onTitle = onTitle; self.onUploadState = onUploadState
            self.openURL = openURL
            self.confirmLink = confirmLink
        }
        var canUpload: Bool { active && sessionID.map { client.hasSessionControl(sessionID: $0) } == true && uploadTask == nil }
        func update(task: Coflux_V1_Task, active: Bool, activationRequest: Int) {
            guard let view else { return }
            let becameActive = active && !self.active
            self.active = active
            view.setSurfaceVisible(active)
            let nextID = task.hasSessionID ? task.sessionID : nil
            var attachedDuringBinding = false
            if nextID != sessionID {
                cancelUpload()
                output.clear()
                view.resetTerminal()
                pendingPaste = ""
                releaseConsumer?()
                releaseConsumer = nil
                sessionID = nextID
                if let nextID {
                    releaseConsumer = client.registerSessionConsumer(sessionID: nextID) { [weak output] data, replace in
                        output?.enqueue(data, replace: replace)
                    }
                    if task.status == .running && (active || starting) && !client.detachedTaskIDs.contains(taskID) {
                        let terminal = view
                        client.startTask(taskID: taskID, cols: UInt32(terminal.columns), rows: UInt32(terminal.rows))
                        attachedDuringBinding = true
                    }
                }
            }
            if task.status == .running {
                launchFailed = false
                starting = false
                launchTimeout?.cancel()
                launchTimeout = nil
                launchRequest?.cancel()
                launchRequest = nil
            }
            let explicitlyActivated = active && activationRequest != handledActivation
            if explicitlyActivated { handledActivation = activationRequest }
            let detached = client.detachedTaskIDs.contains(taskID)
            // 返回工作区只恢复正常连接；被接管后须用户明确点击 Tab 才能强制拿回。
            if task.status == .running && (explicitlyActivated || (becameActive && !detached)) && !attachedDuringBinding {
                let terminal = view
                client.startTask(taskID: taskID, cols: UInt32(terminal.columns), rows: UInt32(terminal.rows),
                                 force: explicitlyActivated && detached)
            }
            if active && !starting && ((task.status == .idle && (!launchFailed || explicitlyActivated)) || (explicitlyActivated && task.status == .exited)) {
                starting = true
                if task.status == .exited { output.clear(); view.resetTerminal() }
                let terminal = view
                let cols = UInt32(terminal.columns), rows = UInt32(terminal.rows)
                launchRequest?.cancel()
                launchRequest = Task { [weak self] in
                    guard let self else { return }
                    do {
                        try await self.client.startTaskWhenReady(taskID: self.taskID, cols: cols, rows: rows)
                    } catch {
                        guard !Task.isCancelled else { return }
                        self.starting = false
                        self.launchFailed = true
                        self.launchTimeout?.cancel()
                        self.client.reportLocalError(error.localizedDescription)
                    }
                }
                launchTimeout?.cancel()
                launchTimeout = Task { [weak self] in
                    try? await Task.sleep(for: .seconds(15))
                    guard !Task.isCancelled, let self else { return }
                    self.launchRequest?.cancel()
                    self.starting = false
                    self.launchFailed = true
                    self.client.reportLocalError("启动终端超时，请点击标签重试")
                }
            }
            if becameActive || explicitlyActivated {
                // SwiftUI 完成布局后再抢焦点，不能在重绘时不断打断输入法组合文本。
                Task { @MainActor [weak self, weak view] in
                    guard let self, self.active, let view else { return }
                    view.window?.makeFirstResponder(view)
                    let terminal = view
                    self.sizeChanged(source: view, newCols: terminal.columns, newRows: terminal.rows)
                    if !self.pendingPaste.isEmpty, self.sessionID.map({ self.client.hasSessionControl(sessionID: $0) }) == true {
                        let paste = self.pendingPaste
                        self.pendingPaste = ""
                        view.pasteUploadedPaths(paste)
                    }
                }
            }
        }
        func release() {
            output.clear()
            view?.prepareForRemoval()
            launchRequest?.cancel()
            launchTimeout?.cancel()
            resize?.cancel()
            cancelUpload()
            releaseConsumer?()
            releaseConsumer = nil
            sessionID = nil
        }
        func send(source: GhosttyTerminalView, data: ArraySlice<UInt8>) {
            guard active, !client.detachedTaskIDs.contains(taskID), let sessionID else { return }
            client.sendInput(sessionID: sessionID, data: Data(data))
        }
        func sizeChanged(source: GhosttyTerminalView, newCols: Int, newRows: Int) {
            guard active, newCols > 0, newRows > 0, let sessionID,
                  client.hasSessionControl(sessionID: sessionID) else { return }
            resize?.cancel()
            resize = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(80))
                guard !Task.isCancelled, let self, self.active, self.sessionID == sessionID,
                      self.client.hasSessionControl(sessionID: sessionID) else { return }
                self.client.resizeSession(sessionID: sessionID, cols: UInt32(newCols), rows: UInt32(newRows))
            }
        }
        func setTerminalTitle(source: GhosttyTerminalView, title: String) {
            guard let sessionID else { return }
            Task { @MainActor [weak self] in
                guard let self, self.sessionID == sessionID else { return }
                self.onTitle(sessionID, title)
            }
        }

        // 取消后立即释放会话忙态；不等待可能忽略取消的旧网络请求返回。
        private func cancelUpload() {
            guard let previous = uploadTask else { return }
            uploadGeneration &+= 1
            let generation = uploadGeneration
            uploadTask = nil
            previous.cancel()
            // updateNSView/dismantleNSView 内不能同步回写 SwiftUI 状态。
            // 短暂保留 coordinator，让卸载后的清理也能送达；新上传使通知失效。
            Task { @MainActor [self] in
                guard uploadGeneration == generation else { return }
                onUploadState(false)
            }
        }

        func startUpload(_ operation: @escaping @MainActor () async -> Void) {
            guard uploadTask == nil else { return }
            uploadGeneration &+= 1
            let generation = uploadGeneration
            uploadTask = Task { [weak self] in
                guard let self else { return }
                defer {
                    if self.uploadGeneration == generation {
                        self.uploadTask = nil
                        self.onUploadState(false)
                    }
                }
                guard !Task.isCancelled else { return }
                await operation()
            }
            onUploadState(true)
        }

        func uploadImage(_ data: Data, type: String) {
            guard canUpload, let sessionID else { client.reportLocalError("未持有控制权或正在上传，无法粘贴图片"); return }
            startUpload { [weak self] in
                guard let self else { return }
                do {
                    let file = try await BackgroundPreparation.run { try UploadPreparation.image(data, type: type) }
                    try Task.checkCancellation()
                    let path = try await self.client.uploadSessionFile(sessionID: sessionID, data: file.data, suggestedName: file.name)
                    self.pastePaths([path], sessionID: sessionID)
                } catch { if !Task.isCancelled { self.client.reportLocalError(error.localizedDescription) } }
            }
        }

        func uploadFiles(_ urls: [URL]) {
            guard canUpload, let sessionID else { client.reportLocalError("未持有控制权或正在上传，无法上传文件"); return }
            startUpload { [weak self] in
                guard let self else { return }
                var paths: [String] = []
                for url in urls {
                    do {
                        try Task.checkCancellation()
                        guard let file = try await BackgroundPreparation.run({ try UploadPreparation.file(url) }) else { continue }
                        try Task.checkCancellation()
                        paths.append(try await self.client.uploadSessionFile(sessionID: sessionID, data: file.data, suggestedName: file.name))
                    } catch {
                        if Task.isCancelled { break }
                        self.client.reportLocalError(error.localizedDescription)
                    }
                }
                self.pastePaths(paths, sessionID: sessionID)
            }
        }
        private func pastePaths(_ paths: [String], sessionID: String) {
            guard !Task.isCancelled, self.sessionID == sessionID, client.hasSessionControl(sessionID: sessionID), !paths.isEmpty else { return }
            let text = " " + paths.joined(separator: " ") + " "
            if active { view?.pasteUploadedPaths(text) }
            else { pendingPaste += text }
        }
        func hostCurrentDirectoryUpdate(source: GhosttyTerminalView, directory: String?) {}
        func scrolled(source: GhosttyTerminalView, position: Double) {}
        func rangeChanged(source: GhosttyTerminalView, startY: Int, endY: Int) {}
        func requestOpenLink(source: GhosttyTerminalView, link: String, explicit: Bool) {
            guard let url = URL(string: link), let scheme = url.scheme?.lowercased(),
                  ["http", "https"].contains(scheme), let host = url.host, !host.isEmpty else { return }
            if explicit {
                confirmLink(url, source.window) { [openURL] accepted in
                    if accepted { openURL(url) }
                }
            } else { openURL(url) }
        }
        private static func confirmExplicitLink(_ url: URL, window: NSWindow?, completion: @escaping (Bool) -> Void) {
            guard let window else { completion(false); return }
            let alert = NSAlert()
            alert.messageText = "打开链接？"
            alert.informativeText = "此链接的目标可能与显示文字不同。\n" + url.absoluteString
            alert.addButton(withTitle: "打开")
            alert.addButton(withTitle: "取消")
            alert.beginSheetModal(for: window) { completion($0 == .alertFirstButtonReturn) }
        }
        func clipboardCopy(source: GhosttyTerminalView, content: Data) {
            guard let text = String(data: content, encoding: .utf8) else { return }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        }
    }
}
