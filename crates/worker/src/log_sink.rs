//! 命令终端的日志汇（plan 094，沿用已撤回的 093 实现）：替代 `| tee <log>` 站在包装脚本的管道尾，把命令输出原样透传到
//! PTY，同时落一份**有界、保尾**的日志供 `read_terminal`（source=log）回读。
//!
//! 四条不变量（plans/094 Decisions）：
//! - **有界**：日志按段轮转，磁盘占用不超过 2 × [`SEGMENT_BYTES`]（外加最后一个读块）；
//! - **保尾**：轮转只丢最旧的一段，最近 [SEGMENT_BYTES, 2 × SEGMENT_BYTES) 字节永远在盘上——
//!   跑了一天的 dev server 也能读到最新输出。段容量不小于 `read_terminal` 的读窗（256 KB），
//!   否则读窗永远填不满；
//! - **永不断管道**：本进程读 stdin 直到 EOF 才退出，PTY 写失败、日志写失败一律忽略并继续排空——
//!   只要读端活着，命令就不会收到 SIGPIPE（`head -c` 封顶式方案正是死在这里）；
//! - **退出码照旧**：本进程不参与退出码，脚本仍用 `${PIPESTATUS[0]}` 取命令自己的退出码。
//!
//! 以 worker 二进制自带子命令（`coflux-worker --log-sink <log>`）的形式存在：不引入外部依赖，
//! 包装脚本用 `std::env::current_exe()` 拿到自己的路径（见 [`crate::ops`]）。它会出现在会话
//! 进程树里——可执行名与首参数都不能长得像 agents.rs 名单里的 claude/codex，否则会被当成 agent。
//!
//! 轮转形态：当前段写满即 `rename(<log>, <log>.1)` 再新建当前段；读端把 `<log>.1` 的尾部与
//! `<log>` 拼起来（[`crate::ops::read_command_log_tail`]）。刻意不用「定期 truncate」：tee 式
//! 覆盖写在截断后继续写会留下带 NUL 洞的稀疏文件，尾部夹着垃圾。

use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

/// worker 二进制的日志汇子命令；写进包装脚本，改名等于改协议（老脚本仍引用旧名）。
pub const SUBCOMMAND: &str = "--log-sink";
/// 单段容量：保留尾部在 [1 MiB, 2 MiB) 之间。拍脑袋值——用户若反馈「读不到早期输出」，该做的是
/// `read_terminal` 支持按偏移读，而不是无脑调大它。
pub const SEGMENT_BYTES: u64 = 1024 * 1024;
/// 单次从 stdin 读取的块大小：与管道容量同量级，透传到 PTY 不额外攒批。
const READ_CHUNK_BYTES: usize = 64 * 1024;

/// 上一段的路径：`<log>.1`。
pub fn rotated_path(log: &Path) -> PathBuf {
    let mut name: OsString = log.as_os_str().to_os_string();
    name.push(".1");
    PathBuf::from(name)
}

/// 进程入口分流：argv 是 `--log-sink <log>` 时执行日志汇并返回退出码；否则返回 None，正常起 worker。
/// 必须在建 tokio 运行时之前判定——日志汇随命令活多久就活多久，不该为它起一整套调度线程。
pub fn run_if_requested() -> Option<i32> {
    let args: Vec<OsString> = std::env::args_os().collect();
    if args.get(1).map(OsString::as_os_str) != Some(OsStr::new(SUBCOMMAND)) {
        return None;
    }
    let Some(log) = args.get(2) else {
        eprintln!("[log-sink] 缺少日志路径");
        return Some(2);
    };
    let stdin = io::stdin();
    let stdout = io::stdout();
    Some(run(stdin.lock(), stdout.lock(), Path::new(log), SEGMENT_BYTES))
}

