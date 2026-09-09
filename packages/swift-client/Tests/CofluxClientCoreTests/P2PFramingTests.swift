import Foundation
import Testing
@testable import CofluxClientCore

struct P2PFramingTests {
    @Test func wireFormatAndChunkBoundary() throws {
        #expect(try P2PFraming.chunks(for: Data([7, 8, 9])) == [Data([0, 0, 0, 3, 7, 8, 9])])
        let chunks = try P2PFraming.chunks(for: Data(repeating: 0xab, count: 16_384))
        #expect(chunks.map(\.count) == [16_384, 4])
        #expect(chunks[0].prefix(4) == Data([0, 0, 0x40, 0]))
        #expect(chunks[1] == Data(repeating: 0xab, count: 4))
    }

    @Test func fragmentedHeaderAndCoalescedFrames() throws {
        // 独立手写的线上字节，避免只证明编码器与自身互逆。
        let wire = Data([0, 0, 0, 3, 7, 8, 9, 0, 0, 0, 2, 10, 11])
        for split in 0...wire.count {
            var assembler = P2PFrameAssembler()
            var frames = try assembler.push(wire.prefix(split))
            frames += try assembler.push(Data())
            frames += try assembler.push(wire.dropFirst(split))
            #expect(frames == [Data([7, 8, 9]), Data([10, 11])])
        }
    }

    @Test func slicedDataAndBytewiseDelivery() throws {
        let frame = Data([99, 7, 8, 9]).dropFirst()
        #expect(frame.startIndex != 0)
        let wire = try P2PFraming.chunks(for: frame).flatMap { $0 }
        var assembler = P2PFrameAssembler()
        var frames: [Data] = []
        for byte in wire { frames += try assembler.push(Data([99, byte]).dropFirst()) }
        #expect(frames == [Data([7, 8, 9])])
    }

    @Test func largeFrameAndTrailingPartialFrame() throws {
        let frame = Data(repeating: 0xab, count: 300 * 1024)
        var assembler = P2PFrameAssembler()
        var frames: [Data] = []
        for chunk in try P2PFraming.chunks(for: frame) {
            #expect(chunk.count <= 16_384)
            frames += try assembler.push(chunk)
        }
        #expect(try assembler.push(Data([0, 0, 0, 4, 0x74, 0x61])).isEmpty)
        frames += try assembler.push(Data([0x69, 0x6c]))
        #expect(frames == [frame, Data("tail".utf8)])
    }

    @Test func invalidLengthPermanentlyRejectsStream() throws {
        for prefix in [Data([0, 0, 0, 0]), Data([1, 0xe0, 0, 1]), Data([255, 255, 255, 255])] {
            var assembler = P2PFrameAssembler()
            #expect(throws: P2PFramingError.self) { try assembler.push(prefix) }
            #expect(throws: P2PFramingError.invalidStream) {
                try assembler.push(Data([0, 0, 0, 1, 42]))
            }
        }
        #expect(throws: P2PFramingError.invalidFrameLength(0)) {
            try P2PFraming.chunks(for: Data())
        }
        #expect(throws: P2PFramingError.self) {
            try P2PFraming.chunks(for: Data(repeating: 0, count: 30 * 1024 * 1024 + 1))
        }
    }

    @Test func maximumFrameAccepted() throws {
        var assembler = P2PFrameAssembler()
        #expect(try assembler.push(Data([1, 0xe0, 0, 0])).isEmpty)
        let chunk = Data(repeating: 42, count: 16_384)
        for _ in 0..<(30 * 1024 * 1024 / 16_384 - 1) {
            #expect(try assembler.push(chunk).isEmpty)
        }
        let frames = try assembler.push(chunk)
        #expect(frames.count == 1)
        #expect(frames.first?.count == 30 * 1024 * 1024)
        #expect(frames.first?.allSatisfy { $0 == 42 } == true)
    }
}
