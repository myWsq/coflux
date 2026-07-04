//! 设备凭证本地持久化（~/.coflux/credentials.json，chmod 600）。与 TS creds.ts 同格式（camelCase）。

use std::fs;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
pub struct Credentials {
    #[serde(rename = "serverUrl")]
    pub server_url: String,
    #[serde(rename = "daemonId")]
    pub daemon_id: String,
    #[serde(rename = "deviceToken")]
    pub device_token: String,
}

/// daemon.authorizePending 落盘展示用（~/.coflux/pending-auth.json，chmod 600 —— url 内含一次性
/// 授权 token，视同密钥）。cofluxd 轮询它给用户打印授权链接；daemon 登记成功或断线即清掉（见 main.rs）。
#[derive(Clone, Serialize, Deserialize)]
pub struct PendingAuth {
    pub url: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: f64,
}

pub struct CredStore {
    path: String,
    home: String,
}

impl CredStore {
    pub fn new(path: String, home: String) -> Self {
        Self { path, home }
    }

    fn pending_auth_path(&self) -> String {
        format!("{}/pending-auth.json", self.home)
    }

    pub fn save_pending_auth(&self, p: &PendingAuth) {
        let _ = fs::create_dir_all(&self.home);
        let _ = fs::set_permissions(&self.home, fs::Permissions::from_mode(0o700));
        let json = match serde_json::to_string_pretty(p) {
            Ok(j) => j,
            Err(_) => return,
        };
        if let Ok(mut f) = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(self.pending_auth_path()) {
            let _ = f.write_all(json.as_bytes());
        }
    }

    pub fn clear_pending_auth(&self) {
        let _ = fs::remove_file(self.pending_auth_path());
    }

    pub fn load(&self) -> Option<Credentials> {
        let data = fs::read_to_string(&self.path).ok()?;
        let c: Credentials = serde_json::from_str(&data).ok()?;
        if c.device_token.is_empty() {
            None
        } else {
            Some(c)
        }
    }

    pub fn save(&self, c: &Credentials) {
        let _ = fs::create_dir_all(&self.home);
        let _ = fs::set_permissions(&self.home, fs::Permissions::from_mode(0o700));
        let json = match serde_json::to_string_pretty(c) {
            Ok(j) => j,
            Err(_) => return,
        };
        if let Ok(mut f) = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&self.path) {
            let _ = f.write_all(json.as_bytes());
        }
    }

    pub fn clear(&self) {
        let _ = fs::remove_file(&self.path);
    }
}
