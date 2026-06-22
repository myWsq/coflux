//! 用户配置 `~/.coflux/settings.json`（daemon 直接读）。
//! cofluxd 写它（含一次性登记密钥），daemon 启动时读取；env 同名变量可覆盖（测试/开发）。

use serde::Deserialize;

#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub server_url: Option<String>,
    pub enroll_key: Option<String>,
    pub device_name: Option<String>,
    pub shell: Option<String>,
}

impl Settings {
    /// 读 `<home>/settings.json`；缺失/损坏均返回默认（全 None）。
    pub fn load(home: &str) -> Self {
        std::fs::read_to_string(format!("{home}/settings.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }
}
