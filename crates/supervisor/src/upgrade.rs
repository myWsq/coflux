//! 远程下载 + 验签：下载 worker 产物 → 校 sha256 → 验 ed25519 签名 → 落盘 → 返回可切换的 spec。
//!
//! 安全：验签防的是"中心服务器被攻破 → 推恶意产物"。公钥来自 baked-in（占位，发布签名流程
//! 建好后替换）或 env `COFLUX_WORKER_PUBKEY` 覆盖（用于测试/自带密钥部署）。被攻破的服务器无法
//! 设置本地 env，故 env 覆盖不削弱该威胁下的安全属性。未配有效公钥时下载升级一律被拒。

use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};

use crate::manager::WorkerSpec;

/// 编译期内置的发布公钥（来自提交的 `release-pubkey.hex`，公钥非密可提交）。
/// 占位为全 0（无效点）→ 默认下载升级被拒；发布者用 `scripts/gen-keypair.mjs` 生成后换入并提交。
const BAKED_IN_PUBKEY_HEX: &str = include_str!("../release-pubkey.hex");

fn verifying_key() -> Option<VerifyingKey> {
    let hexkey = std::env::var("COFLUX_WORKER_PUBKEY").unwrap_or_else(|_| BAKED_IN_PUBKEY_HEX.to_string());
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
    if version.contains("..") {
        return Err(format!("version 含非法序列 '..': {version}"));
    }
    if !version.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')) {
        return Err(format!("version 含非法字符（仅允许 A-Za-z0-9._-）: {version}"));
    }
    Ok(())
}

/// 下载 + 验签 + 落盘。任一校验不过返回 Err（调用方据此拒绝升级、保持当前版本）。
pub fn download_verify_install(url: &str, expected_sha256: &str, signature_hex: &str, home: &str, version: &str) -> Result<WorkerSpec, String> {
    validate_version(version)?;
    let vk = verifying_key().ok_or("未配置有效的 worker 公钥，拒绝下载升级")?;

    // 下载
    let resp = ureq::get(url).timeout(Duration::from_secs(60)).call().map_err(|e| format!("下载失败: {e}"))?;
    let mut body = Vec::new();
    resp.into_reader().read_to_end(&mut body).map_err(|e| format!("读取失败: {e}"))?;

    // sha256（完整性，服务器声明的期望值）：强制提供，空值不再放行（防御纵深，不留跳过口）。
    let got = hex::encode(Sha256::digest(&body));
    if expected_sha256.trim().is_empty() {
        return Err("缺少 sha256，拒绝升级".to_string());
    }
    if got != expected_sha256.trim().to_lowercase() {
        return Err(format!("sha256 不符: 期望 {expected_sha256}, 实得 {got}"));
    }

    // ed25519 验签（真实性：对产物字节）
    let sig_bytes = hex::decode(signature_hex.trim()).map_err(|_| "签名非法 hex".to_string())?;
    let sig = Signature::from_slice(&sig_bytes).map_err(|_| "签名长度非法".to_string())?;
    vk.verify(&body, &sig).map_err(|_| "签名校验失败（产物被篡改或非可信来源）".to_string())?;

    // 落盘到 home/workers/<version>/coflux-worker（chmod +x）
    let dir = format!("{home}/workers/{version}");
    std::fs::create_dir_all(&dir).map_err(|e| format!("建目录失败: {e}"))?;
    let path = format!("{dir}/coflux-worker");
    std::fs::write(&path, &body).map_err(|e| format!("写产物失败: {e}"))?;
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755));

    Ok(WorkerSpec { version: version.to_string(), cmd: path, args: vec![] })
}
