import CofluxClientCore
import CofluxProtocol
import Foundation

/// Recognition context for one dictation (plan 20261108-ios-seed-asr, D3/D4/D5; plan
/// 20261109-dictation-refine D11): a sentence naming the project, workspace and branch, a sentence
/// listing related terms, then the current agent's conversation, newest first, within a budget of
/// about 1500 estimated tokens. The engines use it to spell project words and names right; they
/// never see the terminal screen.
struct DictationContext: Sendable, Equatable {
    /// Plain-text context items: the workspace sentence first (when anything is known), then the
    /// term sentence (when there are terms), then conversation entries newest first.
    let items: [String]
    /// At least one conversation entry made it in (drives the overlay badge).
    let includesConversation: Bool

    static let empty = DictationContext(items: [], includesConversation: false)

    /// The workspace sentence alone: the context whenever nothing else could be read.
    static func workspaceOnly(_ sentence: String?) -> DictationContext {
        DictationContext(items: sentence.map { [$0] } ?? [], includesConversation: false)
    }
}

/// Correction context for one dictation (plan 20261109-dictation-refine D12): what the correction
/// pass sees besides the recogniser's text. Entries are chronological (oldest first) and include the
/// short tool-call inputs; terms are the most relevant first. The refiner applies its own budget.
struct DictationRefineContext: Sendable, Equatable {
    let workspaceSentence: String?
    let terms: [String]
    let entries: [DictationTranscript.Entry]
}

/// Where the context comes from: the terminal's agent (from `sessionAgents`) and the workspace it
/// runs in. Built on the MainActor at touch-down. The reads run on the device through
/// `executeInWorkspace`, the same way the desktop's copyable conversation does
/// (terminal-transcript.ts), and never fail — every miss degrades to what is available (the
/// workspace sentence and repository terms).
@MainActor
struct DictationContextSource {
    let workspaceID: String
    let workspaceSentence: String?
    let agent: DictationTranscript.Agent?
    let agentSessionID: String?

    init(client: CofluxClient, workspaceID: String, sessionID: String?) {
        self.workspaceID = workspaceID
        let workspace = client.workspaces.first { $0.id == workspaceID }
        let project = workspace.flatMap { workspace in client.projects.first { $0.id == workspace.projectID }?.name } ?? ""
        workspaceSentence = Self.sentence(
            project: project,
            workspace: workspace?.name ?? "",
            branch: workspace?.branch ?? ""
        )
        let presence = sessionID.flatMap { client.sessionAgents[$0]?.session }
        agent = presence.flatMap { DictationTranscript.agent(of: $0.agent) }
        agentSessionID = presence.map(\.agentSessionID)
    }

    var fallback: DictationContext { .workspaceOnly(workspaceSentence) }

    /// 「当前项目 X，工作区 Y，分支 Z。」with unknown parts left out; nil when nothing is known.
    static func sentence(project: String, workspace: String, branch: String) -> String? {
        var parts: [String] = []
        if !project.isEmpty { parts.append("当前项目 \(project)") }
        if !workspace.isEmpty, workspace != branch { parts.append("工作区 \(workspace)") }
        if !branch.isEmpty { parts.append("分支 \(branch)") }
        return parts.isEmpty ? nil : parts.joined(separator: "，") + "。"
    }

    /// Read and parse the transcript with `read`'s bounds; nil for a plain shell, an unknown agent,
    /// an unusable id, a missing or unreadable file, or an exec error. Cancellable: a cancelled read
    /// returns nil.
    func readTranscript(client: CofluxClient, read: DictationTranscript.Read) async -> DictationTranscript.Reading? {
        guard let agent, let agentSessionID, DictationTranscript.isUsableAgentSessionID(agentSessionID) else {
            return nil
        }
        let invocation = DictationTranscript.command(agent: agent, agentSessionID: agentSessionID, read: read)
        let result: Coflux_V1_ExecResult
        do {
            result = try await client.executeInWorkspace(workspaceID: workspaceID, command: invocation.command, args: invocation.args)
        } catch {
            return nil
        }
        guard !Task.isCancelled, result.ok, result.exitCode == 0 else { return nil }
        let stdout = result.stdout
        return await Task.detached(priority: .userInitiated) { () -> DictationTranscript.Reading? in
            guard let entries = DictationTranscript.parseOutput(agent: agent, stdout: stdout) else { return nil }
            return DictationTranscript.Reading(entries: entries, terms: DictationTerms.conversationTerms(entries))
        }.value
    }

