//! loopback gateway 的本地身份与授权状态。
//!
//! gateway 私钥、中心安装的 browser grant 与 Origin allowlist 原子落盘；online lease 只在
//! 内存中存在，并在中心连接断开时立即清空。签名 transcript 严格遵循 device.proto 冻结格式。

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use coflux_protocol::wire::{
    DeviceScope, LocalAuthErrorCode, LocalBrowserGrant, LocalClientHello, LocalGatewayDescriptor,
    LocalGatewayHello, OnlineDeviceLease,
};
use coflux_protocol::DEVICE_PROTOCOL_VERSION;
use p256::ecdsa::signature::{Signer, Verifier};
use p256::ecdsa::{Signature, SigningKey, VerifyingKey};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};

const STORE_VERSION: u32 = 1;
const STORE_FILE: &str = "local-gateway.json";
const DEFAULT_CHALLENGE_TTL: Duration = Duration::from_secs(20);
const DEFAULT_FAILURE_LIMIT: usize = 8;
const DEFAULT_FAILURE_WINDOW: Duration = Duration::from_secs(60);
const GATEWAY_DOMAIN: &[u8] = b"coflux-local-gateway-v1";
const CLIENT_DOMAIN: &[u8] = b"coflux-local-client-v1";
const MAX_ID_BYTES: usize = 256;
const MAX_ORIGIN_BYTES: usize = 2048;
const MAX_ORIGINS: usize = 64;
const MAX_GRANTS: usize = 1024;
const MAX_LEASES: usize = 4096;

#[derive(Debug, Clone)]
pub struct AuthFailure {
    pub code: LocalAuthErrorCode,
    pub message: &'static str,
}

impl AuthFailure {
    fn new(code: LocalAuthErrorCode, message: &'static str) -> Self {
        Self { code, message }
    }
}

#[derive(Debug, Clone)]
pub struct LocalPrincipal {
    pub grant_id: String,
    pub account_id: String,
    pub daemon_id: String,
    pub origin: String,
    pub browser_public_key_sec1: Vec<u8>,
    pub client_instance_id: String,
    pub transport_generation: u64,
    pub lease_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AuthenticatedLocal {
    pub principal: LocalPrincipal,
    pub scopes: Vec<i32>,
}

#[derive(Debug)]
pub struct LocalChallenge {
    pub hello: LocalGatewayHello,
    issued_at: Instant,
    used: bool,
}

#[derive(Debug, Clone, Default)]
struct LocalState {
    origins: BTreeSet<String>,
    grants: BTreeMap<String, LocalBrowserGrant>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedStore {
    version: u32,
    private_key: String,
    #[serde(default)]
    origins: Vec<String>,
    #[serde(default)]
    grants: Vec<PersistedGrant>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedGrant {
    grant_id: String,
    account_id: String,
    daemon_id: String,
    origin: String,
    public_key_sec1: String,
    offline_scopes: Vec<i32>,
    created_at: f64,
}

impl PersistedGrant {
    fn from_wire(grant: &LocalBrowserGrant) -> Self {
        Self {
            grant_id: grant.grant_id.clone(),
            account_id: grant.account_id.clone(),
            daemon_id: grant.daemon_id.clone(),
            origin: grant.origin.clone(),
            public_key_sec1: BASE64.encode(&grant.public_key_sec1),
            offline_scopes: grant.offline_scopes.clone(),
            created_at: grant.created_at,
        }
    }

    fn into_wire(self) -> Result<LocalBrowserGrant, String> {
        let public_key_sec1 = BASE64
            .decode(self.public_key_sec1)
            .map_err(|_| "grant public key base64 无效".to_string())?;
        Ok(LocalBrowserGrant {
            grant_id: self.grant_id,
            account_id: self.account_id,
            daemon_id: self.daemon_id,
            origin: self.origin,
            public_key_sec1,
            offline_scopes: self.offline_scopes,
            created_at: self.created_at,
        })
    }
}

#[derive(Default)]
struct FailureLimiter {
    by_origin: HashMap<String, VecDeque<Instant>>,
    limit: usize,
    window: Duration,
}

impl FailureLimiter {
    fn new(limit: usize, window: Duration) -> Self {
        Self {
            by_origin: HashMap::new(),
            limit: limit.max(1),
            window,
        }
    }

    fn purge(queue: &mut VecDeque<Instant>, now: Instant, window: Duration) {
        while queue
            .front()
            .is_some_and(|instant| now.saturating_duration_since(*instant) >= window)
        {
            queue.pop_front();
        }
    }

    fn allowed(&mut self, origin: &str, now: Instant) -> bool {
        let queue = self.by_origin.entry(origin.to_string()).or_default();
        Self::purge(queue, now, self.window);
        queue.len() < self.limit
    }

    fn failed(&mut self, origin: &str, now: Instant) {
        let queue = self.by_origin.entry(origin.to_string()).or_default();
        Self::purge(queue, now, self.window);
        queue.push_back(now);
    }

    fn succeeded(&mut self, origin: &str) {
        self.by_origin.remove(origin);
    }
}

pub struct LocalAuth {
    path: PathBuf,
    signing_key: SigningKey,
    state: Mutex<LocalState>,
    leases: Mutex<HashMap<String, OnlineDeviceLease>>,
    server_online: AtomicBool,
    limiter: Mutex<FailureLimiter>,
    challenge_ttl: Duration,
}

impl LocalAuth {
    pub fn load_or_create(home: &str) -> Result<Self, String> {
        Self::load_or_create_path(
            PathBuf::from(home).join(STORE_FILE),
            DEFAULT_CHALLENGE_TTL,
            DEFAULT_FAILURE_LIMIT,
            DEFAULT_FAILURE_WINDOW,
        )
    }

    fn load_or_create_path(
        path: PathBuf,
        challenge_ttl: Duration,
        failure_limit: usize,
        failure_window: Duration,
    ) -> Result<Self, String> {
        let (signing_key, state) = match fs::read(&path) {
            Ok(bytes) => decode_store(&bytes)?,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                let signing_key = SigningKey::random(&mut OsRng);
                let state = LocalState::default();
                match create_initial_store(&path, &signing_key, &state) {
                    Ok(()) => (signing_key, state),
                    Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                        let bytes = fs::read(&path).map_err(|read_error| {
                            format!("读取并发创建的 local gateway store: {read_error}")
                        })?;
                        decode_store(&bytes)?
                    }
                    Err(error) => return Err(format!("创建 local gateway store: {error}")),
                }
            }
            Err(error) => return Err(format!("读取 local gateway store: {error}")),
        };
        secure_permissions(&path)?;
        Ok(Self {
            path,
            signing_key,
            state: Mutex::new(state),
            leases: Mutex::new(HashMap::new()),
            server_online: AtomicBool::new(false),
            limiter: Mutex::new(FailureLimiter::new(failure_limit, failure_window)),
            challenge_ttl,
        })
    }

