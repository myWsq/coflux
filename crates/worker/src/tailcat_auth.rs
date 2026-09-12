//! Single-use central grants, bound to a fresh transport-stream challenge.

use coflux_protocol::{wire::DeviceTailcatGrant, DEVICE_PROTOCOL_VERSION};
use hmac::{Hmac, Mac};
use rand_core::{OsRng, RngCore};
use sha2::Sha256;
use std::collections::{HashMap, HashSet};

const MAX_GRANTS: usize = 256;
const MAX_TTL_MS: u64 = 30_000;
const DOMAIN: &[u8] = b"coflux-tailcat-channel-v1\0";

pub struct Grants {
    account: String,
    device: String,
    pending: HashMap<String, DeviceTailcatGrant>,
    generations: HashMap<(String, bool), u64>,
    used: HashSet<String>,
}

impl Grants {
    pub fn new(account: String, device: String) -> Self {
        Self {
            account,
            device,
            pending: HashMap::new(),
            generations: HashMap::new(),
            used: HashSet::new(),
        }
    }

    pub fn install(&mut self, grant: DeviceTailcatGrant, now: u64) -> Result<(), &'static str> {
        self.pending.retain(|_, value| value.expires_at > now);
        let valid_id =
            |id: &str| !id.is_empty() && id.len() <= 255 && !id.chars().any(char::is_control);
        if grant.protocol_version != DEVICE_PROTOCOL_VERSION
            || grant.account_id != self.account
            || grant.daemon_id != self.device
            || !valid_id(&grant.channel_id)
            || grant.channel_id.starts_with("__coflux-")
            || !valid_id(&grant.client_instance_id)
            || grant.transport_generation == 0
            || grant.proof_key.len() != 32
            || grant.expires_at <= now
            || grant.expires_at - now > MAX_TTL_MS
            || grant.scopes.is_empty()
            || grant.scopes.len() > 4
            || grant.scopes.iter().any(|s| !(1..=4).contains(s))
            || (grant.scopes.iter().any(|s| *s <= 2) && grant.scopes.iter().any(|s| *s >= 3))
        {
            return Err("invalid channel grant");
        }
        if self.pending.len() >= MAX_GRANTS
            || self.used.contains(&grant.channel_id)
            || self.used.len() >= 4096
        {
            return Err("channel grant limit or duplicate");
        }
        let identity = (
            grant.client_instance_id.clone(),
            grant.scopes.iter().any(|s| *s >= 3),
        );
        let previous = self.generations.get(&identity).copied().unwrap_or(0);
        if grant.transport_generation < previous {
            return Err("stale transport generation");
        }
        if !self.generations.contains_key(&identity) && self.generations.len() >= MAX_GRANTS {
            return Err("client identity limit");
        }
        self.generations
            .insert(identity, grant.transport_generation);
        self.used.insert(grant.channel_id.clone());
        self.pending.insert(grant.channel_id.clone(), grant);
        Ok(())
    }

    pub fn consume(
        &mut self,
        channel: &str,
        nonce: &[u8; 32],
        proof: &[u8],
        now: u64,
    ) -> Result<DeviceTailcatGrant, &'static str> {
        // Remove before verification: one failed proof consumes this grant too.
        let grant = self
            .pending
            .remove(channel)
            .ok_or("unknown or consumed channel grant")?;
        if grant.expires_at <= now
            || self
                .generations
                .get(&(
                    grant.client_instance_id.clone(),
                    grant.scopes.iter().any(|s| *s >= 3),
                ))
                .copied()
                != Some(grant.transport_generation)
        {
            return Err("expired or stale channel grant");
        }
        let mut mac =
            Hmac::<Sha256>::new_from_slice(&grant.proof_key).map_err(|_| "invalid proof key")?;
        mac.update(&transcript(channel, nonce));
        mac.verify_slice(proof)
            .map_err(|_| "channel proof rejected")?;
        Ok(grant)
    }

    pub fn needs_rotation(&self) -> bool {
        self.used.len() >= 4096 || self.generations.len() >= MAX_GRANTS
    }

    pub fn pending(&self, channel: &str, now: u64) -> bool {
        self.pending
            .get(channel)
            .is_some_and(|grant| grant.expires_at > now)
    }

    pub fn revoke(&mut self, channel: &str) {
        self.pending.remove(channel);
    }
}