/// 读 `input` 直到 EOF：每块先透传到 `output`（失败后不再写但继续读），再追加进分段日志。
/// 返回值是进程退出码——恒为 0，退出码语义属于命令本身（脚本的 PIPESTATUS[0]）。
pub fn run<R: Read, W: Write>(mut input: R, mut output: W, log: &Path, segment_bytes: u64) -> i32 {
    // 日志打不开（目录被清、磁盘只读）也照样透传 + 排空：不能因为落盘失败让命令断管道。
    let mut sink = SegmentedLog::create(log, segment_bytes).ok();
    let mut output_alive = true;
    let mut buffer = vec![0u8; READ_CHUNK_BYTES];
    loop {
        let n = match input.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => n,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        let chunk = &buffer[..n];
        if output_alive && output.write_all(chunk).and_then(|_| output.flush()).is_err() {
            output_alive = false;
        }
        if let Some(log) = sink.as_mut() {
            let _ = log.append(chunk);
        }
    }
    if let Some(log) = sink.as_mut() {
        let _ = log.flush();
    }
    0
}

struct SegmentedLog {
    path: PathBuf,
    file: File,
    written: u64,
    segment_bytes: u64,
}

impl SegmentedLog {
    fn create(path: &Path, segment_bytes: u64) -> io::Result<Self> {
        // 同一脚本重跑（prepared operation 幂等重放）时上一次的旧段不能混进这次的尾部。
        let _ = std::fs::remove_file(rotated_path(path));
        let file = File::create(path)?;
        Ok(Self {
            path: path.to_path_buf(),
            file,
            written: 0,
            segment_bytes: segment_bytes.max(1),
        })
    }

    fn append(&mut self, chunk: &[u8]) -> io::Result<()> {
        self.file.write_all(chunk)?;
        self.written += chunk.len() as u64;
        if self.written >= self.segment_bytes {
            self.rotate()?;
        }
        Ok(())
    }

    /// 当前段封存为 `.1`（覆盖更早的那段），新建空的当前段。rename 是原子的，读端任一时刻
    /// 看到的都是完整文件，不会有半截段。
    fn rotate(&mut self) -> io::Result<()> {
        self.file.flush()?;
        std::fs::rename(&self.path, rotated_path(&self.path))?;
        self.file = File::create(&self.path)?;
        self.written = 0;
        Ok(())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn temp_log(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("coflux-log-sink-test");
        std::fs::create_dir_all(&dir).expect("mkdir");
        dir.join(format!("{tag}-{}.log", std::process::id()))
    }

    fn cleanup(log: &Path) {
        let _ = std::fs::remove_file(log);
        let _ = std::fs::remove_file(rotated_path(log));
    }

    /// 模拟管道：每次 read 只交出固定大小的一块，逼出多次轮转（Cursor 会一口气交完整个输入）。
    struct Chunked {
        data: Vec<u8>,
        offset: usize,
        chunk: usize,
    }

    impl Read for Chunked {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            let end = (self.offset + self.chunk).min(self.data.len());
            let n = (end - self.offset).min(buffer.len());
            buffer[..n].copy_from_slice(&self.data[self.offset..self.offset + n]);
            self.offset += n;
            Ok(n)
        }
    }

