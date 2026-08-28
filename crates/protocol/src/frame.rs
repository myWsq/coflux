//! worker ⟷ supervisor 本地二进制帧。
//!
//! 布局：`[kind:1][idLen:1][id:utf8][payload 到帧尾]`。
//! kind 1 是 session dirty 通知（旧 output 编号，payload 只为滚动升级兼容而容忍）；
//! 2=input、3=replay 已永久保留但不再解码；4=proxy.data；5=device envelope。
//! proxy.data 的 id 是 connId；Device 的 id 是 logical channelId。payload 一律保留原始字节。

pub const FRAME_OUTPUT: u8 = 1;
pub const FRAME_INPUT: u8 = 2;
pub const FRAME_REPLAY: u8 = 3;
pub const FRAME_PROXY_DATA: u8 = 4;
pub const FRAME_DEVICE: u8 = 5;
/// frame 的 idLen 在线上只有一个字节；所有进入该字段的 ID 都必须遵守此上限。
pub const MAX_FRAME_ID_BYTES: usize = u8::MAX as usize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DataFrame {
    Output {
        session_id: String,
        data: Vec<u8>,
    },
    ProxyData {
        conn_id: String,
        data: Vec<u8>,
    },
    /// worker↔supervisor 的 multiplexed DeviceEnvelope；id 是 logical channelId。
    Device {
        channel_id: String,
        data: Vec<u8>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameEncodeError {
    IdTooLong { len: usize, max: usize },
}

impl std::fmt::Display for FrameEncodeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::IdTooLong { len, max } => write!(formatter, "frame ID 长度 {len} 超过上限 {max}"),
        }
    }
}

impl std::error::Error for FrameEncodeError {}

/// 编码为二进制帧。ID 最多 255 字节；拒绝超长值，不能在 release 构建静默截断。
pub fn encode_frame(frame: &DataFrame) -> Result<Vec<u8>, FrameEncodeError> {
    let (kind, sid, data): (u8, &str, &[u8]) = match frame {
        DataFrame::Output { session_id, data } => (FRAME_OUTPUT, session_id, data),
        DataFrame::ProxyData { conn_id, data } => (FRAME_PROXY_DATA, conn_id, data),
        DataFrame::Device { channel_id, data } => (FRAME_DEVICE, channel_id, data),
    };
    let sid = sid.as_bytes();
    let sid_len = u8::try_from(sid.len()).map_err(|_| FrameEncodeError::IdTooLong {
        len: sid.len(),
        max: MAX_FRAME_ID_BYTES,
    })?;
    let mut out = Vec::with_capacity(2 + sid.len() + data.len());
    out.push(kind);
    out.push(sid_len);
    out.extend_from_slice(sid);
    out.extend_from_slice(data);
    Ok(out)
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
    let off = 2 + sid_len;
    match kind {
        FRAME_OUTPUT => Some(DataFrame::Output {
            session_id,
            data: buf[off..].to_vec(),
        }),
        FRAME_INPUT | FRAME_REPLAY => None,
        FRAME_PROXY_DATA => Some(DataFrame::ProxyData {
            conn_id: session_id,
            data: buf[off..].to_vec(),
        }),
        FRAME_DEVICE => Some(DataFrame::Device {
            channel_id: session_id,
            data: buf[off..].to_vec(),
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_roundtrip() {
        let f = DataFrame::Output {
            session_id: "sess-1".into(),
            data: b"hello\x1b[0m\xff".to_vec(),
        };
        let enc = encode_frame(&f).unwrap();
        assert_eq!(enc[0], FRAME_OUTPUT);
        assert_eq!(enc[1] as usize, "sess-1".len());
        assert_eq!(decode_frame(&enc), Some(f));
    }

    #[test]
    fn legacy_input_and_replay_kinds_are_reserved() {
        assert_eq!(decode_frame(&[FRAME_INPUT, 1, b's', b'x']), None);
        assert_eq!(decode_frame(&[FRAME_REPLAY, 1, b's', b'x']), None);
    }

    #[test]
    fn rejects_short_and_truncated() {
        assert_eq!(decode_frame(&[FRAME_OUTPUT]), None);
        assert_eq!(decode_frame(&[FRAME_OUTPUT, 5, b'a']), None); // sidLen=5 但不足
        assert_eq!(decode_frame(&[FRAME_REPLAY, 1, b's']), None); // reserved kind
        assert_eq!(decode_frame(&[9, 0]), None); // 未知 kind
    }

    #[test]
    fn proxy_data_roundtrip() {
        let f = DataFrame::ProxyData {
            conn_id: "conn-42".into(),
            data: b"GET / HTTP/1.1\r\n\xff\x00binary".to_vec(),
        };
        let enc = encode_frame(&f).unwrap();
        assert_eq!(enc[0], FRAME_PROXY_DATA);
        assert_eq!(enc[1] as usize, "conn-42".len());
        assert_eq!(decode_frame(&enc), Some(f));
    }

    #[test]
    fn proxy_data_rejects_truncated() {
        assert_eq!(decode_frame(&[FRAME_PROXY_DATA]), None);
        assert_eq!(decode_frame(&[FRAME_PROXY_DATA, 5, b'a']), None); // idLen=5 但不足
    }

    #[test]
    fn device_envelope_roundtrip() {
        let f = DataFrame::Device {
            channel_id: "local-1".into(),
            data: vec![0, 1, 2, 0xff],
        };
        let enc = encode_frame(&f).unwrap();
        assert_eq!(enc[0], FRAME_DEVICE);
        assert_eq!(decode_frame(&enc), Some(f));
    }

    #[test]
    fn frame_id_accepts_255_bytes_and_rejects_256() {
        let accepted = DataFrame::Device {
            channel_id: "a".repeat(MAX_FRAME_ID_BYTES),
            data: vec![7],
        };
        let encoded = encode_frame(&accepted).unwrap();
        assert_eq!(encoded[1], u8::MAX);
        assert_eq!(decode_frame(&encoded), Some(accepted));

        let rejected = DataFrame::Device {
            channel_id: "b".repeat(MAX_FRAME_ID_BYTES + 1),
            data: vec![7],
        };
        assert_eq!(
            encode_frame(&rejected),
            Err(FrameEncodeError::IdTooLong {
                len: MAX_FRAME_ID_BYTES + 1,
                max: MAX_FRAME_ID_BYTES
            })
        );
    }
}
