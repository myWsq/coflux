//! 远程下载 + 验签：有界下载 worker 产物 → 校 sha256 / size → 验 legacy
//! raw-binary 签名与 domain-separated release statement → 持久化到同目录临时文件。
//! manager 确认它仍是最新请求后才原子晋升并切换。
//!
//! 安全：验签把“发布 worker 二进制”的权限与中心/下载源分开；未持发布私钥者不能把任意字节
//! 冒充合法升级产物。它不是中心控制面的沙箱——中心已有 exec/session 编排能力。公钥来自 baked-in
//! 或 env `COFLUX_WORKER_PUBKEY` 覆盖（测试/自带密钥部署）；远端无法设置本机 env。未配有效公钥时
//! 下载升级一律被拒。release statement 认证 version / Rust target / sha256 / artifact size
//! 这组发布身份与元数据（URL 只是下载位置，无需签入）；严格 SemVer 同时是
//! supervisor 本地 anti-rollback 的单调序列。

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use semver::Version;
use sha2::{Digest, Sha256};

use crate::manager::WorkerSpec;

/// worker 产物硬上限。既检查 Content-Length，也对实际解码后的响应体做限长读取，
/// chunked/错误声明长度都不能绕过。当前 debug worker 约 33 MiB，128 MiB 留足发布余量。
const MAX_WORKER_BYTES: u64 = 128 * 1024 * 1024;
const DOWNLOAD_INITIAL_CAPACITY: u64 = 1024 * 1024;
const MAX_VERSION_BYTES: usize = 128;
const MAX_TARGET_BYTES: usize = 128;
const MAX_UPGRADE_URL_BYTES: usize = 8192;
const RELEASE_STATEMENT_DOMAIN: &[u8] = b"coflux-worker-release-v1\0";
const RELEASE_FLOOR_MARKER: &str = "worker.release-floor";

/// 编译期内置的发布公钥（来自提交的 `release-pubkey.hex`，公钥非密可提交）。
/// 占位为全 0（无效点）→ 默认下载升级被拒；发布者用 `scripts/gen-keypair.mjs` 生成后换入并提交。
const BAKED_IN_PUBKEY_HEX: &str = include_str!("../release-pubkey.hex");

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// 发布版本必须是带 `v` 前缀的规范严格 SemVer。build metadata 不参与
/// SemVer precedence；相同 precedence 的另一字符串仍按 replay 拒绝。
#[derive(Clone, Debug)]
pub(crate) struct ReleaseVersion {
    raw: String,
    parsed: Version,
}

impl ReleaseVersion {
    pub(crate) fn parse(raw: &str) -> Result<Self, String> {
        if raw.len() > MAX_VERSION_BYTES {
            return Err(format!("release version 超过 {MAX_VERSION_BYTES} 字节"));
        }
        let semver = raw
            .strip_prefix('v')
            .ok_or_else(|| "release version 必须是带 v 前缀的严格 SemVer".to_string())?;
        let parsed = Version::parse(semver)
            .map_err(|error| format!("release version 不是严格 SemVer: {error}"))?;
        if format!("v{parsed}") != raw {
            return Err("release version 不是规范 SemVer 表示".to_string());
        }
        Ok(Self {
            raw: raw.to_string(),
            parsed,
        })
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.raw
    }

    pub(crate) fn is_newer_than(&self, other: &Self) -> bool {
        self.parsed.cmp_precedence(&other.parsed).is_gt()
    }

    pub(crate) fn max(self, other: Self) -> Self {
        if other.is_newer_than(&self) {
            other
        } else {
            self
        }
    }
}

/// 发布矩阵只产出这四个 target。Linux 即使本地 debug supervisor 是 gnu，也要
/// 验证真实发布产物使用的 musl triple；否则本地测试与生产会用两套语义。
pub(crate) fn current_release_target() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("macos", "x86_64") => "x86_64-apple-darwin",
        ("linux", "aarch64") => "aarch64-unknown-linux-musl",
        ("linux", "x86_64") => "x86_64-unknown-linux-musl",
        _ => "unsupported",
    }
}