    pub fn descriptor(&self, port: u16) -> LocalGatewayDescriptor {
        LocalGatewayDescriptor {
            protocol_version: DEVICE_PROTOCOL_VERSION,
            port: u32::from(port),
            public_key_sec1: self.gateway_public_key(),
        }
    }

    pub fn gateway_public_key(&self) -> Vec<u8> {
        self.signing_key
            .verifying_key()
            .to_encoded_point(false)
            .as_bytes()
            .to_vec()
    }

    pub fn origin_allowed(&self, origin: &str) -> bool {
        self.state.lock().unwrap().origins.contains(origin)
    }

    pub fn configure_origins(&self, origins: Vec<String>) -> Result<(), String> {
        if origins.len() > MAX_ORIGINS {
            return Err("Origin allowlist 超过上限".into());
        }
        let mut normalized = BTreeSet::new();
        for origin in origins {
            if !valid_origin(&origin) {
                return Err("Origin 必须是无 path/query 的 http(s) origin".into());
            }
            normalized.insert(origin);
        }
        self.update_state(|state| state.origins = normalized)
    }

    /// 返回是否实际改变持久 grant；幂等重装不应迫使现有 direct channel 重连。
    pub fn install_grant(
        &self,
        mut grant: LocalBrowserGrant,
        daemon_id: &str,
    ) -> Result<bool, String> {
        validate_grant(&grant, Some(daemon_id))?;
        grant.offline_scopes.sort_unstable();
        grant.offline_scopes.dedup();
        {
            let state = self.state.lock().unwrap();
            if !state.grants.contains_key(&grant.grant_id) && state.grants.len() >= MAX_GRANTS {
                return Err("browser grant 数量超过上限".into());
            }
            if state.grants.get(&grant.grant_id) == Some(&grant) {
                return Ok(false);
            }
        }
        self.update_state(|state| {
            state.grants.insert(grant.grant_id.clone(), grant);
        })?;
        Ok(true)
    }

    pub fn revoke_grant(&self, grant_id: &str) -> Result<(), String> {
        if !valid_identifier(grant_id) {
            return Err("grantId 无效或过长".into());
        }
        self.update_state(|state| {
            state.grants.remove(grant_id);
        })?;
        self.leases
            .lock()
            .unwrap()
            .retain(|_, lease| lease.grant_id != grant_id);
        Ok(())
    }

