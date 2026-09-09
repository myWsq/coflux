import Foundation

enum UntrackedDiffLoader {
    /// 与 Web 相同，每批最多八个请求；按原路径次序合并，避免响应先后改变文件排列。
    /// 列表读取后文件可能被删除，单个未跟踪文件失败不应遮住其余全部变更。
    @MainActor static func load(paths: [String],
        execute: @escaping @MainActor @Sendable ([String]) async throws -> String) async throws -> String {
        var output = ""
        for start in stride(from: 0, to: paths.count, by: 8) {
            try Task.checkCancellation()
            let batch = paths[start..<min(start + 8, paths.count)]
            let results = try await withThrowingTaskGroup(of: (Int, String).self) { group in
                for (index, path) in batch.enumerated() {
                    group.addTask {
                        try Task.checkCancellation()
                        let result: String
                        do {
                            result = try await execute(["-c", "core.quotepath=false", "diff", "--no-index", "--", "/dev/null", path])
                        } catch {
                            try Task.checkCancellation()
                            return (index, "")
                        }
                        try Task.checkCancellation()
                        return (index, result)
                    }
                }
                var results: [(Int, String)] = []
                for try await result in group { results.append(result) }
                return results.sorted { $0.0 < $1.0 }.map(\.1)
            }
            output += results.joined()
        }
        return output
    }
}
