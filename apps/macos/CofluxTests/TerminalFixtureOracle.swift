import Foundation
import SwiftTerm
import XCTest

struct TerminalFixture: Decodable {
    struct Size: Decodable, Equatable {
        let cols: Int
        let rows: Int
    }

    struct Stage: Decodable {
        let marker: String
        let dataBase64: String
        let resizeAfter: Size?
    }

    let schemaVersion: Int
    let name: String
    let initial: Size
    let stages: [Stage]
    let tailBase64: String
}
struct SessionSnapshotFixture: Decodable {
    let schemaVersion: Int
    let fixtureId: String
    let fixtureName: String
    let cols: Int
    let rows: Int
    let ansiSnapshotBase64: String
}

private final class TerminalSink: TerminalDelegate {
    func send(source: Terminal, data: ArraySlice<UInt8>) {}
}

final class FixtureTerminal {
    private let sink = TerminalSink()
    let terminal: Terminal

    init(cols: Int, rows: Int) {
        terminal = Terminal(
            delegate: sink,
            options: TerminalOptions(cols: cols, rows: rows, scrollback: 2_000)
        )
    }

    func feed(_ data: Data) {
        terminal.feed(buffer: [UInt8](data)[...])
    }

    func resize(_ size: TerminalFixture.Size) {
        terminal.resize(cols: size.cols, rows: size.rows)
    }
}

struct TerminalColorState: Equatable, CustomStringConvertible {
    let value: String

    init(_ color: Attribute.Color?) {
        switch color {
        case .ansi256(let code):
            value = "ansi:\(code)"
        case .trueColor(let red, let green, let blue):
            value = "rgb:\(red),\(green),\(blue)"
        case .defaultColor:
            value = "default"
        case .defaultInvertedColor:
            value = "default-inverted"
        case nil:
            value = "none"
        }
    }

    var description: String { value }
}

struct TerminalCellState: Equatable, CustomStringConvertible {
    let character: String
    let width: Int
    let foreground: TerminalColorState
    let background: TerminalColorState
    let style: UInt8
    let underlineStyle: UInt8
    let underlineColor: TerminalColorState

    init(terminal: Terminal, cell: CharData) {
        let attribute = cell.attribute
        let resolved = String(terminal.getCharacter(for: cell))
        character = resolved == "\0" ? "" : resolved
        width = Int(cell.width)
        foreground = TerminalColorState(attribute.fg)
        background = TerminalColorState(attribute.bg)
        style = attribute.style.rawValue
        underlineStyle = attribute.underlineStyle.rawValue
        underlineColor = TerminalColorState(attribute.underlineColor)
    }

    var description: String {
        "char=\(character.debugDescription) width=\(width) fg=\(foreground) bg=\(background) style=\(style) underline=\(underlineStyle)/\(underlineColor)"
    }
}

struct TerminalLineState: Equatable {
    let absoluteRow: Int
    let isWrapped: Bool
    let cells: [TerminalCellState]
}

struct TerminalBufferState: Equatable {
    let cursorX: Int
    let cursorY: Int
    let viewportY: Int
    let linesTrimmed: Int
    let scrollTop: Int
    let scrollBottom: Int
    let lines: [TerminalLineState]
}

struct TerminalModeState: Equatable, CustomStringConvertible {
    let cursorVisible: Bool
    let applicationCursor: Bool
    let applicationKeypad: Bool
    let bracketedPaste: Bool

    var description: String {
        "cursorVisible=\(cursorVisible) applicationCursor=\(applicationCursor) applicationKeypad=\(applicationKeypad) bracketedPaste=\(bracketedPaste)"
    }
}

struct TerminalState: Equatable {
    let cols: Int
    let rows: Int
    let activeBuffer: String
    let modes: TerminalModeState
    let normal: TerminalBufferState
    let alternate: TerminalBufferState

    func firstDifference(from expected: TerminalState) -> String? {
        if cols != expected.cols || rows != expected.rows {
            return "geometry actual=\(cols)x\(rows) expected=\(expected.cols)x\(expected.rows)"
        }
        if activeBuffer != expected.activeBuffer {
            return "activeBuffer actual=\(activeBuffer) expected=\(expected.activeBuffer)"
        }
        if modes != expected.modes {
            return "modes actual={\(modes)} expected={\(expected.modes)}"
        }
        if let difference = normal.firstDifference(from: expected.normal, name: "normal") {
            return difference
        }
        return alternate.firstDifference(from: expected.alternate, name: "alternate")
    }
}