    pub fn set_server_online(&self, online: bool) {
        self.server_online.store(online, Ordering::Release);
        if !online {
            self.leases.lock().unwrap().clear();
        }
    }

    pub fn install_lease(&self, lease: OnlineDeviceLease, daemon_id: &str) -> Result<(), String> {
        if !self.server_online.load(Ordering::Acquire) {
            return Err("中心连接离线，不能安装 lease".into());
        }
        validate_lease(
            &lease,
            daemon_id,
            &self.state.lock().unwrap().grants,
            epoch_ms(),
        )?;
        let mut leases = self.leases.lock().unwrap();
        let now = epoch_ms();
        leases.retain(|_, lease| lease.expires_at > now);
        if !leases.contains_key(&lease.lease_id) && leases.len() >= MAX_LEASES {
            return Err("online lease 数量超过上限".into());
        }
        leases.insert(lease.lease_id.clone(), lease);
        Ok(())
    }

    pub fn begin_challenge(
        &self,
        daemon_id: &str,
        origin: &str,
    ) -> Result<LocalChallenge, AuthFailure> {
        self.begin_challenge_at(daemon_id, origin, Instant::now())
    }

    fn begin_challenge_at(
        &self,
        daemon_id: &str,
        origin: &str,
        now: Instant,
    ) -> Result<LocalChallenge, AuthFailure> {
        if !self.limiter.lock().unwrap().allowed(origin, now) {
            return Err(AuthFailure::new(
                LocalAuthErrorCode::RateLimited,
                "本地认证尝试过多",
            ));
        }
        if !valid_identifier(daemon_id) || !self.state.lock().unwrap().origins.contains(origin) {
            self.limiter.lock().unwrap().failed(origin, now);
            return Err(AuthFailure::new(
                LocalAuthErrorCode::OriginDenied,
                "Origin 不在 allowlist",
            ));
        }
        let mut nonce = vec![0u8; 32];
        OsRng.fill_bytes(&mut nonce);
        let public_key = self.gateway_public_key();
        let transcript = gateway_transcript(DEVICE_PROTOCOL_VERSION, daemon_id, origin, &nonce);
        let signature: Signature = self.signing_key.sign(&transcript);
        Ok(LocalChallenge {
            hello: LocalGatewayHello {
                protocol_version: DEVICE_PROTOCOL_VERSION,
                daemon_id: daemon_id.to_string(),
                origin: origin.to_string(),
                nonce,
                gateway_public_key_sec1: public_key,
                signature_p1363: signature.to_bytes().to_vec(),
            },
            issued_at: now,
            used: false,
        })
    }

    pub fn authenticate(
        &self,
        challenge: &mut LocalChallenge,
        hello: &LocalClientHello,
    ) -> Result<AuthenticatedLocal, AuthFailure> {
        self.authenticate_at(challenge, hello, Instant::now(), epoch_ms())
    }

    fn authenticate_at(
        &self,
        challenge: &mut LocalChallenge,
        hello: &LocalClientHello,
        now: Instant,
        now_ms: f64,
    ) -> Result<AuthenticatedLocal, AuthFailure> {
        let origin = challenge.hello.origin.clone();
        let result = self.authenticate_inner(challenge, hello, now, now_ms);
        let mut limiter = self.limiter.lock().unwrap();
        match &result {
            Ok(_) => limiter.succeeded(&origin),
            Err(error) if error.code != LocalAuthErrorCode::RateLimited => {
                limiter.failed(&origin, now)
            }
            Err(_) => {}
        }
        result
    }