    /// Repository names (D10): deduplicated directory names, file stems and basenames from
    /// `git ls-files` in the workspace. Empty for no git, not a repository, or any error.
    func readRepositoryTerms(client: CofluxClient) async -> [String] {
        let invocation = DictationTerms.repositoryCommand
        let result: Coflux_V1_ExecResult
        do {
            result = try await client.executeInWorkspace(workspaceID: workspaceID, command: invocation.command, args: invocation.args)
        } catch {
            return []
        }
        guard !Task.isCancelled, result.ok, result.exitCode == 0 else { return [] }
        let stdout = result.stdout
        return await Task.detached(priority: .userInitiated) {
            DictationTerms.repositoryTerms(fromListing: stdout)
        }.value
    }

    /// The recognition context (D11): workspace sentence, term sentence, then conversation newest
    /// first. Either input may be missing; the workspace sentence is always there when known.
    func recognitionContext(reading: DictationTranscript.Reading?, repositoryTerms: [String]?) -> DictationContext {
        let terms = DictationTerms.merged(reading?.terms ?? [], repositoryTerms ?? [])
        return DictationTranscript.context(
            sentence: workspaceSentence,
            termSentence: DictationTerms.sentence(terms, budget: DictationTranscript.termBudget),
            entries: reading?.entries ?? []
        )
    }

    /// The correction context (D12): every entry the read produced, chronological, and the merged
    /// term list.
    func refineContext(reading: DictationTranscript.Reading?, repositoryTerms: [String]?) -> DictationRefineContext {
        DictationRefineContext(
            workspaceSentence: workspaceSentence,
            terms: DictationTerms.merged(reading?.terms ?? [], repositoryTerms ?? []),
            entries: reading?.entries ?? []
        )
    }
}

/// The transcript reader, ported from apps/desktop/src/renderer/components/workbench/terminal-transcript.ts
/// with three differences: the agent's reasoning (Claude `thinking`, Codex `reasoning` summaries)
/// is kept (seed-asr D4), tool outputs are dropped on the device before they are printed, and tool
/// calls produce `.tool` entries carrying only the short fields that name things
/// (dictation-refine D8/D9).
///
/// The agent session id and the sizes are never interpolated into command text (seed-asr D5,
/// dictation-refine D8): the scripts are fixed literals referencing `"$1"` to `"$3"`, the values
/// travel as their own argv entries, and the scripts refuse sizes that are not plain digits.
enum DictationTranscript {
    enum Agent: Sendable {
        case claude
        case codex
    }

    struct Entry: Sendable, Equatable {
        /// `.tool`: a tool call's input fields (D9) — never in the recognition context itself, only
        /// in the correction context and as a source of terms.
        enum Speaker: Sendable { case person, agent, tool }
        let speaker: Speaker
        let text: String
        /// The tool's name, for `.tool` entries.
        var tool: String? = nil
    }

    /// One parsed read: entries in conversation order and the terms they name, newest first.
    struct Reading: Sendable, Equatable {
        let entries: [Entry]
        let terms: [String]
    }

    /// The two transcript reads (D8). The raw tail is larger than the printed limit so the filtered
    /// output can fill it; the device prints at most `limitBytes` of filtered body.
    enum Read: Sendable {
        /// For the recognition context: bounded by the 1.2 s context deadline.
        case recognition
        /// For the correction pass: only has to be ready when the recogniser finishes.
        case correction

        var rawTailBytes: Int {
            switch self {
            case .recognition: 2 * 1024 * 1024
            case .correction: 8 * 1024 * 1024
            }
        }

        var limitBytes: Int {
            switch self {
            case .recognition: 256 * 1024
            case .correction: 1024 * 1024
            }
        }
    }

    /// Upper bound for the agent session id; mirrors the worker and server checks.
    private static let maxAgentSessionIDLength = 128
    private static let headerPrefix = "coflux-transcript"
    /// Token budget for all recognition items together (seed-asr D3).
    static let tokenBudget = 1500
    /// Share of `tokenBudget` the term sentence may take (D11).
    static let termBudget = 200
    /// A truncated entry shorter than this is not worth sending.
    private static let minimumTruncatedTokens = 24
    /// Cap for one tool-input value (D9), in characters.
    private static let maxToolValueCharacters = 300