    /// 输入远超两段容量：磁盘占用有界、最新尾部完整在盘上、PTY 侧一字不少。
    #[test]
    fn rotation_bounds_disk_and_keeps_tail() {
        let log = temp_log("rotate");
        cleanup(&log);
        let segment = 1000u64;
        // 550 行 × 10 字节：每 100 行满一段，轮转 5 次后当前段剩 50 行（500 字节）
        let mut input = Vec::new();
        for i in 0..550 {
            input.extend_from_slice(format!("line-{i:04}\n").as_bytes());
        }
        let mut passthrough = Vec::new();
        let reader = Chunked { data: input.clone(), offset: 0, chunk: 10 };
        let code = run(reader, &mut passthrough, &log, segment);
        assert_eq!(code, 0);
        assert_eq!(passthrough, input, "PTY 侧必须原样透传");

        let current = std::fs::metadata(&log).expect("当前段").len();
        let previous = std::fs::metadata(rotated_path(&log)).expect("上一段").len();
        assert_eq!(current, 500, "当前段只有轮转后的 50 行");
        assert_eq!(previous, segment, "上一段写满即轮转");

        let key = log.to_string_lossy().into_owned();
        let tail = crate::ops::read_command_log_tail(&key, 256 * 1024).expect("读尾");
        assert!(tail.ends_with("line-0549\n"), "最新一行必须在: {:?}", &tail[tail.len().saturating_sub(40)..]);
        assert_eq!(tail.len(), 1500, "保留尾部 = 上一段 + 当前段");
        assert!(tail.starts_with("line-0400\n"), "上一段的首行: {:?}", &tail[..20]);
        assert!(!tail.contains("line-0000\n"), "最旧的段应已被丢弃");
        // 读窗跨段时把上一段尾部拼在前面且顺序正确
        let joined = crate::ops::read_command_log_tail(&key, 1200).unwrap();
        assert_eq!(joined.len(), 1200);
        assert!(joined.ends_with("line-0549\n"));
        let idx_prev = joined.find("line-0499\n").expect("上一段尾部应在拼接结果里");
        let idx_curr = joined.find("line-0500\n").expect("当前段首行应在拼接结果里");
        assert!(idx_prev < idx_curr, "上一段在前、当前段在后");
        cleanup(&log);
    }

    struct DeadOutput;
    impl Write for DeadOutput {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::Error::new(io::ErrorKind::BrokenPipe, "pty gone"))
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    /// PTY 侧断了（用户关掉会话/EPIPE）也要把 stdin 排空到 EOF——这就是「命令永不收到 SIGPIPE」
    /// 在进程内的对应物；日志照落。
    #[test]
    fn keeps_draining_when_output_is_dead() {
        let log = temp_log("dead-output");
        cleanup(&log);
        let input: Vec<u8> = (0..3000).flat_map(|i| format!("l{i}\n").into_bytes()).collect();
        let reader = Chunked { data: input, offset: 0, chunk: 512 };
        let code = run(reader, DeadOutput, &log, 4096);
        assert_eq!(code, 0, "输出端死掉不是错误");
        let tail = crate::ops::read_command_log_tail(&log.to_string_lossy(), 64 * 1024).unwrap();
        assert!(tail.ends_with("l2999\n"), "stdin 必须被读到 EOF: {:?}", &tail[tail.len().saturating_sub(20)..]);
        cleanup(&log);
    }

    /// 日志落不了盘（目录不存在）时仍透传全部输出并正常退出。
    #[test]
    fn log_failure_does_not_stop_passthrough() {
        let log = Path::new("/nonexistent/coflux-log-sink/never.log");
        let input = b"hello\nworld\n".to_vec();
        let mut passthrough = Vec::new();
        let code = run(Cursor::new(input.clone()), &mut passthrough, log, 1024);
        assert_eq!(code, 0);
        assert_eq!(passthrough, input);
    }

    /// 重跑同一脚本（同一日志路径）时旧的 `.1` 段必须清掉，否则上一次运行的尾巴会混进这次的读结果。
    #[test]
    fn rerun_discards_previous_rotated_segment() {
        let log = temp_log("rerun");
        cleanup(&log);
        std::fs::write(rotated_path(&log), b"STALE-FROM-LAST-RUN\n").unwrap();
        let code = run(Cursor::new(b"fresh\n".to_vec()), Vec::new(), &log, 1024);
        assert_eq!(code, 0);
        assert!(!rotated_path(&log).exists(), "旧段应被移除");
        let tail = crate::ops::read_command_log_tail(&log.to_string_lossy(), 1024).unwrap();
        assert_eq!(tail, "fresh\n");
        cleanup(&log);
    }
}
