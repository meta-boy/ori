//! Shared helpers for integration tests that talk to a real backend.

use std::path::PathBuf;

pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

/// Load `ORI_*` variables from `.env.local` (repo root) into the environment,
/// unless already set. Absent `.env.local` is fine — the ambient environment is
/// used instead.
pub fn load_env() {
    let path = repo_root().join(".env.local");
    let contents = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return,
    };
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let k = k.trim().trim_start_matches("export ");
        let v = v.trim().trim_matches('"').trim_matches('\'');
        if !k.starts_with("ORI_") {
            continue;
        }
        if std::env::var(k).is_err() {
            // SAFETY: single-threaded test setup; edition 2021.
            unsafe {
                std::env::set_var(k, v);
            }
        }
    }
}

/// Fail with a helpful message if any required env var is missing.
#[allow(dead_code)]
pub fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("missing env {name}"))
}