    /// Exit codes shared by both scripts: 3 = not found, 4 = read failed or bad arguments. `$2` is
    /// the raw tail size, `$3` the printed limit; both must be plain digits. Lines carrying tool
    /// results are dropped before the limit is applied, so the printed body is conversation.
    private static let claudeLocatorScript = """
    set -u
    id="$1"
    raw="$2"
    limit="$3"
    case "$raw" in ''|*[!0-9]*) echo "bad size" >&2; exit 4;; esac
    case "$limit" in ''|*[!0-9]*) echo "bad size" >&2; exit 4;; esac
    dir=${CLAUDE_CONFIG_DIR:-}
    if [ -z "$dir" ]; then
      if [ -z "${HOME:-}" ]; then echo "HOME is not set" >&2; exit 4; fi
      dir=$HOME/.claude
    fi
    newest=
    for f in "$dir"/projects/*/"$id".jsonl; do
      [ -f "$f" ] || continue
      if [ -z "$newest" ] || [ "$f" -nt "$newest" ]; then newest=$f; fi
    done
    if [ -z "$newest" ]; then exit 3; fi
    size=$(wc -c < "$newest") || exit 4
    printf 'coflux-transcript %s %s\\n' "$size" "$limit"
    tail -c "$raw" "$newest" | grep -v -F '"type":"tool_result"' | tail -c "$limit" || exit 4

    """

    private static let codexLocatorScript = """
    set -u
    id="$1"
    raw="$2"
    limit="$3"
    case "$raw" in ''|*[!0-9]*) echo "bad size" >&2; exit 4;; esac
    case "$limit" in ''|*[!0-9]*) echo "bad size" >&2; exit 4;; esac
    dir=${CODEX_HOME:-}
    if [ -z "$dir" ]; then
      if [ -z "${HOME:-}" ]; then echo "HOME is not set" >&2; exit 4; fi
      dir=$HOME/.codex
    fi
    newest=
    for f in "$dir"/sessions/*/*/*/rollout-*-"$id".jsonl; do
      [ -f "$f" ] || continue
      if [ -z "$newest" ] || [ "$f" -nt "$newest" ]; then newest=$f; fi
    done
    if [ -z "$newest" ]; then exit 3; fi
    size=$(wc -c < "$newest") || exit 4
    printf 'coflux-transcript %s %s\\n' "$size" "$limit"
    tail -c "$raw" "$newest" | grep -v -F -e '"type":"function_call_output"' -e '"type":"custom_tool_call_output"' -e '"type":"event_msg"' | tail -c "$limit" || exit 4

    """

