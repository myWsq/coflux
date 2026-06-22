//! 数据面二进制帧（pty.output / pty.input / pty.replay）。
//!
//! 与 TS `packages/protocol` 的 encodeFrame/decodeFrame 字节级一致：
//!   [kind:1][sidLen:1][sessionId:utf8][? ridLen:1][? requestId:utf8][payload 到帧尾]
//! kind: 1=output 2=input 3=replay（仅 replay 带 requestId）。
//!
//! data 用 `Vec<u8>` 而非 String：PTY 输出是原始字节，分块读取可能切断一个多字节
//! UTF-8 字符；按字节透传、不在边界处解码，避免损坏（TS 侧用 node-pty 已解码的字符串，
//! 到了 Rust + portable-pty 是裸字节，按字节处理才正确）。

pub const FRAME_OUTPUT: u8 = 1;
pub const FRAME_INPUT: u8 = 2;
pub const FRAME_REPLAY: u8 = 3;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DataFrame {
    Output { session_id: String, data: Vec<u8> },
    Input { session_id: String, data: Vec<u8> },
    Replay { session_id: String, request_id: String, data: Vec<u8> },
}

/// 编码为二进制帧。sessionId/requestId 为服务器签发的短 id（< 256 字节）。
pub fn encode_frame(frame: &DataFrame) -> Vec<u8> {
    let (kind, sid, rid, data): (u8, &str, Option<&str>, &[u8]) = match frame {
        DataFrame::Output { session_id, data } => (FRAME_OUTPUT, session_id, None, data),
        DataFrame::Input { session_id, data } => (FRAME_INPUT, session_id, None, data),
        DataFrame::Replay { session_id, request_id, data } => (FRAME_REPLAY, session_id, Some(request_id), data),
    };
    let sid = sid.as_bytes();
    debug_assert!(sid.len() <= 255, "sessionId too long for frame");
    let rid = rid.map(str::as_bytes);
    let mut out = Vec::with_capacity(2 + sid.len() + rid.map_or(0, |r| 1 + r.len()) + data.len());
    out.push(kind);
    out.push(sid.len() as u8);
    out.extend_from_slice(sid);
    if let Some(rid) = rid {
        debug_assert!(rid.len() <= 255, "requestId too long for frame");
        out.push(rid.len() as u8);
        out.extend_from_slice(rid);
    }
    out.extend_from_slice(data);
    out
}

/// 解码二进制帧；畸形返回 None（调用方丢弃，不 panic）。
pub fn decode_frame(buf: &[u8]) -> Option<DataFrame> {
    if buf.len() < 2 {
        return None;
    }
    let kind = buf[0];
    let sid_len = buf[1] as usize;
    if buf.len() < 2 + sid_len {
        return None;
    }
    let session_id = std::str::from_utf8(&buf[2..2 + sid_len]).ok()?.to_string();
    let mut off = 2 + sid_len;
    match kind {
        FRAME_OUTPUT => Some(DataFrame::Output { session_id, data: buf[off..].to_vec() }),
        FRAME_INPUT => Some(DataFrame::Input { session_id, data: buf[off..].to_vec() }),
        FRAME_REPLAY => {
            if buf.len() < off + 1 {
                return None;
            }
            let rid_len = buf[off] as usize;
            off += 1;
            if buf.len() < off + rid_len {
                return None;
            }
            let request_id = std::str::from_utf8(&buf[off..off + rid_len]).ok()?.to_string();
            off += rid_len;
            Some(DataFrame::Replay { session_id, request_id, data: buf[off..].to_vec() })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_roundtrip() {
        let f = DataFrame::Output { session_id: "sess-1".into(), data: b"hello\x1b[0m\xff".to_vec() };
        let enc = encode_frame(&f);
        assert_eq!(enc[0], FRAME_OUTPUT);
        assert_eq!(enc[1] as usize, "sess-1".len());
        assert_eq!(decode_frame(&enc), Some(f));
    }

    #[test]
    fn input_roundtrip() {
        let f = DataFrame::Input { session_id: "abc".into(), data: b"ls -la\r".to_vec() };
        assert_eq!(decode_frame(&encode_frame(&f)), Some(f));
    }

    #[test]
    fn replay_roundtrip() {
        let f = DataFrame::Replay { session_id: "s".into(), request_id: "req-9".into(), data: b"scrollback".to_vec() };
        let enc = encode_frame(&f);
        assert_eq!(enc[0], FRAME_REPLAY);
        assert_eq!(decode_frame(&enc), Some(f));
    }

    #[test]
    fn rejects_short_and_truncated() {
        assert_eq!(decode_frame(&[FRAME_OUTPUT]), None);
        assert_eq!(decode_frame(&[FRAME_OUTPUT, 5, b'a']), None); // sidLen=5 但不足
        assert_eq!(decode_frame(&[FRAME_REPLAY, 1, b's']), None); // 缺 ridLen
        assert_eq!(decode_frame(&[9, 0]), None); // 未知 kind
    }
}
