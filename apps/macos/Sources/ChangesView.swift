import AppKit
import CofluxClientCore
import CofluxProtocol
import SwiftUI

struct ChangesView: View {
    @State private var visibleFiles = Set<String>()
    let client: CofluxClient
    let workspace: Coflux_V1_Workspace
    let active: Bool
    let defaultBranch: String
    @State private var files: [DiffFile]?
    @State private var rowLayouts: [String: DiffRowLayout] = [:]
    @State private var contentWidths: [String: CGFloat] = [:]
    @State private var documents: [String: DiffTextDocument] = [:]
    @State private var collapsed = Set<String>()
    @State private var error = ""
    @State private var revision = 0
    @State private var loading = false

    var body: some View {
        Group {
            if !error.isEmpty {
                VStack(spacing: 12) {
                    WorkbenchIcon(symbol: "circle-alert", size: 24).foregroundStyle(Design.destructive)
                    Text(error).foregroundStyle(Design.muted).multilineTextAlignment(.center).frame(maxWidth: 420)
                    Button { revision += 1 } label: {
                        HStack(spacing: 6) {
                            if loading { ProgressView().controlSize(.mini) }
                            Text("重试")
                        }.padding(.horizontal, 12).frame(height: 28)
                    }.buttonStyle(WorkbenchButtonStyle(selected: true)).disabled(loading)
                        .accessibilityIdentifier("diff.retry")
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let files {
                if files.isEmpty {
                    VStack(spacing: 8) {
                        WorkbenchIcon(symbol: "file-diff", size: 24)
                        Text("这个工作区还没有变更")
                        Button { revision += 1 } label: {
                            HStack(spacing: 6) {
                                if loading { ProgressView().controlSize(.mini) }
                                Text("刷新")
                            }.foregroundStyle(Design.foreground)
                                .padding(.horizontal, 12).frame(height: 28).contentShape(Rectangle())
                        }.buttonStyle(WorkbenchPlainButtonStyle()).disabled(loading)
                    }.foregroundStyle(Design.muted).frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    VStack(spacing: 0) {
                        HStack(spacing: 12) {
                            Text("\(files.count) 个文件")
                            HStack(spacing: 4) {
                                Text(verbatim: "+\(workspace.additions)").foregroundStyle(Design.success)
                                Text(verbatim: "−\(workspace.deletions)").foregroundStyle(Design.destructive)
                            }.font(.system(size: 11, design: .monospaced)).monospacedDigit()
                            Spacer()
                            Button { revision += 1 } label: {
                                Group {
                                    if loading { ProgressView().controlSize(.mini) }
                                    else { WorkbenchIcon(symbol: "refresh-cw", size: 14) }
                                }.frame(width: 24, height: 24)
                            }.buttonStyle(WorkbenchButtonStyle()).disabled(loading)
                                .accessibilityLabel("刷新变更").accessibilityIdentifier("diff.refresh")
                                .workbenchTooltip("刷新变更")
                        }.font(.system(size: 11)).padding(.horizontal, 16).frame(height: 45).background(Design.background)
                            .overlay(alignment: .bottom) { Rectangle().fill(Design.border).frame(height: 1) }
                        GeometryReader { geometry in
                            ScrollView(.vertical) {
                                // TextKit 绘制连续文本；文件容器使用确定布局，删除大文件时收敛总高度。
                                VStack(alignment: .leading, spacing: 12) {
                                    ForEach(files) { file in
                                        fileView(file, minimumWidth: max(0, geometry.size.width - 32), viewportHeight: geometry.size.height)
                                    }
                                }
                                .frame(width: max(0, geometry.size.width - 32), alignment: .topLeading)
                                .padding(16)
                                .frame(minHeight: geometry.size.height, alignment: .topLeading)
                            }
                        }.coordinateSpace(name: "diffViewport")
                    }
                }
            } else { ProgressView().controlSize(.small).frame(maxWidth: .infinity, maxHeight: .infinity) }
        }.font(.system(size: 12)).background(Design.terminal)
            .task(id: "\(active):\(workspace.id):\(defaultBranch):\(workspace.additions):\(workspace.deletions):\(revision)") {
                if active { await load() }
            }
    }

    private func fileView(_ file: DiffFile, minimumWidth: CGFloat, viewportHeight: CGFloat) -> some View {
        VStack(spacing: 0) {
            Button {
                if collapsed.contains(file.id) { collapsed.remove(file.id) } else { collapsed.insert(file.id) }
            } label: {
                HStack(spacing: 8) {
                    WorkbenchIcon(symbol: collapsed.contains(file.id) ? "chevron-right" : "chevron-down", size: 14)
                        .foregroundStyle(Design.muted)
                    WorkbenchIcon(symbol: "file-diff", size: 14).foregroundStyle(Design.muted)
                    (Text(verbatim: file.path) + Text(verbatim: file.renamedFrom.map { "  ← " + $0 } ?? "").foregroundColor(Design.muted))
                        .font(.system(size: 11, design: .monospaced))
                        .lineLimit(1).truncationMode(.tail)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if file.binary {
                        Text("二进制文件").font(.system(size: 10)).foregroundStyle(Design.muted).fixedSize()
                    } else {
                        HStack(spacing: 4) {
                            Text(verbatim: "+\(file.additions)").foregroundStyle(Design.success)
                            Text(verbatim: "−\(file.deletions)").foregroundStyle(Design.destructive)
                        }.font(.system(size: 10, design: .monospaced)).monospacedDigit().fixedSize()
                    }
                }.padding(.horizontal, 12).padding(.vertical, 8).contentShape(Rectangle())
            }.buttonStyle(DiffFileHeaderStyle())
            if !collapsed.contains(file.id) && !file.binary {
                if file.lines.isEmpty, let previous = file.renamedFrom {
                    Rectangle().fill(Design.border).frame(height: 1)
                    Text("重命名自 " + previous).font(.system(size: 10)).foregroundStyle(Design.muted)
                        .padding(.horizontal, 12).padding(.vertical, 8)
                } else if !file.lines.isEmpty {
                    Rectangle().fill(Design.border).frame(height: 1)
                    ScrollView(.horizontal) {
                        if let document = documents[file.id] {
                            NativeDiffText(document: document, active: active && visibleFiles.contains(file.id))
                                .frame(width: max(minimumWidth, contentWidths[file.id] ?? 600), height: document.layout.height)
                        }

                    }
                    // 明确行高，避免嵌套滚动容器把短文件撑满整个视口。
                    .frame(height: rowLayouts[file.id]?.height ?? 0)
                    .accessibilityIdentifier("diff.content.\(file.id)")
                }
            }
        }.frame(width: minimumWidth).background(Design.panel)
            .background {
                GeometryReader { geometry in
                    let frame = geometry.frame(in: .named("diffViewport"))
                    let visible = viewportHeight > 0 && frame.maxY > 0 && frame.minY < viewportHeight
                    // 只在进出视口时更新状态；滚动坐标变化不应反复触发整页更新。
                    Color.clear.onChange(of: visible, initial: true) { _, visible in
                        guard visibleFiles.contains(file.id) != visible else { return }
                        if visible {
                            visibleFiles.insert(file.id)
                        } else {
                            visibleFiles.remove(file.id)
                        }
                    }
                }
            }
            .onDisappear { visibleFiles.remove(file.id) }
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Design.border))
    }