fn append_len_prefixed(out: &mut Vec<u8>, value: &[u8]) {
    out.extend_from_slice(&(value.len() as u32).to_be_bytes());
    out.extend_from_slice(value);
}

/// 跨语言签名 transcript：`domain || len(version) || version || len(target) || target ||
/// sha256(raw 32B) || artifact_size(BE64)`。所有可变长字段均有 BE32 长度前缀。
pub(crate) fn release_statement(
    version: &str,
    target: &str,
    sha256: &[u8; 32],
    artifact_size: u64,
) -> Vec<u8> {
    let mut statement = Vec::with_capacity(
        RELEASE_STATEMENT_DOMAIN.len() + 4 + version.len() + 4 + target.len() + 32 + 8,
    );
    statement.extend_from_slice(RELEASE_STATEMENT_DOMAIN);
    append_len_prefixed(&mut statement, version.as_bytes());
    append_len_prefixed(&mut statement, target.as_bytes());
    statement.extend_from_slice(sha256);
    statement.extend_from_slice(&artifact_size.to_be_bytes());
    statement
}

fn verifying_key() -> Option<VerifyingKey> {
    let hexkey =
        std::env::var("COFLUX_WORKER_PUBKEY").unwrap_or_else(|_| BAKED_IN_PUBKEY_HEX.to_string());
    let bytes = hex::decode(hexkey.trim()).ok()?;
    let arr: [u8; 32] = bytes.try_into().ok()?;
    VerifyingKey::from_bytes(&arr).ok()
}

/// 校验 server 下发的 version 可安全用作单一路径成分：防 `../` 穿越出 workers/ 目录，
/// 防污染注册表内置项。即便攻破的服务器拿到合法签名产物，也无法把它写到任意路径。
pub fn validate_version(version: &str) -> Result<(), String> {
    if version.is_empty() {
        return Err("version 为空".into());
    }
    if version == "builtin" {
        return Err("version 'builtin' 为保留名，拒绝".into());
    }
    if version == "." {
        return Err("version '.' 会折叠为 workers 根目录，拒绝".into());
    }
    if version.len() > MAX_VERSION_BYTES {
        return Err(format!("version 超过 {MAX_VERSION_BYTES} 字节"));
    }
    if version.contains("..") {
        return Err(format!("version 含非法序列 '..': {version}"));
    }
    if !version
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '+'))
    {
        return Err(format!(
            "version 含非法字符（仅允许 A-Za-z0-9._-+）: {version}"
        ));
    }
    Ok(())
}

/// 在启动下载线程、发起网络请求前完成所有固定形状校验，避免畸形控制消息占用线程/带宽。
pub fn validate_upgrade_request(
    version: &str,
    url: &str,
    expected_sha256: &str,
    signature_hex: &str,
    target: &str,
    artifact_size: u64,
    release_signature_hex: &str,
) -> Result<ReleaseVersion, String> {
    let release_version = ReleaseVersion::parse(version)?;
    validate_version(version)?;
    if url.is_empty() || url.len() > MAX_UPGRADE_URL_BYTES {
        return Err(format!("升级 URL 为空或超过 {MAX_UPGRADE_URL_BYTES} 字节"));
    }
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("升级 URL 仅允许 http/https".to_string());
    }
    let sha = hex::decode(expected_sha256.trim()).map_err(|_| "sha256 非法 hex".to_string())?;
    if sha.len() != 32 {
        return Err("sha256 长度非法".to_string());
    }
    if target.is_empty() || target.len() > MAX_TARGET_BYTES {
        return Err(format!("release target 为空或超过 {MAX_TARGET_BYTES} 字节"));
    }
    if target != current_release_target() {
        return Err(format!(
            "release target 不匹配: 期望 {}, 收到 {target}",
            current_release_target()
        ));
    }
    if artifact_size == 0 || artifact_size > MAX_WORKER_BYTES {
        return Err(format!(
            "artifact size 必须在 1..={MAX_WORKER_BYTES} 字节内"
        ));
    }
    let signature =
        hex::decode(signature_hex.trim()).map_err(|_| "legacy 签名非法 hex".to_string())?;
    if signature.len() != 64 {
        return Err("legacy 签名长度非法".to_string());
    }
    let release_signature = hex::decode(release_signature_hex.trim())
        .map_err(|_| "release 签名非法 hex".to_string())?;
    if release_signature.len() != 64 {
        return Err("release 签名长度非法".to_string());
    }
    Ok(release_version)
}