pub fn challenge() -> [u8; 32] {
    let mut nonce = [0; 32];
    OsRng.fill_bytes(&mut nonce);
    nonce
}
pub fn transcript(channel: &str, nonce: &[u8; 32]) -> Vec<u8> {
    let mut out = DOMAIN.to_vec();
    out.extend_from_slice(&(channel.len() as u32).to_be_bytes());
    out.extend_from_slice(channel.as_bytes());
    out.extend_from_slice(nonce);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    fn grant() -> DeviceTailcatGrant {
        DeviceTailcatGrant {
            channel_id: "channel".into(),
            account_id: "account".into(),
            daemon_id: "device".into(),
            client_instance_id: "client".into(),
            transport_generation: 1,
            scopes: vec![1, 2],
            expires_at: 2000,
            proof_key: vec![9; 32],
            node_public_key: String::new(),
            protocol_version: DEVICE_PROTOCOL_VERSION,
        }
    }
    fn proof(grant: &DeviceTailcatGrant, nonce: &[u8; 32]) -> Vec<u8> {
        let mut mac = Hmac::<Sha256>::new_from_slice(&grant.proof_key).unwrap();
        mac.update(&transcript(&grant.channel_id, nonce));
        mac.finalize().into_bytes().to_vec()
    }
    fn store() -> Grants {
        Grants::new("account".into(), "device".into())
    }
    #[test]
    fn session_and_elevated_generations_are_independent() {
        let mut s = store();
        let session = grant();
        let mut elevated = grant();
        elevated.channel_id = "elevated".into();
        elevated.scopes = vec![3, 4];
        elevated.transport_generation = 5;
        s.install(session.clone(), 1000).unwrap();
        s.install(elevated.clone(), 1000).unwrap();
        let nonce = [1; 32];
        assert!(s
            .consume("channel", &nonce, &proof(&session, &nonce), 1100)
            .is_ok());
        assert!(s
            .consume("elevated", &nonce, &proof(&elevated, &nonce), 1100)
            .is_ok());
        let mut stale = elevated.clone();
        stale.channel_id = "stale".into();
        stale.transport_generation = 4;
        assert!(s.install(stale, 1100).is_err());
        let mut mixed = grant();
        mixed.channel_id = "mixed".into();
        mixed.scopes = vec![1, 3];
        assert!(s.install(mixed, 1100).is_err());
    }
    #[test]
    fn grant_is_single_use_and_nonce_bound() {
        let g = grant();
        let n = [7; 32];
        let p = proof(&g, &n);
        let mut s = store();
        s.install(g.clone(), 1000).unwrap();
        assert!(s.consume("channel", &n, &p, 1100).is_ok());
        assert!(s.consume("channel", &n, &p, 1100).is_err());
        let mut s = store();
        s.install(g, 1000).unwrap();
        assert!(s.consume("channel", &[8; 32], &p, 1100).is_err());
        assert!(s.consume("channel", &n, &p, 1100).is_err());
    }
    #[test]
    fn rejects_cross_account_device_expiry_and_generation() {
        for mutate in [0, 1, 2, 3] {
            let mut g = grant();
            match mutate {
                0 => g.account_id = "other".into(),
                1 => g.daemon_id = "other".into(),
                2 => g.expires_at = 999,
                _ => g.scopes = vec![99],
            };
            assert!(store().install(g, 1000).is_err());
        }
        let mut s = store();
        let mut g = grant();
        g.transport_generation = 2;
        s.install(g, 1000).unwrap();
        assert!(s.install(grant(), 1000).is_err());
    }
    #[test]
    fn checks_expiry_at_consumption_and_revocation() {
        let g = grant();
        let n = [7; 32];
        let p = proof(&g, &n);
        let mut s = store();
        s.install(g.clone(), 1000).unwrap();
        assert!(s.consume("channel", &n, &p, 2000).is_err());
        let mut s = store();
        s.install(g, 1000).unwrap();
        s.revoke("channel");
        assert!(s.consume("channel", &n, &p, 1100).is_err());
    }
}
