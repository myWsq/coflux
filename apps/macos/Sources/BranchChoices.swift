import Foundation
import CofluxProtocol

struct BranchChoice: Identifiable, Equatable {
    var id: String { (createNew ? "create:" : "branch:") + name }
    let name: String
    let createNew: Bool
    let current: Bool
    let taken: Bool
    var actionable: Bool { current || !taken }
}

enum BranchChoices {
    static func loadedBranches(_ result: Coflux_V1_ExecResult) throws -> [String] {
        guard result.ok && result.exitCode == 0 else {
            let detail = [result.error, result.stderr]
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .first { !$0.isEmpty }
                ?? "获取分支列表失败（git 退出码 \(result.exitCode)）"
            throw NSError(domain: "CofluxGit", code: Int(result.exitCode),
                          userInfo: [NSLocalizedDescriptionKey: detail])
        }
        return result.stdout.split(separator: "\n").map(String.init)
    }

    static func entries(query: String, branches: [String], taken: Set<String>, current: String?, loaded: Bool) -> [BranchChoice] {
        guard loaded else { return [] }
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        var result: [BranchChoice] = []
        if !query.isEmpty && !branches.contains(query) {
            result.append(BranchChoice(name: query, createNew: true, current: false, taken: false))
        }
        result += branches.filter { query.isEmpty || $0.localizedCaseInsensitiveContains(query) }.map {
            BranchChoice(name: $0, createNew: false, current: $0 == current, taken: taken.contains($0))
        }
        return result
    }
    static func move(_ selected: Int, delta: Int, entries: [BranchChoice]) -> Int {
        var next = selected + delta
        while entries.indices.contains(next) {
            if entries[next].actionable { return next }
            next += delta
        }
        return selected
    }
}