    static func agent(of name: String) -> Agent? {
        switch name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "claude": return .claude
        case "codex": return .codex
        default: return nil
        }
    }

    /// Conservative shape check, a second line of defence behind the positional argv.
    static func isUsableAgentSessionID(_ value: String) -> Bool {
        guard !value.isEmpty, value.count <= maxAgentSessionIDLength, let first = value.unicodeScalars.first else { return false }
        func alnum(_ scalar: Unicode.Scalar) -> Bool {
            scalar.isASCII && (CharacterSet.alphanumerics.contains(scalar))
        }
        guard alnum(first) else { return false }
        return value.unicodeScalars.allSatisfy { alnum($0) || $0 == "." || $0 == "_" || $0 == "-" }
    }

    /// The exact invocation: `sh -c '<fixed script>' sh <id> <raw tail bytes> <limit bytes>`.
    static func command(agent: Agent, agentSessionID: String, read: Read) -> (command: String, args: [String]) {
        let script = agent == .claude ? claudeLocatorScript : codexLocatorScript
        return ("sh", ["-c", script, "sh", agentSessionID, String(read.rawTailBytes), String(read.limitBytes)])
    }

    /// Split the script's stdout into header and tail, then parse. Nil when the header is missing.
    static func parseOutput(agent: Agent, stdout: String) -> [Entry]? {
        let header: Substring
        let body: Substring
        if let newline = stdout.firstIndex(of: "\n") {
            header = stdout[..<newline]
            body = stdout[stdout.index(after: newline)...]
        } else {
            header = stdout[...]
            body = ""
        }
        let fields = header.split(whereSeparator: \.isWhitespace)
        guard fields.first == Substring(headerPrefix), fields.count >= 3 else { return nil }
        return parse(agent: agent, text: body)
    }

    /// Every record type is allow-listed; a tail read starts mid-line, so an unparsable line is
    /// skipped like any other.
    static func parse(agent: Agent, text: Substring) -> [Entry] {
        var entries: [Entry] = []
        for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty,
                  let data = trimmed.data(using: .utf8),
                  let record = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { continue }
            switch agent {
            case .claude: collectClaude(record, into: &entries)
            case .codex: collectCodex(record, into: &entries)
            }
        }
        return entries
    }

    // MARK: Claude Code

    /// Claude `tool_use` input fields that name things (D9). Never `content`, `old_string`,
    /// `new_string`, edits or any other body.
    private static let claudeToolFields = ["file_path", "notebook_path", "path", "pattern", "glob", "query", "url", "command"]

    private static func collectClaude(_ record: [String: Any], into entries: inout [Entry]) {
        // Subagent conversations and synthetic bookkeeping are not this conversation.
        if record["isSidechain"] as? Bool == true { return }
        if record["isMeta"] as? Bool == true { return }
        guard let type = record["type"] as? String, type == "user" || type == "assistant",
              let message = record["message"] as? [String: Any]
        else { return }
        let content = message["content"]

        if type == "user" {
            // Most `user` records carry tool results; the person's prompts are the minority.
            if let text = content as? String {
                pushPrompt(text, into: &entries)
                return
            }
            guard let blocks = content as? [[String: Any]] else { return }
            if blocks.contains(where: { $0["type"] as? String == "tool_result" }) { return }
            for block in blocks where block["type"] as? String == "text" {
                pushPrompt(block["text"] as? String ?? "", into: &entries)
            }
            return
        }

        guard let blocks = content as? [[String: Any]] else { return }
        for block in blocks {
            switch block["type"] as? String {
            case "text": pushProse(block["text"] as? String ?? "", into: &entries)
            // Kept here, unlike the desktop's copy view: the reasoning names the things the person
            // is about to talk about.
            case "thinking": pushProse(block["thinking"] as? String ?? "", into: &entries)
            case "tool_use":
                guard let input = block["input"] as? [String: Any] else { break }
                pushTool(block["name"] as? String, values: claudeToolFields.compactMap { input[$0] as? String }, into: &entries)
            default: break  // everything else: no entry
            }
        }
    }

    // MARK: Codex

    /// Codex `function_call` argument fields that name things (D9), besides `command` / `cmd`.
    private static let codexToolFields = ["path", "file_path", "pattern", "query", "url"]

    private static func collectCodex(_ record: [String: Any], into entries: inout [Entry]) {
        guard record["type"] as? String == "response_item",
              let payload = record["payload"] as? [String: Any]
        else { return }
        switch payload["type"] as? String {
        case "reasoning":
            for item in payload["summary"] as? [[String: Any]] ?? [] {
                pushProse(item["text"] as? String ?? "", into: &entries)
            }
        case "message":
            guard let role = payload["role"] as? String, role == "user" || role == "assistant",
                  let blocks = payload["content"] as? [[String: Any]]
            else { return }
            for block in blocks {
                let text = block["text"] as? String ?? ""
                guard !text.isEmpty else { continue }
                let blockType = block["type"] as? String
                if role == "user" {
                    guard blockType == "input_text" || blockType == "text" else { continue }
                    pushPrompt(text, into: &entries)
                } else {
                    guard blockType == "output_text" || blockType == "text" else { continue }
                    pushProse(text, into: &entries)
                }
            }
        case "function_call":
            // `arguments` is a JSON object serialised as a string.
            guard let raw = payload["arguments"] as? String,
                  let data = raw.data(using: .utf8),
                  let arguments = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { return }
            var values: [String] = []
            if let command = codexCommand(arguments["command"] ?? arguments["cmd"]) { values.append(command) }
            values += codexToolFields.compactMap { arguments[$0] as? String }
            pushTool(payload["name"] as? String, values: values, into: &entries)
        default:
            // `custom_tool_call` inputs are patches or code-mode snippets: nothing is taken from
            // them (D9). Tool outputs, agent_message and bookkeeping: no entry.
            break
        }
    }

    /// A Codex command as one string: `["bash", "-lc", script]` is the script; other arrays are
    /// joined with spaces.
    private static func codexCommand(_ value: Any?) -> String? {
        if let text = value as? String { return text }
        guard let parts = value as? [String], !parts.isEmpty else { return nil }
        if parts.count >= 3, parts[parts.count - 2] == "-lc" || parts[parts.count - 2] == "-c" { return parts[parts.count - 1] }
        return parts.joined(separator: " ")
    }

    // MARK: Shared filters

    /// Whole-text wrappers that are machine injection, matched at the start of the message only.
    private static let injectedPrefixes = [
        "<command-name>",
        "<command-message>",
        "<command-args>",
        "<local-command-stdout>",
        "<local-command-stderr>",
        "<user-prompt-submit-hook>",
        "<system-reminder>",
        "# AGENTS.md instructions for ",
        "<INSTRUCTIONS>",
    ]
    /// Claude writes these into the stream as `user` text; they are markers, not prose.
    private static let systemMarker = "[Request interrupted by user"

    private static func isInjected(_ text: String) -> Bool {
        let trimmed = String(text.drop(while: \.isWhitespace))
        if injectedPrefixes.contains(where: { trimmed.hasPrefix($0) }) { return true }
        if trimmed.hasPrefix(systemMarker) { return true }
        let firstLine = trimmed.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).first
            .map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
        return isLoneOpeningTag(firstLine)
    }

    /// A first line that is a lone opening tag (`<environment_context>`, `<skill>`, …): shape, not
    /// a name list — a person's prompt does not open with a bare tag alone on line one.
    private static func isLoneOpeningTag(_ line: String) -> Bool {
        let scalars = Array(line.unicodeScalars)
        guard scalars.count >= 3, scalars.first == "<", scalars.last == ">" else { return false }
        let name = scalars[1 ..< scalars.count - 1]
        guard let first = name.first, first.isASCII, CharacterSet.letters.contains(first) else { return false }
        return name.allSatisfy { $0.isASCII && (CharacterSet.alphanumerics.contains($0) || $0 == "_" || $0 == "-") }
    }

    private static func pushPrompt(_ text: String, into entries: inout [Entry]) {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, !isInjected(value) else { return }
        entries.append(Entry(speaker: .person, text: value))
    }

    private static func pushProse(_ text: String, into entries: inout [Entry]) {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        entries.append(Entry(speaker: .agent, text: value))
    }

    /// One tool call's naming fields: each value's first line only (a command's heredoc body is
    /// content, not a name), capped at `maxToolValueCharacters`.
    private static func pushTool(_ name: String?, values: [String], into entries: inout [Entry]) {
        let kept = values.compactMap { value -> String? in
            let line = value.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty else { return nil }
            return trimmed.count > maxToolValueCharacters ? String(trimmed.prefix(maxToolValueCharacters)) : trimmed
        }
        guard !kept.isEmpty else { return }
        let tool = name?.trimmingCharacters(in: .whitespacesAndNewlines).prefix(64)
        entries.append(Entry(speaker: .tool, text: kept.joined(separator: " · "), tool: tool.map(String.init)))
    }

    // MARK: Budget

    /// Recognition items within the budget: the workspace sentence, the term sentence, then
    /// conversation entries newest first — tool entries never go in. The entry that crosses the
    /// budget is cut from its start (its end is the most recent part) and is the last one in.
    static func context(sentence: String?, termSentence: String?, entries: [Entry]) -> DictationContext {
        var items: [String] = []
        var used = 0
        for fixed in [sentence, termSentence].compactMap({ $0 }) {
            items.append(fixed)
            used += estimatedTokens(fixed)
        }
        var included = false
        for entry in entries.reversed() where entry.speaker != .tool {
            let text = (entry.speaker == .person ? "我：" : "Agent：") + entry.text
            let cost = estimatedTokens(text)
            if used + cost <= tokenBudget {
                items.append(text)
                used += cost
                included = true
                continue
            }
            let remaining = tokenBudget - used
            if remaining >= minimumTruncatedTokens {
                let prefix = entry.speaker == .person ? "我：…" : "Agent：…"
                let tail = suffix(of: entry.text, within: remaining - estimatedTokens(prefix))
                if !tail.isEmpty {
                    items.append(prefix + tail)
                    included = true
                }
            }
            break
        }
        return DictationContext(items: items, includesConversation: included)
    }

    /// CJK characters ≈ 1 token each; other text ≈ 4 characters per token.
    static func estimatedTokens(_ text: String) -> Int {
        var cjk = 0
        var other = 0
        for scalar in text.unicodeScalars {
            if isCJK(scalar) { cjk += 1 } else { other += 1 }
        }
        return cjk + (other + 3) / 4
    }

    /// The longest end of `text` within `budget` estimated tokens.
    static func suffix(of text: String, within budget: Int) -> String {
        guard budget > 0 else { return "" }
        var cjk = 0
        var other = 0
        var start = text.endIndex
        while start > text.startIndex {
            let previous = text.index(before: start)
            for scalar in text[previous].unicodeScalars {
                if isCJK(scalar) { cjk += 1 } else { other += 1 }
            }
            if cjk + (other + 3) / 4 > budget { break }
            start = previous
        }
        return String(text[start...]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func isCJK(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x3000 ... 0x303F, 0x3040 ... 0x30FF, 0x3400 ... 0x4DBF, 0x4E00 ... 0x9FFF,
             0xAC00 ... 0xD7AF, 0xF900 ... 0xFAFF, 0xFF00 ... 0xFFEF, 0x20000 ... 0x2FFFF:
            return true
        default:
            return false
        }
    }
}