fn sync_dir(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|dir| dir.sync_all())
        .map_err(|error| format!("同步目录 {} 失败: {error}", path.display()))
}

/// 确保目录真实存在且不是符号链接；server 可控的 version 不能借已有链接把产物引出 workers/。
/// 返回本次是否新建，调用方据此同步父目录的目录项。
fn ensure_real_dir(path: &Path) -> Result<bool, String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() => {
            Ok(false)
        }
        Ok(_) => Err(format!("{} 不是安全的真实目录", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match std::fs::create_dir(path) {
                Ok(()) => Ok(true),
                // 并发 staging 都可能先观察到 NotFound。输掉 create_dir 的一方必须
                // 重新验证赢家创建的是安全真实目录，不能把正常竞态当安装失败。
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let metadata = std::fs::symlink_metadata(path)
                        .map_err(|error| format!("复查目录 {} 失败: {error}", path.display()))?;
                    if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() {
                        Ok(true)
                    } else {
                        Err(format!("{} 并发创建后不是安全的真实目录", path.display()))
                    }
                }
                Err(error) => Err(format!("创建目录 {} 失败: {error}", path.display())),
            }
        }
        Err(error) => Err(format!("检查目录 {} 失败: {error}", path.display())),
    }
}

fn create_temp_file(dir: &Path, prefix: &str) -> Result<(File, PathBuf), String> {
    for _ in 0..32 {
        let id = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = dir.join(format!(".{prefix}.{}.{}.tmp", std::process::id(), id));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((file, path)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("创建临时文件 {} 失败: {error}", path.display())),
        }
    }
    Err(format!("在 {} 创建唯一临时文件失败", dir.display()))
}

fn read_bounded_with_limit(
    mut reader: impl Read,
    announced_length: Option<u64>,
    limit: u64,
) -> Result<Vec<u8>, String> {
    if announced_length.is_some_and(|length| length > limit) {
        return Err(format!("worker 产物过大（上限 {limit} 字节）"));
    }
    // Content-Length 来自远端；不能仅凭一个 128 MiB 声明就立刻预留 128 MiB。
    let capacity = announced_length
        .unwrap_or(0)
        .min(limit)
        .min(DOWNLOAD_INITIAL_CAPACITY) as usize;
    let mut body = Vec::with_capacity(capacity);
    reader
        .by_ref()
        .take(limit + 1)
        .read_to_end(&mut body)
        .map_err(|error| format!("读取下载响应失败: {error}"))?;
    if body.len() as u64 > limit {
        return Err(format!("worker 产物过大（上限 {limit} 字节）"));
    }
    if body.is_empty() {
        return Err("worker 产物为空".to_string());
    }
    Ok(body)
}

fn read_bounded(reader: impl Read, announced_length: Option<u64>) -> Result<Vec<u8>, String> {
    read_bounded_with_limit(reader, announced_length, MAX_WORKER_BYTES)
}

fn prepare_version_dir(home: &Path, version: &str) -> Result<(PathBuf, PathBuf), String> {
    let workers = home.join("workers");
    if ensure_real_dir(&workers)? {
        sync_dir(home)?;
    }
    let version_dir = workers.join(version);
    if ensure_real_dir(&version_dir)? {
        sync_dir(&workers)?;
    }
    Ok((workers, version_dir))
}