    fn authenticate_inner(
        &self,
        challenge: &mut LocalChallenge,
        hello: &LocalClientHello,
        now: Instant,
        now_ms: f64,
    ) -> Result<AuthenticatedLocal, AuthFailure> {
        if !self
            .limiter
            .lock()
            .unwrap()
            .allowed(&challenge.hello.origin, now)
        {
            return Err(AuthFailure::new(
                LocalAuthErrorCode::RateLimited,
                "本地认证尝试过多",
            ));
        }
        if challenge.used
            || now.saturating_duration_since(challenge.issued_at) > self.challenge_ttl
            || hello.gateway_nonce != challenge.hello.nonce
        {
            challenge.used = true;
            return Err(AuthFailure::new(
                LocalAuthErrorCode::NonceInvalid,
                "gateway nonce 无效或已使用",
            ));
        }
        // nonce 无论成功失败都只能尝试一次，避免同一 challenge 被离线枚举签名。
        challenge.used = true;
        if hello.protocol_version != DEVICE_PROTOCOL_VERSION {
            return Err(AuthFailure::new(
                LocalAuthErrorCode::VersionMismatch,
                "Device protocol version 不兼容",
            ));
        }
        if !valid_identifier(&hello.grant_id)
            || !valid_identifier(&hello.client_instance_id)
            || hello
                .lease_id
                .as_deref()
                .is_some_and(|lease_id| !valid_identifier(lease_id))
            || hello.transport_generation == 0
        {
            return Err(AuthFailure::new(
                LocalAuthErrorCode::SignatureInvalid,
                "client identity/generation 无效",
            ));
        }

        let state = self.state.lock().unwrap();
        let Some(grant) = state.grants.get(&hello.grant_id) else {
            return Err(AuthFailure::new(
                LocalAuthErrorCode::GrantUnknown,
                "browser grant 不存在",
            ));
        };
        if grant.daemon_id != challenge.hello.daemon_id || grant.origin != challenge.hello.origin {
            return Err(AuthFailure::new(
                LocalAuthErrorCode::GrantUnknown,
                "browser grant 与 daemon/origin 不匹配",
            ));
        }
        if grant.public_key_sec1 != hello.browser_public_key_sec1 {
            return Err(AuthFailure::new(
                LocalAuthErrorCode::KeyMismatch,
                "browser public key 与 grant 不匹配",
            ));
        }
        let verifying_key = parse_public_key(&hello.browser_public_key_sec1).map_err(|_| {
            AuthFailure::new(
                LocalAuthErrorCode::KeyMismatch,
                "browser public key 格式无效",
            )
        })?;
        let signature = Signature::from_slice(&hello.signature_p1363).map_err(|_| {
            AuthFailure::new(
                LocalAuthErrorCode::SignatureInvalid,
                "client signature 格式无效",
            )
        })?;
        let transcript = client_transcript(
            hello.protocol_version,
            &challenge.hello.daemon_id,
            &challenge.hello.origin,
            &challenge.hello.nonce,
            &challenge.hello.gateway_public_key_sec1,
            &hello.grant_id,
            &hello.browser_public_key_sec1,
            &hello.client_instance_id,
            hello.transport_generation,
            hello.lease_id.as_deref(),
        );
        verifying_key.verify(&transcript, &signature).map_err(|_| {
            AuthFailure::new(
                LocalAuthErrorCode::SignatureInvalid,
                "client signature 验证失败",
            )
        })?;

        let mut scopes = grant.offline_scopes.clone();
        if let Some(lease_id) = hello.lease_id.as_deref() {
            if !self.server_online.load(Ordering::Acquire) {
                return Err(AuthFailure::new(
                    LocalAuthErrorCode::LeaseInvalid,
                    "中心离线，elevated lease 已失效",
                ));
            }
            let leases = self.leases.lock().unwrap();
            let Some(lease) = leases.get(lease_id) else {
                return Err(AuthFailure::new(
                    LocalAuthErrorCode::LeaseInvalid,
                    "online lease 不存在",
                ));
            };
            if lease.grant_id != grant.grant_id
                || lease.account_id != grant.account_id
                || lease.daemon_id != grant.daemon_id
                || !lease.expires_at.is_finite()
                || lease.expires_at <= now_ms
            {
                return Err(AuthFailure::new(
                    LocalAuthErrorCode::LeaseInvalid,
                    "online lease 已过期或绑定不匹配",
                ));
            }
            scopes.extend_from_slice(&lease.scopes);
        }
        scopes.sort_unstable();
        scopes.dedup();
        Ok(AuthenticatedLocal {
            principal: LocalPrincipal {
                grant_id: grant.grant_id.clone(),
                account_id: grant.account_id.clone(),
                daemon_id: grant.daemon_id.clone(),
                origin: grant.origin.clone(),
                browser_public_key_sec1: grant.public_key_sec1.clone(),
                client_instance_id: hello.client_instance_id.clone(),
                transport_generation: hello.transport_generation,
                lease_id: hello.lease_id.clone(),
            },
            scopes,
        })
    }