/// Term derivation (plan 20261109-dictation-refine D10/D11): ASCII names the recogniser tends to
/// get wrong — identifiers, file and directory names, command words. Plain Chinese words are never
/// terms; they are what the recogniser already gets right.
enum DictationTerms {
    /// Bounded repository listing (D10): a fixed literal script, output capped on the device. Not a
    /// repository or no git prints nothing, which yields no terms.
    private static let repositoryScript = """
    set -u
    git -c core.quotePath=false ls-files 2>/dev/null | head -c 262144

    """
    static let repositoryListingBytes = 262_144

    static var repositoryCommand: (command: String, args: [String]) { ("sh", ["-c", repositoryScript, "sh"]) }

    /// Generic path pieces that name nothing in particular.
    private static let stopWords: Set<String> = [
        "src", "lib", "libs", "test", "tests", "spec", "docs", "doc", "index", "main", "app", "apps",
        "gen", "dist", "build", "bin", "tmp", "README", "LICENSE", "readme", "license", "the", "and",
        "for", "with", "from", "this", "that", "http", "https", "www", "com",
    ]
    private static let minimumLength = 3
    private static let maximumLength = 64
    /// Repository terms kept at most; the term sentence and the refiner's budget take far fewer.
    private static let maxRepositoryTerms = 4000
    /// Conversation terms kept at most.
    private static let maxConversationTerms = 1000