/// 已验签并 fsync 的候选文件。Drop 会删除未晋升的临时文件，所以过期 generation、
/// supervisor 正常拒绝和安装失败都不会污染正式 `coflux-worker`。
pub struct StagedWorker {
    version: String,
    digest: [u8; 32],
    temp_path: Option<PathBuf>,
    final_path: PathBuf,
    workers_dir: PathBuf,
    version_dir: PathBuf,
}

impl StagedWorker {
    /// 在 manager 的 generation 临界区内调用。rename 与目标位于同一目录，晋升原子；
    /// 文件本体、版本目录和 workers 目录都同步后才返回可执行 spec。
    pub fn install(mut self) -> Result<WorkerSpec, String> {
        if self.final_path.exists() {
            let metadata = std::fs::symlink_metadata(&self.final_path).map_err(|error| {
                format!(
                    "检查已安装 worker {} 失败: {error}",
                    self.final_path.display()
                )
            })?;
            if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
                return Err(format!(
                    "已安装 worker {} 不是安全的普通文件",
                    self.final_path.display()
                ));
            }
            // 只需读 fd：owner 可用 fchmod 修复连写位也丢失（如 0444）的文件，fsync
            // 同样允许只读 fd。若要求 write 打开，恰会在最需要自愈时先被权限拒绝。
            let mut existing_file = File::open(&self.final_path)
                .map_err(|error| format!("打开已安装 worker 失败: {error}"))?;
            let existing = read_bounded(&mut existing_file, Some(metadata.len()))?;
            let existing_digest: [u8; 32] = Sha256::digest(&existing).into();
            if existing_digest != self.digest {
                return Err(format!(
                    "版本 {} 已安装但内容不同，拒绝复用版本号覆盖",
                    self.version
                ));
            }
            // 同版本同内容是幂等请求，但上一次可能在 rename 后、目录 fsync 前失败，或
            // 正式文件的执行位后来丢失。重新修复权限并同步文件/两级目录后才能宣告成功。
            existing_file
                .set_permissions(std::fs::Permissions::from_mode(0o755))
                .map_err(|error| format!("修复已安装 worker 执行权限失败: {error}"))?;
            existing_file
                .sync_all()
                .map_err(|error| format!("同步已安装 worker 失败: {error}"))?;
            sync_dir(&self.version_dir)?;
            sync_dir(&self.workers_dir)?;
            return Ok(WorkerSpec {
                version: self.version.clone(),
                cmd: self.final_path.to_string_lossy().into_owned(),
                args: vec![],
            });
        }

        let temp_path = self.temp_path.take().ok_or("候选 worker 临时文件已失效")?;
        if let Err(error) = std::fs::rename(&temp_path, &self.final_path) {
            self.temp_path = Some(temp_path);
            return Err(format!("原子安装 worker 失败: {error}"));
        }
        sync_dir(&self.version_dir)?;
        sync_dir(&self.workers_dir)?;

        Ok(WorkerSpec {
            version: self.version.clone(),
            cmd: self.final_path.to_string_lossy().into_owned(),
            args: vec![],
        })
    }
}