    /// 已建立 direct channel 每次请求都重新取有效 scope：grant revoke 与中心断线会立即降权，
    /// 不依赖 WebSocket 重连。
    pub fn effective_scopes(&self, principal: &LocalPrincipal) -> Vec<i32> {
        let state = self.state.lock().unwrap();
        let Some(grant) = state.grants.get(&principal.grant_id) else {
            return Vec::new();
        };
        if grant.account_id != principal.account_id
            || grant.daemon_id != principal.daemon_id
            || grant.origin != principal.origin
            || grant.public_key_sec1 != principal.browser_public_key_sec1
        {
            return Vec::new();
        }
        let mut scopes = grant.offline_scopes.clone();
        if self.server_online.load(Ordering::Acquire) {
            if let Some(lease_id) = principal.lease_id.as_deref() {
                if let Some(lease) = self.leases.lock().unwrap().get(lease_id) {
                    if lease.grant_id == grant.grant_id
                        && lease.account_id == grant.account_id
                        && lease.daemon_id == grant.daemon_id
                        && lease.expires_at.is_finite()
                        && lease.expires_at > epoch_ms()
                    {
                        scopes.extend_from_slice(&lease.scopes);
                    }
                }
            }
        }
        scopes.sort_unstable();
        scopes.dedup();
        scopes
    }

