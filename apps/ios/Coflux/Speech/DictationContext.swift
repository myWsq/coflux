import CofluxClientCore
import CofluxProtocol
import Foundation

/// Recognition context for one dictation (plan 20261108-ios-seed-asr, D3/D4/D5): a sentence naming
/// the project, workspace and branch, then the current agent's conversation, newest first, within
/// a budget of about 1500 estimated tokens. Seed-ASR uses it to spell project words and names
/// right; it never sees the terminal screen.
struct DictationContext: Sendable, Equatable {
    /// Plain-text context items: the workspace sentence first (when anything is known), then
    /// conversation entries newest first.
    let items: [String]
    /// At least one conversation entry made it in (drives the overlay badge).
    let includesConversation: Bool

    static let empty = DictationContext(items: [], includesConversation: false)

    /// The workspace sentence alone: the context whenever the conversation cannot be read.
    static func workspaceOnly(_ sentence: String?) -> DictationContext {
        DictationContext(items: sentence.map { [$0] } ?? [], includesConversation: false)
    }
}

/// Where the context comes from: the terminal's agent (from `sessionAgents`) and the workspace it
/// runs in. Built on the MainActor at touch-down; `load` then reads the agent transcript on the
/// device through `executeInWorkspace`, the same way the desktop's copyable conversation does
/// (terminal-transcript.ts), and never fails — every miss degrades to the workspace sentence.
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

    /// Read and parse the transcript; the workspace sentence alone for a plain shell, an unknown
    /// agent, an unusable id, a missing or unreadable file, or an exec error. Cancellable: a
    /// cancelled load returns the fallback.
    func load(client: CofluxClient) async -> DictationContext {
        guard let agent, let agentSessionID, DictationTranscript.isUsableAgentSessionID(agentSessionID) else {
            return fallback
        }
        let invocation = DictationTranscript.command(agent: agent, agentSessionID: agentSessionID)
        let result: Coflux_V1_ExecResult
        do {
            result = try await client.executeInWorkspace(workspaceID: workspaceID, command: invocation.command, args: invocation.args)
        } catch {
            return fallback
        }
        guard !Task.isCancelled, result.ok, result.exitCode == 0 else { return fallback }
        let stdout = result.stdout
        let sentence = workspaceSentence
        return await Task.detached(priority: .userInitiated) {
            let entries = DictationTranscript.parseOutput(agent: agent, stdout: stdout) ?? []
            return DictationTranscript.context(sentence: sentence, entries: entries)
        }.value
    }
}

/// The transcript reader, ported from apps/desktop/src/renderer/components/workbench/terminal-transcript.ts
/// with two differences (D4): the agent's reasoning (Claude `thinking`, Codex `reasoning` summaries)
/// is kept, and tool calls produce no entries at all.
///
/// The agent session id is never interpolated into command text (D5): the scripts are fixed
/// literals referencing `"$1"`, and the id travels as its own argv entry.
enum DictationTranscript {
    enum Agent: Sendable {
        case claude
        case codex
    }

    struct Entry: Sendable, Equatable {
        enum Speaker: Sendable { case person, agent }
        let speaker: Speaker
        let text: String
    }

    /// Upper bound for the agent session id; mirrors the worker and server checks.
    private static let maxAgentSessionIDLength = 128
    /// Bounded tail read: the recent conversation is all the context needs.
    static let tailBytes = 256 * 1024
    private static let headerPrefix = "coflux-transcript"
    /// Token budget for all items together (D3).
    static let tokenBudget = 1500
    /// A truncated entry shorter than this is not worth sending.
    private static let minimumTruncatedTokens = 24

    /// Exit codes shared by both scripts: 3 = not found, 4 = read failed.
    private static let claudeLocatorScript = """
    set -u
    id="$1"
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
    printf 'coflux-transcript %s 262144\\n' "$size"
    tail -c 262144 "$newest" || exit 4

    """

    private static let codexLocatorScript = """
    set -u
    id="$1"
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
    printf 'coflux-transcript %s 262144\\n' "$size"
    tail -c 262144 "$newest" || exit 4

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

    /// The exact invocation: `sh -c '<fixed script>' sh <id>`.
    static func command(agent: Agent, agentSessionID: String) -> (command: String, args: [String]) {
        let script = agent == .claude ? claudeLocatorScript : codexLocatorScript
        return ("sh", ["-c", script, "sh", agentSessionID])
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
            default: break  // tool_use and everything else: no entry
            }
        }
    }

    // MARK: Codex

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
        default:
            break  // tool calls, agent_message and bookkeeping: no entry
        }
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

    // MARK: Budget

    /// Items within the budget: the sentence, then entries newest first. The entry that crosses
    /// the budget is cut from its start (its end is the most recent part) and is the last one in.
    static func context(sentence: String?, entries: [Entry]) -> DictationContext {
        var items: [String] = []
        var used = 0
        if let sentence {
            items.append(sentence)
            used += estimatedTokens(sentence)
        }
        var included = false
        for entry in entries.reversed() {
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
    private static func suffix(of text: String, within budget: Int) -> String {
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