private extension TerminalBufferState {
    func firstDifference(from expected: TerminalBufferState, name: String) -> String? {
        let actualMetadata = [cursorX, cursorY, viewportY, linesTrimmed, scrollTop, scrollBottom]
        let expectedMetadata = [
            expected.cursorX,
            expected.cursorY,
            expected.viewportY,
            expected.linesTrimmed,
            expected.scrollTop,
            expected.scrollBottom,
        ]
        if actualMetadata != expectedMetadata {
            return "\(name) metadata actual=\(actualMetadata) expected=\(expectedMetadata)"
        }
        if lines.count != expected.lines.count {
            return "\(name) lineCount actual=\(lines.count) expected=\(expected.lines.count)"
        }
        for row in lines.indices {
            let actualLine = lines[row]
            let expectedLine = expected.lines[row]
            if actualLine.absoluteRow != expectedLine.absoluteRow || actualLine.isWrapped != expectedLine.isWrapped {
                return "\(name) row=\(row) metadata actual=(absolute:\(actualLine.absoluteRow), wrapped:\(actualLine.isWrapped)) expected=(absolute:\(expectedLine.absoluteRow), wrapped:\(expectedLine.isWrapped))"
            }
            if actualLine.cells.count != expectedLine.cells.count {
                return "\(name) row=\(row) cellCount actual=\(actualLine.cells.count) expected=\(expectedLine.cells.count)"
            }
            for column in actualLine.cells.indices where actualLine.cells[column] != expectedLine.cells[column] {
                return "\(name) cell=(\(row),\(column)) actual={\(actualLine.cells[column])} expected={\(expectedLine.cells[column])}"
            }
        }
        return nil
    }
}

enum TerminalStateCapture {
    private static let alternateOn = Data("\u{1b}[?47h".utf8)
    private static let alternateOff = Data("\u{1b}[?47l".utf8)

    static func capture(_ fixtureTerminal: FixtureTerminal) throws -> TerminalState {
        let terminal = fixtureTerminal.terminal
        let activeIsAlternate = terminal.isCurrentBufferAlternate
        let modes = TerminalModeState(
            cursorVisible: !(try reflectedBool(named: "cursorHidden", in: terminal)),
            applicationCursor: terminal.applicationCursor,
            applicationKeypad: try reflectedBool(named: "applicationKeypad", in: terminal),
            bracketedPaste: terminal.bracketedPasteMode
        )

        let active = try captureActiveBuffer(terminal)
        fixtureTerminal.feed(activeIsAlternate ? alternateOff : alternateOn)
        let inactive = try captureActiveBuffer(terminal)
        fixtureTerminal.feed(activeIsAlternate ? alternateOn : alternateOff)

        return TerminalState(
            cols: terminal.cols,
            rows: terminal.rows,
            activeBuffer: activeIsAlternate ? "alternate" : "normal",
            modes: modes,
            normal: activeIsAlternate ? inactive : active,
            alternate: activeIsAlternate ? active : inactive
        )
    }

    private static func captureActiveBuffer(_ terminal: Terminal) throws -> TerminalBufferState {
        let buffer = terminal.buffer
        let firstAbsoluteRow = buffer.totalLinesTrimmed
        var absoluteRow = firstAbsoluteRow
        var lines: [TerminalLineState] = []
        while let line = terminal.getScrollInvariantLine(row: absoluteRow) {
            let wrapped = try reflectedBool(named: "isWrapped", in: line)
            lines.append(
                TerminalLineState(
                    absoluteRow: absoluteRow,
                    isWrapped: wrapped,
                    cells: line.getData().map { TerminalCellState(terminal: terminal, cell: $0) }
                )
            )
            absoluteRow += 1
        }
        return TerminalBufferState(
            cursorX: buffer.x,
            cursorY: buffer.y,
            viewportY: buffer.yDisp,
            linesTrimmed: buffer.totalLinesTrimmed,
            scrollTop: buffer.scrollTop,
            scrollBottom: buffer.scrollBottom,
            lines: lines
        )
    }

    private static func reflectedBool(named name: String, in value: Any) throws -> Bool {
        var mirror: Mirror? = Mirror(reflecting: value)
        while let current = mirror {
            if let result = current.children.first(where: { $0.label == name })?.value as? Bool {
                return result
            }
            mirror = current.superclassMirror
        }
        throw TerminalOracleError.missingReflectedProperty(name)
    }
}

enum TerminalOracleError: Error, CustomStringConvertible {
    case invalidBase64(String)
    case missingReflectedProperty(String)

    var description: String {
        switch self {
        case .invalidBase64(let field):
            return "fixture 的 \(field) 不是合法 base64"
        case .missingReflectedProperty(let property):
            return "SwiftTerm 1.15.0 不再暴露可反射属性 \(property)，需显式更新 oracle adapter"
        }
    }
}

func decodeBase64(_ value: String, field: String) throws -> Data {
    guard let data = Data(base64Encoded: value) else {
        throw TerminalOracleError.invalidBase64(field)
    }
    return data
}
