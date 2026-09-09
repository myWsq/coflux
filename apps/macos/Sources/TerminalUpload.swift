import AppKit
import ImageIO
import UniformTypeIdentifiers

struct PreparedUpload: Sendable {
    let data: Data
    let name: String
}

enum BackgroundPreparation {
    /// 后台准备保留显式句柄，将调用方生命周期取消传入；单次系统解码/文件读取仍需等其返回。
    static func run<T: Sendable>(_ operation: @escaping @Sendable () throws -> T) async throws -> T {
        let preparation = Task.detached(priority: .userInitiated) {
            try Task.checkCancellation()
            return try operation()
        }
        return try await withTaskCancellationHandler {
            let result = try await preparation.value
            try Task.checkCancellation()
            return result
        } onCancel: {
            preparation.cancel()
        }
    }

}

enum UploadPreparation {
    static let fileLimit = 30 * 1024 * 1024
    static let imageBudget = 7 * 1024 * 1024 / 2

    static func generatedName(prefix: String, original: String) -> String {
        let suffix = (original as NSString).pathExtension
        let safe = !suffix.isEmpty && suffix.count <= 16 && suffix.utf8.allSatisfy {
            (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0)
        }
        return prefix + "-" + UUID().uuidString.lowercased() + (safe ? "." + suffix : "")
    }

    static func file(_ url: URL) throws -> PreparedUpload? {
        try Task.checkCancellation()
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let values = try url.resourceValues(forKeys: [.isDirectoryKey, .fileSizeKey])
        if values.isDirectory == true { return nil }
        guard (values.fileSize ?? 0) <= fileLimit else { throw failure("文件超过 30MB，已拒绝上传") }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let bytes = try handle.read(upToCount: fileLimit + 1) ?? Data()
        try Task.checkCancellation()
        guard bytes.count <= fileLimit else { throw failure("文件超过 30MB，已拒绝上传") }
        return PreparedUpload(data: bytes, name: generatedName(prefix: "drop", original: url.lastPathComponent))
    }

    /// 与 Web 相同：先降 JPEG 质量，再每次减半分辨率，短边到 64 后停止。
    /// ImageIO/CGContext 在后台执行，不阻塞 AppKit 输入线程。
    static func image(_ bytes: Data, type: String) throws -> PreparedUpload {
        try Task.checkCancellation()
        let ext = ["public.png": "png", "public.jpeg": "jpg", "com.compuserve.gif": "gif", "org.webmproject.webp": "webp"][type]
        if bytes.count <= imageBudget, let ext {
            return PreparedUpload(data: bytes, name: generatedName(prefix: "paste", original: "image." + ext))
        }
        guard let source = CGImageSourceCreateWithData(bytes as CFData, nil),
              let decoded = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw failure("无法读取剪贴板图片") }
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        let orientation = (properties?[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
        let original: CGImage
        if (2...8).contains(orientation) {
            // 重编码会丢掉原始 EXIF 方向；由 ImageIO 在原尺寸应用旋转/镜像，避免上传后横躺或反转。
            guard let transformed = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: max(decoded.width, decoded.height),
            ] as CFDictionary) else { throw failure("无法处理图片方向") }
            original = transformed
        } else {
            original = decoded
        }
        try Task.checkCancellation()
        if ext == nil, let png = encode(original, type: UTType.png, quality: 1), png.count <= imageBudget {
            return PreparedUpload(data: png, name: generatedName(prefix: "paste", original: "image.png"))
        }
        var width = original.width, height = original.height
        var smallest: Data?
        while true {
            try Task.checkCancellation()
            guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                                           bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                           bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { throw failure("无法处理剪贴板图片") }
            context.interpolationQuality = .high
            context.draw(original, in: CGRect(x: 0, y: 0, width: width, height: height))
            guard let resized = context.makeImage() else { throw failure("无法压缩图片") }
            for step in stride(from: 9, through: 3, by: -1) {
                try Task.checkCancellation()
                guard let encoded = encode(resized, type: UTType.jpeg, quality: Double(step) / 10) else { continue }
                try Task.checkCancellation()
                if smallest == nil || encoded.count < smallest!.count { smallest = encoded }
                if encoded.count <= imageBudget {
                    return PreparedUpload(data: encoded, name: generatedName(prefix: "paste", original: "image.jpg"))
                }
            }
            if min(width, height) <= 64 { break }
            width = max(1, Int((Double(width) / 2).rounded()))
            height = max(1, Int((Double(height) / 2).rounded()))
        }
        guard let smallest, smallest.count <= fileLimit else { throw failure("图片压缩后仍超过上传上限") }
        return PreparedUpload(data: smallest, name: generatedName(prefix: "paste", original: "image.jpg"))
    }

    private static func encode(_ image: CGImage, type: UTType, quality: Double) -> Data? {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, type.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        return CGImageDestinationFinalize(destination) ? data as Data : nil
    }
    private static func failure(_ message: String) -> NSError {
        NSError(domain: "CofluxUpload", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}

/// 文件和图片交给上传流程，普通文字由 Ghostty 编码。
final class UploadTerminalView: GhosttyTerminalView {
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        let center = NotificationCenter.default
        center.removeObserver(self, name: NSWindow.didBecomeKeyNotification, object: nil)
        center.removeObserver(self, name: NSWindow.didResignKeyNotification, object: nil)
        guard let window else { return }
        center.addObserver(self, selector: #selector(windowFocusChanged(_:)), name: NSWindow.didBecomeKeyNotification, object: window)
        center.addObserver(self, selector: #selector(windowFocusChanged(_:)), name: NSWindow.didResignKeyNotification, object: window)
    }
    @objc private func windowFocusChanged(_ notification: Notification) {
        guard let window, notification.object as? NSWindow === window, window.firstResponder === self else { return }
        setTerminalFocus(notification.name == NSWindow.didBecomeKeyNotification)
    }

    var onImage: ((Data, String) -> Void)?
    var onFiles: (([URL]) -> Void)?
    var onDragState: ((Bool) -> Void)?
    var canUpload: (() -> Bool)?

    override func paste(_ sender: Any?) {
        let board = NSPasteboard.general
        let types: [NSPasteboard.PasteboardType] = [.png, .init("public.jpeg"), .init("com.compuserve.gif"), .init("org.webmproject.webp"), .tiff]
        for type in types {
            if let data = board.data(forType: type) { onImage?(data, type.rawValue); return }
        }
        super.paste(sender)
    }
    func updateDragOperation(for pasteboard: NSPasteboard) -> NSDragOperation {
        let allowed = canUpload?() == true && pasteboard.canReadObject(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true])
        // 拖动期间也可能丢失控制权或开始上传；拒绝时同步撤掉遮罩。
        onDragState?(allowed)
        return allowed ? .copy : []
    }
    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        updateDragOperation(for: sender.draggingPasteboard)
    }
    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation { draggingEntered(sender) }
    override func draggingExited(_ sender: NSDraggingInfo?) { onDragState?(false) }
    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        updateDragOperation(for: sender.draggingPasteboard) == .copy
    }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        onDragState?(false)
        guard canUpload?() == true,
              let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] else { return false }
        onFiles?(urls)
        return true
    }
}