    private func execute(_ args: [String], allowDifference: Bool = false) async throws -> String {
        let result = try await client.executeInWorkspace(workspaceID: workspace.id, command: "git", args: args)
        guard result.ok, result.exitCode == 0 || (allowDifference && result.exitCode == 1) else {
            let message = [result.error, result.stderr].map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.first { !$0.isEmpty }
                ?? "获取变更失败（git 退出码 \(result.exitCode)）"
            throw NSError(domain: "CofluxGit", code: Int(result.exitCode), userInfo: [NSLocalizedDescriptionKey: message])
        }
        return result.stdout
    }
    private func load() async {
        loading = true
        defer { if !Task.isCancelled { loading = false } }
        do {
            var base = "HEAD"
            if !defaultBranch.isEmpty,
               let mergeBase = try? await execute(["merge-base", defaultBranch, "HEAD"]) {
                let resolved = mergeBase.trimmingCharacters(in: .whitespacesAndNewlines)
                if !resolved.isEmpty { base = resolved }
            }
            try Task.checkCancellation()
            async let tracked = execute(["-c", "core.quotepath=false", "diff", base])
            // NUL 分隔也支持文件名中的换行；仍以每个文件一条 argv 请求避免 shell 插值。
            async let untracked = execute(["ls-files", "--others", "--exclude-standard", "-z"])
            var raw = try await tracked
            let paths = try await untracked.split(separator: "\0").map(String.init)
            raw += try await UntrackedDiffLoader.load(paths: paths) { args in
                try await execute(args, allowDifference: true)
            }
            try Task.checkCancellation()
            let captured = raw
            let (parsed, widths, layouts) = try await BackgroundPreparation.run {
                let parsed = try UnifiedDiff.parse(captured, checkCancellation: Task.checkCancellation)
                // 与原生文本共用字体和制表位，离屏长行也纳入横向滚动范围。
                let widths = try Dictionary(uniqueKeysWithValues: parsed.map { file in
                    try Task.checkCancellation()
                    let width = try file.lines.reduce(CGFloat(600)) { current, line in
                        try Task.checkCancellation()
                        return max(current, DiffTextMetrics.prepare(line).width)
                    }
                    return (file.id, width)
                })
                return (parsed, widths, Dictionary(uniqueKeysWithValues: parsed.map { ($0.id, DiffRowLayout(lines: $0.lines)) }))
            }
            try Task.checkCancellation()
            var prepared: [String: DiffTextDocument] = [:]
            for file in parsed {
                prepared[file.id] = try await DiffTextDocument.refresh(file: file, previous: documents[file.id])
            }
            try Task.checkCancellation()
            files = parsed
            contentWidths = widths
            rowLayouts = layouts
            documents = prepared
            error = ""
            loading = false
            for file in parsed where !file.binary && documents[file.id]?.highlightingComplete != true {
                try Task.checkCancellation()
                guard let spans = try? await NativeDiffHighlighter.shared.highlight(file) else { continue }
                try Task.checkCancellation()
                let document = try await DiffTextDocument.prepare(file: file, spans: spans, highlightingComplete: true)
                try Task.checkCancellation()
                documents[file.id] = document

            }
        } catch {
            if !Task.isCancelled {
                self.error = client.status == .connected
                    ? error.localizedDescription
                    : "连接已断开，暂时无法读取变更。请恢复连接后重试。"
            }
        }
    }
}

