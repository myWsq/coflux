import Foundation

/// 豆包 ASR 请求/响应的手写 protobuf 编解码——字段号、wire type 与
/// koe/koe-asr/src/doubaoime.rs 的 `mod proto`（第 33-210 行）逐字对应。
/// 逆向协议无 .proto 源，消息仅一进一出两种，手写比拉 SwiftProtobuf 依赖更薄
/// （plan 064 决策）。
enum DoubaoProtobuf {
    enum FrameState: Int32 {
        case first = 1
        case middle = 3
        case last = 9
    }

    struct AsrResponse {
        var messageType = ""
        var statusCode: Int32 = 0
        var statusMessage = ""
        var resultJSON = ""
    }

    enum DecodeError: Error {
        case truncated
        case unknownWireType(UInt8)
    }

    /// 对应 doubaoime.rs encode_asr_request：字段 2=token、3=service_name、
    /// 5=method_name、6=payload、7=audio_data、8=request_id、9=frame_state(枚举)
    static func encodeAsrRequest(
        token: String, serviceName: String, methodName: String, payload: String,
        audioData: Data, requestID: String, frameState: FrameState?
    ) -> Data {
        var buf = Data()
        writeStringField(2, token, into: &buf)
        writeStringField(3, serviceName, into: &buf)
        writeStringField(5, methodName, into: &buf)
        writeStringField(6, payload, into: &buf)
        writeBytesField(7, audioData, into: &buf)
        writeStringField(8, requestID, into: &buf)
        if let frameState {
            writeVarintField(9, frameState.rawValue, into: &buf)
        }
        return buf
    }

    /// 对应 doubaoime.rs decode_asr_response：字段 5=status_code(varint)、
    /// 4=message_type、6=status_message、7=result_json(均 length-delimited)
    static func decodeAsrResponse(_ data: Data) throws -> AsrResponse {
        var resp = AsrResponse()
        let bytes = [UInt8](data)
        var idx = 0
        let len = bytes.count
        while idx < len {
            let (tag, next) = try readVarint(bytes, idx)
            idx = next
            let fieldNum = UInt32(tag >> 3)
            let wireType = UInt8(tag & 0x07)
            switch wireType {
            case 0: // varint
                let (val, next2) = try readVarint(bytes, idx)
                idx = next2
                if fieldNum == 5 { resp.statusCode = Int32(truncatingIfNeeded: val) }
            case 2: // length-delimited
                let (fieldLen, next2) = try readVarint(bytes, idx)
                idx = next2
                let fieldLenInt = Int(fieldLen)
                guard idx + fieldLenInt <= len else { throw DecodeError.truncated }
                let fieldData = bytes[idx..<idx + fieldLenInt]
                idx += fieldLenInt
                switch fieldNum {
                case 4: resp.messageType = String(decoding: fieldData, as: UTF8.self)
                case 6: resp.statusMessage = String(decoding: fieldData, as: UTF8.self)
                case 7: resp.resultJSON = String(decoding: fieldData, as: UTF8.self)
                default: break
                }
            case 1: // fixed64
                guard idx + 8 <= len else { throw DecodeError.truncated }
                idx += 8
            case 5: // fixed32
                guard idx + 4 <= len else { throw DecodeError.truncated }
                idx += 4
            default:
                throw DecodeError.unknownWireType(wireType)
            }
        }
        return resp
    }

    private static func writeVarint(_ value: UInt64, into buf: inout Data) {
        var val = value
        while true {
            let byte = UInt8(val & 0x7F)
            val >>= 7
            if val == 0 {
                buf.append(byte)
                return
            }
            buf.append(byte | 0x80)
        }
    }

    private static func writeBytesField(_ fieldNum: UInt32, _ data: Data, into buf: inout Data) {
        guard !data.isEmpty else { return }
        writeVarint((UInt64(fieldNum) << 3) | 2, into: &buf)
        writeVarint(UInt64(data.count), into: &buf)
        buf.append(data)
    }

    private static func writeStringField(_ fieldNum: UInt32, _ value: String, into buf: inout Data) {
        writeBytesField(fieldNum, Data(value.utf8), into: &buf)
    }

    private static func writeVarintField(_ fieldNum: UInt32, _ value: Int32, into buf: inout Data) {
        guard value != 0 else { return }
        writeVarint((UInt64(fieldNum) << 3) | 0, into: &buf)
        writeVarint(UInt64(value), into: &buf)
    }

    private static func readVarint(_ bytes: [UInt8], _ start: Int) throws -> (UInt64, Int) {
        var result: UInt64 = 0
        var shift: UInt64 = 0
        var idx = start
        while true {
            guard idx < bytes.count else { throw DecodeError.truncated }
            let byte = bytes[idx]
            idx += 1
            result |= UInt64(byte & 0x7F) << shift
            if byte & 0x80 == 0 { return (result, idx) }
            shift += 7
            guard shift < 64 else { throw DecodeError.truncated }
        }
    }
}