    /// Conversation and tool-input terms, newest entry first, in order of appearance within an entry.
    static func conversationTerms(_ entries: [DictationTranscript.Entry]) -> [String] {
        var seen = Set<String>()
        var collected: [String] = []
        for entry in entries.reversed() {
            for term in Self.terms(in: entry.text, lenient: entry.speaker == .tool) where seen.insert(term).inserted {
                collected.append(term)
                if collected.count >= maxConversationTerms { return collected }
            }
        }
        return collected
    }

    /// Directory names (most files beneath them first), then each file's stem and basename in
    /// listing order. A truncated last line is ignored.
    static func repositoryTerms(fromListing listing: String) -> [String] {
        var lines = listing.split(separator: "\n", omittingEmptySubsequences: true)
        if !listing.hasSuffix("\n"), !lines.isEmpty { lines.removeLast() }
        var directoryCounts: [String: Int] = [:]
        var directoryOrder: [String] = []
        var fileTerms: [String] = []
        var seenFiles = Set<String>()
        for line in lines {
            let components = line.split(separator: "/").map(String.init)
            guard let basename = components.last else { continue }
            for directory in components.dropLast() where isName(directory) {
                if directoryCounts[directory] == nil { directoryOrder.append(directory) }
                directoryCounts[directory, default: 0] += 1
            }
            for term in [stem(of: basename), basename] where isName(term) && seenFiles.insert(term).inserted {
                fileTerms.append(term)
            }
        }
        let directories = directoryOrder.enumerated()
            .sorted { lhs, rhs in
                let left = directoryCounts[lhs.element] ?? 0
                let right = directoryCounts[rhs.element] ?? 0
                return left != right ? left > right : lhs.offset < rhs.offset
            }
            .map(\.element)
        return Array(merged(directories, fileTerms).prefix(maxRepositoryTerms))
    }

