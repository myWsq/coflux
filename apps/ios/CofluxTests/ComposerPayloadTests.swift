import Testing

@testable import Coflux

/// The bytes the composer and dictation write (plan D10): one write, line breaks flattened to
/// spaces, Enter appended unless the user long-pressed send, never bracketed paste.
struct ComposerPayloadTests {
    @Test func sendAppendsEnter() {
        #expect(ComposerPayload.bytes("fix it\nplease", withEnter: true) == "fix it please\r")
    }

    @Test func longPressSendsTextOnly() {
        #expect(ComposerPayload.bytes("fix it\nplease", withEnter: false) == "fix it please")
    }

    @Test func emptyTextSendsNothing() {
        #expect(ComposerPayload.bytes("", withEnter: true) == nil)
        #expect(ComposerPayload.bytes("", withEnter: false) == nil)
    }

    @Test func noBracketedPaste() {
        let payload = ComposerPayload.bytes("a\r\nb", withEnter: true) ?? ""
        #expect(!payload.contains("\u{1b}[200~"))
        #expect(!payload.contains("\n"))
        #expect(payload.hasSuffix("\r"))
    }
}