/// 文件头整行响应悬停，与 Web 的 accent/40 保持一致。
private struct DiffFileHeaderStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Content(configuration: configuration)
    }
    private struct Content: View {
        let configuration: Configuration
        @State private var hovering = false
        var body: some View {
            configuration.label
                .background(Design.accent.opacity(hovering || configuration.isPressed ? 0.4 : 0))
                .onHover { hovering = $0 }
        }
    }
}


/// 累积行高支持二分定位；不让嵌套横向滚动区为整份文件构建行视图。
struct DiffRowLayout: Sendable {
    let offsets: [CGFloat]
    var height: CGFloat { offsets.last ?? 0 }
    init(lines: [DiffLine]) {
        var values: [CGFloat] = [0]
        values.reserveCapacity(lines.count + 1)
        for line in lines { values.append(values.last! + (line.kind == "@" ? DiffTextMetrics.hunkHeight : DiffTextMetrics.codeHeight)) }
        offsets = values
    }
    func visibleRange(top: CGFloat, height: CGFloat) -> Range<Int> {
        let count = offsets.count - 1
        guard count > 0 else { return 0..<0 }
        func row(at position: CGFloat) -> Int {
            var lower = 0, upper = count
            while lower < upper {
                let middle = (lower + upper) / 2
                if offsets[middle + 1] <= position { lower = middle + 1 } else { upper = middle }
            }
            return lower
        }
        let first = row(at: max(0, top - 100))
        let last = min(count, row(at: max(0, top + height + 100)) + 1)
        return first..<max(first, last)
    }
}