    /// `first` then `second`, without repeats.
    static func merged(_ first: [String], _ second: [String]) -> [String] {
        var seen = Set<String>()
        return (first + second).filter { seen.insert($0).inserted }
    }

    /// 「相关术语：A、B、C。」 with as many terms as fit `budget` estimated tokens; nil without terms.
    static func sentence(_ terms: [String], budget: Int) -> String? {
        let prefix = "相关术语："
        var kept: [String] = []
        var used = DictationTranscript.estimatedTokens(prefix + "。")
        for term in terms {
            let cost = DictationTranscript.estimatedTokens(term) + (kept.isEmpty ? 0 : 1)
            if used + cost > budget { break }
            kept.append(term)
            used += cost
        }
        return kept.isEmpty ? nil : prefix + kept.joined(separator: "、") + "。"
    }

    /// Terms in one entry. Inside backticks, and everywhere in a tool input (`lenient`), any ASCII
    /// name counts; in prose only identifier-shaped tokens do, so ordinary English words stay out.
    /// Paths contribute their pieces.
    private static func terms(in text: String, lenient: Bool) -> [String] {
        var result: [String] = []
        var inCode = false
        var current = ""
        func flush() {
            defer { current = "" }
            let token = current.trimmingCharacters(in: CharacterSet(charactersIn: ".-/_"))
            guard !token.isEmpty else { return }
            if token.contains("/") {
                for piece in token.split(separator: "/").map(String.init) {
                    for term in [piece, Self.stem(of: piece)] where isName(term) { result.append(term) }
                }
                return
            }
            guard isName(token) else { return }
            if lenient || inCode || isIdentifierShaped(token) {
                result.append(token)
                let tokenStem = Self.stem(of: token)
                if tokenStem != token, isName(tokenStem), hasFileExtension(token) { result.append(tokenStem) }
            }
        }
        for character in text {
            if character == "`" {
                flush()
                inCode.toggle()
                continue
            }
            if character.isASCII, character.isLetter || character.isNumber || "_.-/".contains(character) {
                current.append(character)
            } else {
                flush()
            }
        }
        flush()
        return result
    }

    /// Long enough, not too long, has an ASCII letter, and is not a generic word.
    private static func isName(_ token: String) -> Bool {
        guard (minimumLength ... maximumLength).contains(token.count),
              token.contains(where: { $0.isASCII && $0.isLetter }),
              !token.hasPrefix("-")
        else { return false }
        return !stopWords.contains(token)
    }

    /// camelCase / PascalCase, snake_case, an acronym, letters with digits, or a dotted name with a
    /// part of two or more characters (`e.g` is not a name, `store.ts` is).
    private static func isIdentifierShaped(_ token: String) -> Bool {
        let letters = token.filter { $0.isLetter }
        if token.dropFirst().contains(where: { $0.isUppercase }) { return true }
        if token.contains("_") { return true }
        if letters.count >= 2, letters.allSatisfy({ $0.isUppercase }) { return true }
        if token.contains(where: { $0.isNumber }) { return true }
        if token.contains(".") {
            return token.split(separator: ".").contains { $0.count >= 2 } && token.split(separator: ".").count >= 2
        }
        return false
    }

    private static func hasFileExtension(_ token: String) -> Bool {
        guard let dot = token.lastIndex(of: "."), dot != token.startIndex else { return false }
        let ext = token[token.index(after: dot)...]
        return (1 ... 5).contains(ext.count) && ext.allSatisfy { $0.isLetter || $0.isNumber }
    }

    /// The name without its last extension; the name itself for dotfiles and names without one.
    private static func stem(of name: String) -> String {
        guard let dot = name.lastIndex(of: "."), dot != name.startIndex else { return name }
        return String(name[..<dot])
    }
}