    fn update_state(&self, update: impl FnOnce(&mut LocalState)) -> Result<(), String> {
        let mut current = self.state.lock().unwrap();
        let mut next = current.clone();
        update(&mut next);
        write_store_atomic(&self.path, &self.signing_key, &next)
            .map_err(|error| format!("写 local gateway store: {error}"))?;
        *current = next;
        Ok(())
    }
}

fn validate_grant(
    grant: &LocalBrowserGrant,
    expected_daemon_id: Option<&str>,
) -> Result<(), String> {
    if !valid_identifier(&grant.grant_id)
        || !valid_identifier(&grant.account_id)
        || !valid_identifier(&grant.daemon_id)
    {
        return Err("grant identity 字段不能为空".into());
    }
    if expected_daemon_id.is_some_and(|expected| expected != grant.daemon_id) {
        return Err("grant daemonId 与本机不匹配".into());
    }
    if !valid_origin(&grant.origin) {
        return Err("grant Origin 无效".into());
    }
    parse_public_key(&grant.public_key_sec1)
        .map_err(|_| "grant public key 必须是 P-256 uncompressed SEC1".to_string())?;
    if !grant.created_at.is_finite() {
        return Err("grant createdAt 无效".into());
    }
    if grant.offline_scopes.is_empty()
        || grant.offline_scopes.len() > 2
        || grant.offline_scopes.iter().any(|scope| {
            !matches!(
                DeviceScope::try_from(*scope),
                Ok(DeviceScope::SessionRead | DeviceScope::SessionControl)
            )
        })
    {
        return Err("offline grant 只能包含 session read/control scope".into());
    }
    Ok(())
}

fn validate_lease(
    lease: &OnlineDeviceLease,
    daemon_id: &str,
    grants: &BTreeMap<String, LocalBrowserGrant>,
    now_ms: f64,
) -> Result<(), String> {
    if !valid_identifier(&lease.lease_id)
        || !valid_identifier(&lease.grant_id)
        || !valid_identifier(&lease.account_id)
        || !valid_identifier(&lease.daemon_id)
        || lease.daemon_id != daemon_id
    {
        return Err("lease identity/binding 无效".into());
    }
    let Some(grant) = grants.get(&lease.grant_id) else {
        return Err("lease 对应 grant 不存在".into());
    };
    if lease.account_id != grant.account_id || lease.daemon_id != grant.daemon_id {
        return Err("lease 与 grant 绑定不匹配".into());
    }
    if !lease.expires_at.is_finite() || lease.expires_at <= now_ms {
        return Err("lease 已过期".into());
    }
    if lease.scopes.is_empty()
        || lease.scopes.len() > 4
        || lease.scopes.iter().any(|scope| {
            !matches!(
                DeviceScope::try_from(*scope),
                Ok(DeviceScope::SessionRead
                    | DeviceScope::SessionControl
                    | DeviceScope::Rpc
                    | DeviceScope::Lifecycle)
            )
        })
    {
        return Err("lease scope 无效".into());
    }
    Ok(())
}

fn valid_origin(origin: &str) -> bool {
    if origin.len() > MAX_ORIGIN_BYTES {
        return false;
    }
    let rest = origin
        .strip_prefix("https://")
        .or_else(|| origin.strip_prefix("http://"));
    rest.is_some_and(|authority| {
        !authority.is_empty()
            && !authority
                .bytes()
                .any(|byte| byte.is_ascii_whitespace() || matches!(byte, b'/' | b'?' | b'#' | b'@'))
    })
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_BYTES
        && !value
            .bytes()
            .any(|byte| byte == 0 || byte.is_ascii_control())
}

fn parse_public_key(bytes: &[u8]) -> Result<VerifyingKey, p256::ecdsa::Error> {
    if bytes.len() != 65 || bytes.first() != Some(&4) {
        return Err(p256::ecdsa::Error::new());
    }
    VerifyingKey::from_sec1_bytes(bytes)
}

pub(crate) fn gateway_transcript(
    protocol_version: u32,
    daemon_id: &str,
    origin: &str,
    nonce: &[u8],
) -> Vec<u8> {
    transcript(
        GATEWAY_DOMAIN,
        &[
            &protocol_version.to_be_bytes(),
            daemon_id.as_bytes(),
            origin.as_bytes(),
            nonce,
        ],
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn client_transcript(
    protocol_version: u32,
    daemon_id: &str,
    origin: &str,
    nonce: &[u8],
    gateway_public_key: &[u8],
    grant_id: &str,
    browser_public_key: &[u8],
    client_instance_id: &str,
    transport_generation: u64,
    lease_id: Option<&str>,
) -> Vec<u8> {
    transcript(
        CLIENT_DOMAIN,
        &[
            &protocol_version.to_be_bytes(),
            daemon_id.as_bytes(),
            origin.as_bytes(),
            nonce,
            gateway_public_key,
            grant_id.as_bytes(),
            browser_public_key,
            client_instance_id.as_bytes(),
            &transport_generation.to_be_bytes(),
            lease_id.unwrap_or_default().as_bytes(),
        ],
    )
}

fn transcript(domain: &[u8], fields: &[&[u8]]) -> Vec<u8> {
    let capacity = domain.len()
        + 1
        + fields
            .iter()
            .map(|field| 4usize.saturating_add(field.len()))
            .sum::<usize>();
    let mut output = Vec::with_capacity(capacity);
    output.extend_from_slice(domain);
    output.push(0);
    for field in fields {
        let length = u32::try_from(field.len()).expect("local auth transcript field 超过 u32");
        output.extend_from_slice(&length.to_be_bytes());
        output.extend_from_slice(field);
    }
    output
}

fn encode_store(signing_key: &SigningKey, state: &LocalState) -> Result<Vec<u8>, std::io::Error> {
    let store = PersistedStore {
        version: STORE_VERSION,
        private_key: BASE64.encode(signing_key.to_bytes()),
        origins: state.origins.iter().cloned().collect(),
        grants: state
            .grants
            .values()
            .map(PersistedGrant::from_wire)
            .collect(),
    };
    serde_json::to_vec_pretty(&store).map_err(std::io::Error::other)
}

fn decode_store(bytes: &[u8]) -> Result<(SigningKey, LocalState), String> {
    let persisted: PersistedStore = serde_json::from_slice(bytes)
        .map_err(|error| format!("解析 local gateway store: {error}"))?;
    if persisted.version != STORE_VERSION {
        return Err(format!(
            "local gateway store version {} 不受支持",
            persisted.version
        ));
    }
    let private_key = BASE64
        .decode(persisted.private_key)
        .map_err(|_| "local gateway private key base64 无效".to_string())?;
    let signing_key = SigningKey::from_slice(&private_key)
        .map_err(|_| "local gateway private key 无效".to_string())?;
    let mut state = LocalState::default();
    if persisted.origins.len() > MAX_ORIGINS || persisted.grants.len() > MAX_GRANTS {
        return Err("local gateway store 超过数量上限".into());
    }
    for origin in persisted.origins {
        if !valid_origin(&origin) {
            return Err("local gateway store 含无效 Origin".into());
        }
        state.origins.insert(origin);
    }
    for persisted_grant in persisted.grants {
        let mut grant = persisted_grant.into_wire()?;
        validate_grant(&grant, None)?;
        grant.offline_scopes.sort_unstable();
        grant.offline_scopes.dedup();
        state.grants.insert(grant.grant_id.clone(), grant);
    }
    Ok((signing_key, state))
}

fn create_initial_store(
    path: &Path,
    signing_key: &SigningKey,
    state: &LocalState,
) -> Result<(), std::io::Error> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let bytes = encode_store(signing_key, state)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    secure_permissions_io(path)
}

fn write_store_atomic(
    path: &Path,
    signing_key: &SigningKey,
    state: &LocalState,
) -> Result<(), std::io::Error> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("local gateway store 缺少 parent"))?;
    fs::create_dir_all(parent)?;
    let bytes = encode_store(signing_key, state)?;
    let mut suffix = [0u8; 8];
    OsRng.fill_bytes(&mut suffix);
    let temp = parent.join(format!(
        ".{STORE_FILE}.tmp-{}-{}",
        std::process::id(),
        hex::encode(suffix)
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temp, path)?;
        secure_permissions_io(path)?;
        if let Ok(directory) = OpenOptions::new().read(true).open(parent) {
            let _ = directory.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn secure_permissions(path: &Path) -> Result<(), String> {
    secure_permissions_io(path)
        .map_err(|error| format!("设置 local gateway store mode 0600: {error}"))
}

fn secure_permissions_io(path: &Path) -> Result<(), std::io::Error> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

fn epoch_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |duration| duration.as_secs_f64() * 1000.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        let mut random = [0u8; 8];
        OsRng.fill_bytes(&mut random);
        let directory = std::env::temp_dir().join(format!(
            "coflux-{name}-{}-{}",
            std::process::id(),
            hex::encode(random)
        ));
        fs::create_dir_all(&directory).unwrap();
        directory.join(STORE_FILE)
    }

    fn browser_grant(signing_key: &SigningKey) -> LocalBrowserGrant {
        LocalBrowserGrant {
            grant_id: "grant-1".into(),
            account_id: "account-1".into(),
            daemon_id: "daemon-1".into(),
            origin: "https://p.coflux.dev".into(),
            public_key_sec1: signing_key
                .verifying_key()
                .to_encoded_point(false)
                .as_bytes()
                .to_vec(),
            offline_scopes: vec![
                DeviceScope::SessionControl as i32,
                DeviceScope::SessionRead as i32,
            ],
            created_at: 1.0,
        }
    }

    fn signed_client_hello(
        auth: &LocalAuth,
        challenge: &LocalChallenge,
        browser_key: &SigningKey,
        lease_id: Option<String>,
    ) -> LocalClientHello {
        let browser_public_key = browser_key
            .verifying_key()
            .to_encoded_point(false)
            .as_bytes()
            .to_vec();
        let mut hello = LocalClientHello {
            protocol_version: DEVICE_PROTOCOL_VERSION,
            grant_id: "grant-1".into(),
            browser_public_key_sec1: browser_public_key,
            client_instance_id: "client-1".into(),
            transport_generation: 1,
            lease_id,
            gateway_nonce: challenge.hello.nonce.clone(),
            signature_p1363: Vec::new(),
        };
        let transcript = client_transcript(
            hello.protocol_version,
            &challenge.hello.daemon_id,
            &challenge.hello.origin,
            &challenge.hello.nonce,
            &auth.gateway_public_key(),
            &hello.grant_id,
            &hello.browser_public_key_sec1,
            &hello.client_instance_id,
            hello.transport_generation,
            hello.lease_id.as_deref(),
        );
        let signature: Signature = browser_key.sign(&transcript);
        hello.signature_p1363 = signature.to_bytes().to_vec();
        hello
    }

    fn auth_fixture(name: &str, failure_limit: usize) -> (PathBuf, LocalAuth, SigningKey) {
        let path = temp_path(name);
        let auth = LocalAuth::load_or_create_path(
            path.clone(),
            Duration::from_secs(10),
            failure_limit,
            Duration::from_secs(60),
        )
        .unwrap();
        auth.configure_origins(vec!["https://p.coflux.dev".into()])
            .unwrap();
        let browser_key = SigningKey::random(&mut OsRng);
        auth.install_grant(browser_grant(&browser_key), "daemon-1")
            .unwrap();
        (path, auth, browser_key)
    }

    #[test]
    fn local_auth_identity_grants_and_origins_survive_restart_with_mode_0600() {
        let (path, auth, browser_key) = auth_fixture("local-auth-persist", 8);
        let public_key = auth.gateway_public_key();
        drop(auth);

        let loaded = LocalAuth::load_or_create_path(
            path.clone(),
            Duration::from_secs(10),
            8,
            Duration::from_secs(60),
        )
        .unwrap();
        assert_eq!(loaded.gateway_public_key(), public_key);
        let mut challenge = loaded
            .begin_challenge("daemon-1", "https://p.coflux.dev")
            .unwrap();
        let hello = signed_client_hello(&loaded, &challenge, &browser_key, None);
        assert!(loaded.authenticate(&mut challenge, &hello).is_ok());
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn local_auth_transcript_rejects_tamper_wrong_origin_key_and_replay() {
        let (path, auth, browser_key) = auth_fixture("local-auth-negative", 20);
        assert_eq!(
            auth.begin_challenge("daemon-1", "https://evil.example")
                .unwrap_err()
                .code,
            LocalAuthErrorCode::OriginDenied
        );

        let mut challenge = auth
            .begin_challenge("daemon-1", "https://p.coflux.dev")
            .unwrap();
        let hello = signed_client_hello(&auth, &challenge, &browser_key, None);
        let authenticated = auth.authenticate(&mut challenge, &hello).unwrap();
        assert_eq!(
            authenticated.scopes,
            vec![
                DeviceScope::SessionRead as i32,
                DeviceScope::SessionControl as i32
            ]
        );
        assert_eq!(
            auth.authenticate(&mut challenge, &hello).unwrap_err().code,
            LocalAuthErrorCode::NonceInvalid
        );

        let mut tampered_challenge = auth
            .begin_challenge("daemon-1", "https://p.coflux.dev")
            .unwrap();
        let mut tampered = signed_client_hello(&auth, &tampered_challenge, &browser_key, None);
        tampered.client_instance_id = "tampered".into();
        assert_eq!(
            auth.authenticate(&mut tampered_challenge, &tampered)
                .unwrap_err()
                .code,
            LocalAuthErrorCode::SignatureInvalid
        );

        let mut wrong_key_challenge = auth
            .begin_challenge("daemon-1", "https://p.coflux.dev")
            .unwrap();
        let wrong_key = SigningKey::random(&mut OsRng);
        let wrong = signed_client_hello(&auth, &wrong_key_challenge, &wrong_key, None);
        assert_eq!(
            auth.authenticate(&mut wrong_key_challenge, &wrong)
                .unwrap_err()
                .code,
            LocalAuthErrorCode::KeyMismatch
        );
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn local_auth_online_lease_is_ephemeral_and_existing_principal_downgrades() {
        let (path, auth, browser_key) = auth_fixture("local-auth-lease", 8);
        auth.set_server_online(true);
        auth.install_lease(
            OnlineDeviceLease {
                lease_id: "lease-1".into(),
                grant_id: "grant-1".into(),
                account_id: "account-1".into(),
                daemon_id: "daemon-1".into(),
                scopes: vec![DeviceScope::Rpc as i32, DeviceScope::Lifecycle as i32],
                expires_at: epoch_ms() + 60_000.0,
            },
            "daemon-1",
        )
        .unwrap();
        let mut challenge = auth
            .begin_challenge("daemon-1", "https://p.coflux.dev")
            .unwrap();
        let hello = signed_client_hello(&auth, &challenge, &browser_key, Some("lease-1".into()));
        let authenticated = auth.authenticate(&mut challenge, &hello).unwrap();
        assert_eq!(authenticated.scopes.len(), 4);
        assert_eq!(auth.effective_scopes(&authenticated.principal).len(), 4);

        auth.set_server_online(false);
        assert_eq!(
            auth.effective_scopes(&authenticated.principal),
            vec![
                DeviceScope::SessionRead as i32,
                DeviceScope::SessionControl as i32
            ]
        );
        let mut offline_challenge = auth
            .begin_challenge("daemon-1", "https://p.coflux.dev")
            .unwrap();
        let offline_hello = signed_client_hello(
            &auth,
            &offline_challenge,
            &browser_key,
            Some("lease-1".into()),
        );
        assert_eq!(
            auth.authenticate(&mut offline_challenge, &offline_hello)
                .unwrap_err()
                .code,
            LocalAuthErrorCode::LeaseInvalid
        );
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn local_auth_nonce_expiry_and_failure_rate_limit_are_enforced() {
        let (path, auth, browser_key) = auth_fixture("local-auth-rate", 2);
        let now = Instant::now();
        let mut expired = auth
            .begin_challenge_at(
                "daemon-1",
                "https://p.coflux.dev",
                now - Duration::from_secs(20),
            )
            .unwrap();
        let expired_hello = signed_client_hello(&auth, &expired, &browser_key, None);
        assert_eq!(
            auth.authenticate_at(&mut expired, &expired_hello, now, epoch_ms())
                .unwrap_err()
                .code,
            LocalAuthErrorCode::NonceInvalid
        );

        let mut bad = auth
            .begin_challenge("daemon-1", "https://p.coflux.dev")
            .unwrap();
        let mut bad_hello = signed_client_hello(&auth, &bad, &browser_key, None);
        bad_hello.signature_p1363[0] ^= 0xff;
        assert_eq!(
            auth.authenticate(&mut bad, &bad_hello).unwrap_err().code,
            LocalAuthErrorCode::SignatureInvalid
        );
        assert_eq!(
            auth.begin_challenge("daemon-1", "https://p.coflux.dev")
                .unwrap_err()
                .code,
            LocalAuthErrorCode::RateLimited
        );
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