impl Drop for StagedWorker {
    fn drop(&mut self) {
        if let Some(path) = self.temp_path.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}

pub(crate) fn stage_verified_bytes(
    home: &Path,
    version: &str,
    body: &[u8],
    digest: [u8; 32],
) -> Result<StagedWorker, String> {
    let (workers_dir, version_dir) = prepare_version_dir(home, version)?;
    let (mut file, temp_path) = create_temp_file(&version_dir, "coflux-worker")?;
    let staged = StagedWorker {
        version: version.to_string(),
        digest,
        final_path: version_dir.join("coflux-worker"),
        temp_path: Some(temp_path),
        workers_dir,
        version_dir,
    };
    file.write_all(body)
        .map_err(|error| format!("写 worker 临时文件失败: {error}"))?;
    file.set_permissions(std::fs::Permissions::from_mode(0o755))
        .map_err(|error| format!("设置 worker 执行权限失败: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("同步 worker 临时文件失败: {error}"))?;
    drop(file);
    Ok(staged)
}

/// 下载、校验并写入 fsync 过的临时文件；不会改动正式产物路径。
pub fn download_verify_stage(
    url: &str,
    expected_sha256: &str,
    signature_hex: &str,
    home: &str,
    version: &str,
    target: &str,
    artifact_size: u64,
    release_signature_hex: &str,
) -> Result<StagedWorker, String> {
    validate_upgrade_request(
        version,
        url,
        expected_sha256,
        signature_hex,
        target,
        artifact_size,
        release_signature_hex,
    )?;
    let vk = verifying_key().ok_or("未配置有效的 worker 公钥，拒绝下载升级")?;

    let resp = ureq::get(url)
        .timeout(Duration::from_secs(60))
        .call()
        .map_err(|error| format!("下载失败: {error}"))?;
    let announced_length = resp
        .header("Content-Length")
        .and_then(|value| value.parse::<u64>().ok());
    if announced_length.is_some_and(|length| length != artifact_size) {
        return Err(format!(
            "Content-Length 与已签名 artifact size 不符: 声明 {artifact_size}, 响应 {}",
            announced_length.unwrap_or_default()
        ));
    }
    let body = read_bounded_with_limit(resp.into_reader(), announced_length, artifact_size)?;
    if body.len() as u64 != artifact_size {
        return Err(format!(
            "worker 产物实际长度与已签名 artifact size 不符: 声明 {artifact_size}, 实得 {}",
            body.len()
        ));
    }

    // sha256（完整性，服务器声明的期望值）：强制提供，空值不再放行（防御纵深，不留跳过口）。
    let digest: [u8; 32] = Sha256::digest(&body).into();
    let got = hex::encode(digest);
    if expected_sha256.trim().is_empty() {
        return Err("缺少 sha256，拒绝升级".to_string());
    }
    if got != expected_sha256.trim().to_lowercase() {
        return Err(format!("sha256 不符: 期望 {expected_sha256}, 实得 {got}"));
    }

    // legacy raw-binary 签名仍必须正确：同一份 manifest 可继续服务旧 supervisor。
    let sig_bytes = hex::decode(signature_hex.trim()).map_err(|_| "签名非法 hex".to_string())?;
    let sig = Signature::from_slice(&sig_bytes).map_err(|_| "签名长度非法".to_string())?;
    vk.verify(&body, &sig)
        .map_err(|_| "legacy 签名校验失败（产物被篡改或非可信来源）".to_string())?;

    // 新签名认证发布语义；仅重用 raw 签名不再能伪造 version/target/size。
    let expected_digest: [u8; 32] = hex::decode(expected_sha256.trim())
        .map_err(|_| "sha256 非法 hex".to_string())?
        .try_into()
        .map_err(|_| "sha256 长度非法".to_string())?;
    let release_sig_bytes = hex::decode(release_signature_hex.trim())
        .map_err(|_| "release 签名非法 hex".to_string())?;
    let release_sig = Signature::from_slice(&release_sig_bytes)
        .map_err(|_| "release 签名长度非法".to_string())?;
    let statement = release_statement(version, target, &expected_digest, artifact_size);
    vk.verify(&statement, &release_sig)
        .map_err(|_| "release statement 签名校验失败（发布元数据被篡改）".to_string())?;

    stage_verified_bytes(Path::new(home), version, &body, digest)
}

/// marker 统一用同目录临时文件 + fsync + rename，避免断电/进程退出留下空文件。
fn persist_marker(home: &str, name: &str, value: &str) -> Result<(), String> {
    let home = Path::new(home);
    let (mut file, temp_path) = create_temp_file(home, name)?;
    let final_path = home.join(name);
    let result = (|| {
        file.write_all(value.as_bytes())
            .map_err(|error| format!("写 {name} 临时文件失败: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("同步 {name} 临时文件失败: {error}"))?;
        drop(file);
        std::fs::rename(&temp_path, &final_path)
            .map_err(|error| format!("原子更新 {name} 失败: {error}"))?;
        sync_dir(home)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp_path);
    }
    result
}

pub fn persist_active_version(home: &str, version: &str) -> Result<(), String> {
    persist_marker(home, "worker.active", version)
}

pub(crate) fn persist_release_floor(home: &str, version: &ReleaseVersion) -> Result<(), String> {
    persist_marker(home, RELEASE_FLOOR_MARKER, version.as_str())
}

/// 本地 floor 不需要签名：它只抵抗远端回放，能改本地 COFLUX_HOME 的攻击者已在
/// supervisor 威胁模型之外。但仍拒绝 symlink/过长/非 SemVer marker，避免意外损坏降级为放行。
pub(crate) fn load_release_floor(home: &str) -> Result<Option<ReleaseVersion>, String> {
    let path = Path::new(home).join(RELEASE_FLOOR_MARKER);
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("读取 {} 元数据失败: {error}", path.display())),
    };
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(format!("{} 不是安全的普通文件", path.display()));
    }
    if metadata.len() == 0 || metadata.len() > MAX_VERSION_BYTES as u64 {
        return Err(format!("{} 长度非法", path.display()));
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|error| format!("读取 {} 失败: {error}", path.display()))?;
    ReleaseVersion::parse(raw.trim()).map(Some)
}

/// 从下载目录恢复 worker 时只接受真实、非链接、非空且带执行位的普通文件。
pub fn installed_worker_spec(home: &str, version: &str) -> Result<WorkerSpec, String> {
    validate_version(version)?;
    let home = Path::new(home);
    let workers = home.join("workers");
    let version_dir = workers.join(version);
    for dir in [&workers, &version_dir] {
        let metadata = std::fs::symlink_metadata(dir)
            .map_err(|error| format!("检查 {} 失败: {error}", dir.display()))?;
        if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
            return Err(format!("{} 不是安全的真实目录", dir.display()));
        }
    }
    let path = version_dir.join("coflux-worker");
    let metadata = std::fs::symlink_metadata(&path)
        .map_err(|error| format!("检查 {} 失败: {error}", path.display()))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() || metadata.len() == 0 {
        return Err(format!("{} 不是可恢复的普通 worker 文件", path.display()));
    }
    if metadata.permissions().mode() & 0o111 == 0 {
        return Err(format!("{} 没有执行权限", path.display()));
    }
    Ok(WorkerSpec {
        version: version.to_string(),
        cmd: path.to_string_lossy().into_owned(),
        args: vec![],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_home(name: &str) -> PathBuf {
        let id = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "coflux-supervisor-{name}-{}-{id}",
            std::process::id()
        ));
        std::fs::create_dir(&path).unwrap();
        path
    }

    #[test]
    fn bounded_reader_rejects_declared_and_actual_oversize() {
        let error = read_bounded_with_limit(&b"ok"[..], Some(9), 8).unwrap_err();
        assert!(error.contains("过大"));

        let reader = std::io::repeat(7).take(9);
        let error = read_bounded_with_limit(reader, None, 8).unwrap_err();
        assert!(error.contains("过大"));
    }

    #[test]
    fn active_marker_is_atomic_and_downloaded_worker_recovery_is_strict() {
        let home = test_home("recovery");
        persist_active_version(home.to_str().unwrap(), "v1.2.3").unwrap();
        assert_eq!(
            std::fs::read_to_string(home.join("worker.active")).unwrap(),
            "v1.2.3"
        );

        let version_dir = home.join("workers/v1.2.3");
        std::fs::create_dir_all(&version_dir).unwrap();
        let worker = version_dir.join("coflux-worker");
        std::fs::write(&worker, b"worker").unwrap();
        std::fs::set_permissions(&worker, std::fs::Permissions::from_mode(0o755)).unwrap();
        let spec = installed_worker_spec(home.to_str().unwrap(), "v1.2.3").unwrap();
        assert_eq!(spec.cmd, worker.to_string_lossy());

        std::fs::set_permissions(&worker, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(installed_worker_spec(home.to_str().unwrap(), "v1.2.3")
            .unwrap_err()
            .contains("执行权限"));
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn staged_worker_only_appears_at_final_path_after_atomic_install() {
        let home = test_home("atomic-install");
        let body = b"signed worker bytes";
        let digest: [u8; 32] = Sha256::digest(body).into();
        let staged = stage_verified_bytes(&home, "v2", body, digest).unwrap();
        let final_path = home.join("workers/v2/coflux-worker");
        assert!(!final_path.exists(), "晋升前正式路径不可见");
        assert!(
            staged.temp_path.as_ref().unwrap().exists(),
            "验签内容已在同目录临时文件持久化"
        );

        let spec = staged.install().unwrap();
        assert_eq!(spec.cmd, final_path.to_string_lossy());
        assert_eq!(std::fs::read(&final_path).unwrap(), body);
        assert_ne!(
            std::fs::metadata(&final_path).unwrap().permissions().mode() & 0o111,
            0
        );

        // 同版本同内容幂等，并修复上次安装后丢失的执行位；同版本不同内容拒绝覆盖。
        std::fs::set_permissions(&final_path, std::fs::Permissions::from_mode(0o444)).unwrap();
        stage_verified_bytes(&home, "v2", body, digest)
            .unwrap()
            .install()
            .unwrap();
        assert_ne!(
            std::fs::metadata(&final_path).unwrap().permissions().mode() & 0o111,
            0,
            "同 digest 重试也必须恢复执行位后才成功"
        );
        let other = b"different signed bytes";
        let other_digest: [u8; 32] = Sha256::digest(other).into();
        let error = stage_verified_bytes(&home, "v2", other, other_digest)
            .unwrap()
            .install()
            .unwrap_err();
        assert!(error.contains("内容不同"));
        assert_eq!(std::fs::read(&final_path).unwrap(), body);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn invalid_versions_never_escape_workers_directory() {
        for version in ["", ".", "builtin", "../evil", "a/b", "a b"] {
            assert!(validate_version(version).is_err(), "应拒绝 {version:?}");
        }
        assert!(validate_version(&"v".repeat(MAX_VERSION_BYTES + 1)).is_err());
        assert!(validate_version("v1.2.3-rc_1").is_ok());
        assert!(validate_version("v1.2.3+build.1").is_ok());
    }

    #[test]
    fn malformed_upgrade_fields_are_rejected_before_network_access() {
        let sha = "00".repeat(32);
        let signature = "11".repeat(64);
        let release_signature = "22".repeat(64);
        let target = current_release_target();
        assert!(validate_upgrade_request(
            "v1.2.3",
            "https://example.invalid/worker",
            &sha,
            &signature,
            target,
            1,
            &release_signature,
        )
        .is_ok());
        assert!(validate_upgrade_request(
            "v1.2.3",
            "file:///etc/passwd",
            &sha,
            &signature,
            target,
            1,
            &release_signature,
        )
        .is_err());
        assert!(validate_upgrade_request(
            "v1.2.3",
            "https://example.invalid/worker",
            "00",
            &signature,
            target,
            1,
            &release_signature,
        )
        .is_err());
        assert!(validate_upgrade_request(
            "v1.2.3",
            "https://example.invalid/worker",
            &sha,
            "11",
            target,
            1,
            &release_signature,
        )
        .is_err());
        assert!(validate_upgrade_request(
            "v1.2.3",
            &format!(
                "https://example.invalid/{}",
                "a".repeat(MAX_UPGRADE_URL_BYTES)
            ),
            &sha,
            &signature,
            target,
            1,
            &release_signature,
        )
        .is_err());
        assert!(validate_upgrade_request(
            "not-semver",
            "https://example.invalid/worker",
            &sha,
            &signature,
            target,
            1,
            &release_signature,
        )
        .is_err());
        assert!(validate_upgrade_request(
            "v1.2.3",
            "https://example.invalid/worker",
            &sha,
            &signature,
            "aarch64-unknown-cross-target",
            1,
            &release_signature,
        )
        .is_err());
        assert!(validate_upgrade_request(
            "v1.2.3",
            "https://example.invalid/worker",
            &sha,
            &signature,
            target,
            0,
            &release_signature,
        )
        .is_err());
        assert!(validate_upgrade_request(
            "v1.2.3",
            "https://example.invalid/worker",
            &sha,
            &signature,
            target,
            1,
            "22",
        )
        .is_err());
    }

    #[test]
    fn release_statement_matches_node_signer_vector() {
        let mut digest = [0u8; 32];
        digest[31] = 0xff;
        let statement = release_statement(
            "v1.2.3-rc.1",
            "aarch64-unknown-linux-musl",
            &digest,
            123_456_789,
        );
        assert_eq!(
            hex::encode(statement),
            "636f666c75782d776f726b65722d72656c656173652d7631000000000b76312e322e332d72632e310000001a616172636836342d756e6b6e6f776e2d6c696e75782d6d75736c00000000000000000000000000000000000000000000000000000000000000ff00000000075bcd15"
        );
    }

    #[test]
    fn release_semver_precedence_and_floor_marker_are_strict() {
        let rc = ReleaseVersion::parse("v2.0.0-rc.2").unwrap();
        let stable = ReleaseVersion::parse("v2.0.0").unwrap();
        let next = ReleaseVersion::parse("v2.0.1").unwrap();
        let build_one = ReleaseVersion::parse("v2.0.0+build.1").unwrap();
        let build_two = ReleaseVersion::parse("v2.0.0+build.2").unwrap();
        assert!(stable.is_newer_than(&rc));
        assert!(next.is_newer_than(&stable));
        assert!(!rc.is_newer_than(&stable));
        assert!(!build_two.is_newer_than(&build_one));
        assert!(!build_one.is_newer_than(&build_two));
        assert!(ReleaseVersion::parse("2.0.0").is_err());
        assert!(ReleaseVersion::parse("v02.0.0").is_err());
        assert!(ReleaseVersion::parse("v2.0.0-01").is_err());

        let home = test_home("release-floor");
        persist_release_floor(home.to_str().unwrap(), &stable).unwrap();
        let loaded = load_release_floor(home.to_str().unwrap()).unwrap().unwrap();
        assert_eq!(loaded.as_str(), "v2.0.0");
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn concurrent_first_staging_reuses_safely_created_directories() {
        let home = std::sync::Arc::new(test_home("concurrent-stage"));
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(16));
        let body = b"same signed worker bytes";
        let digest: [u8; 32] = Sha256::digest(body).into();
        let mut threads = Vec::new();
        for _ in 0..16 {
            let home = std::sync::Arc::clone(&home);
            let barrier = std::sync::Arc::clone(&barrier);
            threads.push(std::thread::spawn(move || {
                barrier.wait();
                let staged = stage_verified_bytes(&home, "v-race", body, digest).unwrap();
                assert!(staged.temp_path.as_ref().unwrap().exists());
            }));
        }
        for thread in threads {
            thread.join().unwrap();
        }
        assert!(home.join("workers/v-race").is_dir());
        std::fs::remove_dir_all(home.as_ref()).unwrap();
    }
}
