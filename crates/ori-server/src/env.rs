//! Environments: named bundles of repos, variables, secret files and safety
//! toggles, with **immutable versioning**.
//!
//! The versioning is the whole point. Every mutation mints a new version; a
//! running sandbox stays pinned to the version it started with until
//! `env upgrade` moves it. A minted version is never edited — a mutation
//! copies the latest version's bundle into a fresh row and changes the copy.
//! Editing history is how a sandbox silently changes underneath its own pinned
//! version.
//!
//! Secret handling is the correctness-critical piece:
//!
//! - **Secrets never appear in a log line, at any level.** The values live in
//!   the DB and travel only inside claim frames to the agent. Nothing here logs
//!   them; the routes redact them from every response.
//! - **Secret files land 0600, owned by the sandbox user, never through a
//!   world-readable temp path.** That is the agent's `inject::write_secret_file`
//!   contract; this module just hands over base64 contents and a final path,
//!   never a staged file.
//! - **`--no-env` is one-way.** A sandbox created with it gets an empty claim —
//!   nothing from the account — and the agent's apply treats the claim as
//!   authoritative, so previously-applied secret files are scrubbed.

use std::collections::HashMap;

use base64::Engine as _;
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqlitePool;

use crate::error::{ApiError, ApiResult};
use crate::proto::TypedId;
use crate::repo::{self, SandboxRow};
use crate::state::AppState;
use crate::util::now_ts;

/// The reserved, always-empty environment. Sandboxes with no explicit
/// environment and no account default use it.
pub const BASE_ENV: &str = "base";

/// The account-wide default environment, when one is set. Sandboxes created
/// without `--environment` resolve to it.
pub async fn default_env(db: &SqlitePool, account_id: &str) -> ApiResult<Option<EnvironmentRow>> {
    let row = sqlx::query_as::<_, EnvironmentRow>(
        "SELECT id, account_id, name, is_default, created_at, updated_at FROM environments \
         WHERE account_id = ? AND is_default = 1 LIMIT 1",
    )
    .bind(account_id)
    .fetch_optional(db)
    .await?;
    Ok(row)
}

/// Resolve a requested environment name to `(name, version)` to pin a sandbox
/// to. `None` means "the account default, or `base`".
pub async fn resolve_environment(
    db: &SqlitePool,
    account_id: &str,
    requested: Option<&str>,
) -> ApiResult<(String, i64)> {
    let name = match requested {
        Some(n) => n.to_string(),
        None => match default_env(db, account_id).await? {
            Some(e) => e.name,
            None => BASE_ENV.to_string(),
        },
    };
    if name == BASE_ENV {
        return Ok((BASE_ENV.to_string(), 1));
    }
    let env = get_env(db, account_id, &name)
        .await?
        .ok_or_else(|| ApiError::invalid_request(format!("unknown environment {name:?}")))?;
    let version = latest_version(db, &env.id).await?.unwrap_or(1);
    Ok((env.name, version))
}

// ---------------------------------------------------------------------------
// rows
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct EnvironmentRow {
    pub id: String,
    pub account_id: String,
    pub name: String,
    pub is_default: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct VersionRow {
    pub id: String,
    pub environment_id: String,
    pub version: i64,
    pub toggles: String,
    pub created_at: String,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct VarRow {
    pub key: String,
    pub value: String,
    pub is_secret: bool,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct FileRow {
    pub path: String,
    pub content: String,
    pub is_secret: bool,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct RepoRow {
    pub url: String,
    pub branch: Option<String>,
    pub path: String,
}

// ---------------------------------------------------------------------------
// safety toggles
// ---------------------------------------------------------------------------

/// The safety toggles a version travels with. Serialised as JSON on the
/// version row, so the toggles that minted a version are immutable with it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Toggles {
    /// Inject env vars at all. Off means the bundle's vars are withheld.
    #[serde(default = "default_on")]
    pub inject_vars: bool,
    /// Inject files at all. Off means the bundle's files are withheld.
    #[serde(default = "default_on")]
    pub inject_files: bool,
    /// Inject secret vars and secret files. Off means secrets are withheld
    /// from every claim — the same withholding an upgrade applies to removed
    /// secrets, as a persistent toggle.
    #[serde(default = "default_on")]
    pub inject_secrets: bool,
}

fn default_on() -> bool {
    true
}

impl Default for Toggles {
    fn default() -> Self {
        Toggles {
            inject_vars: true,
            inject_files: true,
            inject_secrets: true,
        }
    }
}

impl Toggles {
    pub fn names() -> &'static [&'static str] {
        &["inject_vars", "inject_files", "inject_secrets"]
    }

    fn set(&mut self, name: &str, on: bool) -> Option<()> {
        match name {
            "inject_vars" => {
                self.inject_vars = on;
                Some(())
            }
            "inject_files" => {
                self.inject_files = on;
                Some(())
            }
            "inject_secrets" => {
                self.inject_secrets = on;
                Some(())
            }
            _ => None,
        }
    }
}

fn parse_toggles(raw: &str) -> Toggles {
    serde_json::from_str(raw).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// bundle content
// ---------------------------------------------------------------------------

/// One version's full bundle: vars, files, repos and toggles. A version is a
/// copy-on-write snapshot of the previous one.
#[derive(Debug, Clone, Default)]
pub struct Bundle {
    pub vars: Vec<VarRow>,
    pub files: Vec<FileRow>,
    pub repos: Vec<RepoRow>,
    pub toggles: Toggles,
}

/// The claim payload handed to the agent over the tunnel. Mirror of the agent's
/// `apply` frame, kept as plain types here so routes never touch base64.
#[derive(Debug, Clone, Default)]
pub struct ClaimSpec {
    pub env: HashMap<String, String>,
    pub secret_files: Vec<SecretFileSpec>,
    pub repos: Vec<RepoSpec>,
}

#[derive(Debug, Clone)]
pub struct SecretFileSpec {
    pub path: String,
    pub contents_b64: String,
}

#[derive(Debug, Clone)]
pub struct RepoSpec {
    pub url: String,
    pub branch: Option<String>,
    pub path: String,
}

/// Everything that can mutate a bundle. `set` and the var/file/repo commands
/// all mint a new version; `rename`/`default`/`rm` do not.
#[derive(Debug, Clone)]
pub struct Mutation {
    pub kind: &'static str,
    pub detail: String,
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

fn validate_env_name(name: &str) -> ApiResult<()> {
    if name.is_empty()
        || name == BASE_ENV
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(ApiError::invalid_request(format!(
            "invalid environment name {name:?}; use letters, digits, `-`, `_` or `.` (not `{BASE_ENV}`)"
        )));
    }
    Ok(())
}

fn validate_var_key(key: &str) -> ApiResult<()> {
    if key.is_empty()
        || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        || key
            .chars()
            .next()
            .map(|c| c.is_ascii_digit())
            .unwrap_or(true)
    {
        return Err(ApiError::invalid_request(format!(
            "invalid variable key {key:?}; use a POSIX environment-variable name"
        )));
    }
    Ok(())
}

pub async fn list_envs(db: &SqlitePool, account_id: &str) -> ApiResult<Vec<EnvironmentRow>> {
    let rows = sqlx::query_as::<_, EnvironmentRow>(
        "SELECT id, account_id, name, is_default, created_at, updated_at FROM environments \
         WHERE account_id = ? ORDER BY created_at ASC",
    )
    .bind(account_id)
    .fetch_all(db)
    .await?;
    Ok(rows)
}

pub async fn get_env(
    db: &SqlitePool,
    account_id: &str,
    name: &str,
) -> ApiResult<Option<EnvironmentRow>> {
    let row = sqlx::query_as::<_, EnvironmentRow>(
        "SELECT id, account_id, name, is_default, created_at, updated_at FROM environments \
         WHERE account_id = ? AND name = ?",
    )
    .bind(account_id)
    .bind(name)
    .fetch_optional(db)
    .await?;
    Ok(row)
}

pub async fn create_env(
    db: &SqlitePool,
    account_id: &str,
    name: &str,
) -> ApiResult<EnvironmentRow> {
    validate_env_name(name)?;
    if get_env(db, account_id, name).await?.is_some() {
        return Err(ApiError::conflict(format!(
            "environment {name:?} already exists"
        )));
    }
    let now = now_ts();
    let id = TypedId::env().to_string();
    sqlx::query(
        "INSERT INTO environments (id, account_id, name, is_default, created_at, updated_at) \
         VALUES (?, ?, ?, 0, ?, ?)",
    )
    .bind(&id)
    .bind(account_id)
    .bind(name)
    .bind(&now)
    .bind(&now)
    .execute(db)
    .await?;
    mint_version(db, &id, 1, &Toggles::default()).await?;
    Ok(EnvironmentRow {
        id,
        account_id: account_id.to_string(),
        name: name.to_string(),
        is_default: false,
        created_at: now.clone(),
        updated_at: now,
    })
}

pub async fn rename_env(
    db: &SqlitePool,
    account_id: &str,
    old: &str,
    new: &str,
) -> ApiResult<EnvironmentRow> {
    validate_env_name(new)?;
    if old == new {
        return get_env(db, account_id, old)
            .await?
            .ok_or_else(|| ApiError::not_found(format!("environment {old:?}")));
    }
    if get_env(db, account_id, new).await?.is_some() {
        return Err(ApiError::conflict(format!(
            "environment {new:?} already exists"
        )));
    }
    let env = get_env(db, account_id, old)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("environment {old:?}")))?;
    sqlx::query("UPDATE environments SET name = ?, updated_at = ? WHERE id = ?")
        .bind(new)
        .bind(now_ts())
        .bind(&env.id)
        .execute(db)
        .await?;
    Ok(EnvironmentRow {
        id: env.id,
        account_id: account_id.to_string(),
        name: new.to_string(),
        is_default: env.is_default,
        created_at: env.created_at,
        updated_at: now_ts(),
    })
}

pub async fn set_default(
    db: &SqlitePool,
    account_id: &str,
    name: &str,
) -> ApiResult<EnvironmentRow> {
    let env = get_env(db, account_id, name)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("environment {name:?}")))?;
    // one default per account: clear the previous, set this one
    sqlx::query("UPDATE environments SET is_default = 0 WHERE account_id = ?")
        .bind(account_id)
        .execute(db)
        .await?;
    sqlx::query("UPDATE environments SET is_default = 1, updated_at = ? WHERE id = ?")
        .bind(now_ts())
        .bind(&env.id)
        .execute(db)
        .await?;
    let mut row = env;
    row.is_default = true;
    row.updated_at = now_ts();
    Ok(row)
}

pub async fn delete_env(db: &SqlitePool, account_id: &str, name: &str) -> ApiResult<()> {
    let env = get_env(db, account_id, name)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("environment {name:?}")))?;
    let version_ids: Vec<String> =
        sqlx::query_as("SELECT id FROM environment_versions WHERE environment_id = ?")
            .bind(&env.id)
            .fetch_all(db)
            .await?
            .into_iter()
            .map(|(id,): (String,)| id)
            .collect();
    for vid in &version_ids {
        sqlx::query("DELETE FROM environment_vars WHERE version_id = ?")
            .bind(vid)
            .execute(db)
            .await?;
        sqlx::query("DELETE FROM environment_files WHERE version_id = ?")
            .bind(vid)
            .execute(db)
            .await?;
        sqlx::query("DELETE FROM environment_repos WHERE version_id = ?")
            .bind(vid)
            .execute(db)
            .await?;
    }
    sqlx::query("DELETE FROM environment_versions WHERE environment_id = ?")
        .bind(&env.id)
        .execute(db)
        .await?;
    sqlx::query("DELETE FROM environments WHERE id = ?")
        .bind(&env.id)
        .execute(db)
        .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// versioning
// ---------------------------------------------------------------------------

pub async fn latest_version(db: &SqlitePool, environment_id: &str) -> ApiResult<Option<i64>> {
    let row: (Option<i64>,) =
        sqlx::query_as("SELECT MAX(version) FROM environment_versions WHERE environment_id = ?")
            .bind(environment_id)
            .fetch_one(db)
            .await?;
    Ok(row.0)
}

async fn version_row(
    db: &SqlitePool,
    environment_id: &str,
    version: i64,
) -> ApiResult<Option<VersionRow>> {
    let row = sqlx::query_as::<_, VersionRow>(
        "SELECT id, environment_id, version, toggles, created_at FROM environment_versions \
         WHERE environment_id = ? AND version = ?",
    )
    .bind(environment_id)
    .bind(version)
    .fetch_optional(db)
    .await?;
    Ok(row)
}

/// Mint a version: create the version row and copy the previous version's
/// bundle into it. `previous` is `None` for version 1 (an empty bundle).
async fn mint_version(
    db: &SqlitePool,
    environment_id: &str,
    version: i64,
    toggles: &Toggles,
) -> ApiResult<String> {
    let vid = TypedId::env_version().to_string();
    sqlx::query(
        "INSERT INTO environment_versions (id, environment_id, version, toggles, created_at) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&vid)
    .bind(environment_id)
    .bind(version)
    .bind(serde_json::to_string(toggles).unwrap_or_else(|_| "{}".into()))
    .bind(now_ts())
    .execute(db)
    .await?;

    if version > 1 {
        let previous = version_row(db, environment_id, version - 1).await?;
        if let Some(prev) = previous {
            copy_bundle(db, &prev.id, &vid).await?;
        }
    }
    Ok(vid)
}

/// Copy one version's vars/files/repos into another (new ids; the rows are
/// immutable, so a copied row is a distinct row).
async fn copy_bundle(db: &SqlitePool, from: &str, to: &str) -> ApiResult<()> {
    let vars = sqlx::query_as::<_, (String, String, bool)>(
        "SELECT key, value, is_secret FROM environment_vars WHERE version_id = ? ORDER BY key",
    )
    .bind(from)
    .fetch_all(db)
    .await?;
    for (key, value, is_secret) in vars {
        sqlx::query(
            "INSERT INTO environment_vars (id, version_id, key, value, is_secret) \
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(TypedId::env_var().to_string())
        .bind(to)
        .bind(&key)
        .bind(&value)
        .bind(is_secret)
        .execute(db)
        .await?;
    }

    let files = sqlx::query_as::<_, (String, String, bool)>(
        "SELECT path, content, is_secret FROM environment_files WHERE version_id = ? ORDER BY path",
    )
    .bind(from)
    .fetch_all(db)
    .await?;
    for (path, content, is_secret) in files {
        sqlx::query(
            "INSERT INTO environment_files (id, version_id, path, content, is_secret) \
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(TypedId::env_file().to_string())
        .bind(to)
        .bind(&path)
        .bind(&content)
        .bind(is_secret)
        .execute(db)
        .await?;
    }

    let repos = sqlx::query_as::<_, (String, Option<String>, String)>(
        "SELECT url, branch, path FROM environment_repos WHERE version_id = ? ORDER BY url",
    )
    .bind(from)
    .fetch_all(db)
    .await?;
    for (url, branch, path) in repos {
        sqlx::query(
            "INSERT INTO environment_repos (id, version_id, url, branch, path) \
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(TypedId::env_repo().to_string())
        .bind(to)
        .bind(&url)
        .bind(&branch)
        .bind(&path)
        .execute(db)
        .await?;
    }
    Ok(())
}

/// The latest version's bundle, or an empty one when the environment has no
/// versions yet.
pub async fn bundle_for_version(db: &SqlitePool, version_id: &str) -> ApiResult<Bundle> {
    let vars = sqlx::query_as::<_, VarRow>(
        "SELECT key, value, is_secret FROM environment_vars WHERE version_id = ? ORDER BY key",
    )
    .bind(version_id)
    .fetch_all(db)
    .await?;
    let files = sqlx::query_as::<_, FileRow>(
        "SELECT path, content, is_secret FROM environment_files WHERE version_id = ? ORDER BY path",
    )
    .bind(version_id)
    .fetch_all(db)
    .await?;
    let repos = sqlx::query_as::<_, RepoRow>(
        "SELECT url, branch, path FROM environment_repos WHERE version_id = ? ORDER BY url",
    )
    .bind(version_id)
    .fetch_all(db)
    .await?;
    let toggles_raw: Option<(String,)> =
        sqlx::query_as("SELECT toggles FROM environment_versions WHERE id = ?")
            .bind(version_id)
            .fetch_optional(db)
            .await?;
    Ok(Bundle {
        vars,
        files,
        repos,
        toggles: toggles_raw
            .map(|(t,)| parse_toggles(&t))
            .unwrap_or_default(),
    })
}

pub async fn latest_bundle(db: &SqlitePool, environment_id: &str) -> ApiResult<Bundle> {
    match latest_version(db, environment_id).await? {
        Some(v) => {
            let vr = version_row(db, environment_id, v)
                .await?
                .ok_or_else(|| ApiError::internal("latest version row missing"))?;
            bundle_for_version(db, &vr.id).await
        }
        None => Ok(Bundle::default()),
    }
}

// ---------------------------------------------------------------------------
// mutations — every one mints a new version
// ---------------------------------------------------------------------------

/// A mutation applied to the *copy* of the latest version. Returns the new
/// version number. The closure receives the new version's id and applies the
/// mutation to it; it must own everything it captures (the future is `'static`).
async fn mutate<F>(db: &SqlitePool, account_id: &str, name: &str, apply: F) -> ApiResult<i64>
where
    F: FnOnce(String) -> BoxFuture<'static, ApiResult<()>>,
{
    let env = get_env(db, account_id, name)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("environment {name:?}")))?;
    let latest = latest_version(db, &env.id).await?.unwrap_or(0);
    let version = latest + 1;
    let prev_toggles = match version_row(db, &env.id, latest).await? {
        Some(vr) => parse_toggles(&vr.toggles),
        None => Toggles::default(),
    };
    let vid = mint_version(db, &env.id, version, &prev_toggles).await?;
    if let Err(e) = apply(vid.clone()).await {
        // A failed mutation must not leave a half-baked version behind: the
        // version row and its bundle are deleted so the environment stays on
        // its previous immutable version.
        let _ = sqlx::query("DELETE FROM environment_vars WHERE version_id = ?")
            .bind(&vid)
            .execute(db)
            .await;
        let _ = sqlx::query("DELETE FROM environment_files WHERE version_id = ?")
            .bind(&vid)
            .execute(db)
            .await;
        let _ = sqlx::query("DELETE FROM environment_repos WHERE version_id = ?")
            .bind(&vid)
            .execute(db)
            .await;
        let _ = sqlx::query("DELETE FROM environment_versions WHERE id = ?")
            .bind(&vid)
            .execute(db)
            .await;
        return Err(e);
    }
    Ok(version)
}

pub async fn set_var(
    db: &SqlitePool,
    account_id: &str,
    name: &str,
    key: &str,
    value: &str,
    is_secret: bool,
) -> ApiResult<i64> {
    validate_var_key(key)?;
    let key = key.to_string();
    let value = value.to_string();
    let db2 = db.clone();
    mutate(db, account_id, name, move |vid| {
        Box::pin(async move {
            sqlx::query(
                "INSERT INTO environment_vars (id, version_id, key, value, is_secret) \
                 VALUES (?, ?, ?, ?, ?) \
                 ON CONFLICT (version_id, key) DO UPDATE SET value = excluded.value, is_secret = excluded.is_secret",
            )
            .bind(TypedId::env_var().to_string())
            .bind(&vid)
            .bind(&key)
            .bind(&value)
            .bind(is_secret)
            .execute(&db2)
            .await?;
            Ok(())
        })
    })
    .await
}

pub async fn rm_var(db: &SqlitePool, account_id: &str, name: &str, key: &str) -> ApiResult<i64> {
    let key = key.to_string();
    let db2 = db.clone();
    mutate(db, account_id, name, move |vid| {
        Box::pin(async move {
            let res = sqlx::query("DELETE FROM environment_vars WHERE version_id = ? AND key = ?")
                .bind(&vid)
                .bind(&key)
                .execute(&db2)
                .await?;
            if res.rows_affected() == 0 {
                return Err(ApiError::not_found(format!("environment variable {key:?}")));
            }
            Ok(())
        })
    })
    .await
}

pub async fn set_file(
    db: &SqlitePool,
    account_id: &str,
    name: &str,
    path: &str,
    content: &str,
    is_secret: bool,
) -> ApiResult<i64> {
    if path.is_empty() || path.starts_with('/') {
        return Err(ApiError::invalid_request(
            "file path must be a relative path (e.g. `.env` or `.config/creds`)",
        ));
    }
    let path = path.to_string();
    let content = content.to_string();
    let db2 = db.clone();
    mutate(db, account_id, name, move |vid| {
        Box::pin(async move {
            sqlx::query(
                "INSERT INTO environment_files (id, version_id, path, content, is_secret) \
                 VALUES (?, ?, ?, ?, ?) \
                 ON CONFLICT (version_id, path) DO UPDATE SET content = excluded.content, is_secret = excluded.is_secret",
            )
            .bind(TypedId::env_file().to_string())
            .bind(&vid)
            .bind(&path)
            .bind(&content)
            .bind(is_secret)
            .execute(&db2)
            .await?;
            Ok(())
        })
    })
    .await
}

pub async fn rm_file(db: &SqlitePool, account_id: &str, name: &str, path: &str) -> ApiResult<i64> {
    let path = path.to_string();
    let db2 = db.clone();
    mutate(db, account_id, name, move |vid| {
        Box::pin(async move {
            let res =
                sqlx::query("DELETE FROM environment_files WHERE version_id = ? AND path = ?")
                    .bind(&vid)
                    .bind(&path)
                    .execute(&db2)
                    .await?;
            if res.rows_affected() == 0 {
                return Err(ApiError::not_found(format!("file {path:?}")));
            }
            Ok(())
        })
    })
    .await
}

pub async fn add_repo(
    db: &SqlitePool,
    account_id: &str,
    name: &str,
    url: &str,
    branch: Option<&str>,
    path: Option<&str>,
) -> ApiResult<i64> {
    if url.is_empty() {
        return Err(ApiError::invalid_request("repo url must not be empty"));
    }
    let path = path
        .map(str::to_string)
        .unwrap_or_else(|| default_repo_path(url));
    let url = url.to_string();
    let branch = branch.map(str::to_string);
    let db2 = db.clone();
    mutate(db, account_id, name, move |vid| {
        Box::pin(async move {
            sqlx::query(
                "INSERT INTO environment_repos (id, version_id, url, branch, path) \
                 VALUES (?, ?, ?, ?, ?) \
                 ON CONFLICT (version_id, url) DO UPDATE SET branch = excluded.branch, path = excluded.path",
            )
            .bind(TypedId::env_repo().to_string())
            .bind(&vid)
            .bind(&url)
            .bind(&branch)
            .bind(&path)
            .execute(&db2)
            .await?;
            Ok(())
        })
    })
    .await
}

pub async fn rm_repo(db: &SqlitePool, account_id: &str, name: &str, url: &str) -> ApiResult<i64> {
    let url = url.to_string();
    let db2 = db.clone();
    mutate(db, account_id, name, move |vid| {
        Box::pin(async move {
            let res = sqlx::query("DELETE FROM environment_repos WHERE version_id = ? AND url = ?")
                .bind(&vid)
                .bind(&url)
                .execute(&db2)
                .await?;
            if res.rows_affected() == 0 {
                return Err(ApiError::not_found(format!("repo {url:?}")));
            }
            Ok(())
        })
    })
    .await
}

pub async fn set_toggle(
    db: &SqlitePool,
    account_id: &str,
    name: &str,
    toggle: &str,
    on: bool,
) -> ApiResult<i64> {
    let env = get_env(db, account_id, name)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("environment {name:?}")))?;
    let latest = latest_version(db, &env.id).await?.unwrap_or(0);
    let prev_toggles = match version_row(db, &env.id, latest).await? {
        Some(vr) => parse_toggles(&vr.toggles),
        None => Toggles::default(),
    };
    let mut toggles = prev_toggles.clone();
    if toggles.set(toggle, on).is_none() {
        return Err(ApiError::invalid_request(format!(
            "unknown toggle {toggle:?}; expected one of {}",
            Toggles::names().join(", ")
        )));
    }
    let version = latest + 1;
    // mint_version takes the toggles explicitly, so the new version row
    // already carries them; its bundle is a copy of the previous version's.
    mint_version(db, &env.id, version, &toggles).await?;
    Ok(version)
}

// ---------------------------------------------------------------------------
// claim building
// ---------------------------------------------------------------------------

/// Build the claim to hand a sandbox pinned to `(environment, version)`.
/// `no_env` short-circuits to an empty claim — the one-way scrub.
pub async fn build_claim(
    db: &SqlitePool,
    account_id: &str,
    environment: &str,
    version: i64,
    no_env: bool,
) -> ApiResult<ClaimSpec> {
    if no_env || environment == BASE_ENV {
        return Ok(ClaimSpec::default());
    }
    let env = match get_env(db, account_id, environment).await? {
        Some(e) => e,
        // The environment was deleted but sandboxes still reference it: an
        // empty claim, never an error that blocks the sandbox.
        None => return Ok(ClaimSpec::default()),
    };
    let vr = match version_row(db, &env.id, version).await? {
        Some(v) => v,
        // The pinned version was deleted with the environment; see above.
        None => return Ok(ClaimSpec::default()),
    };
    let bundle = bundle_for_version(db, &vr.id).await?;
    Ok(bundle_to_claim(&bundle))
}

/// Apply the bundle's toggles to produce a claim. Secret vars/files are
/// withheld when `inject_secrets` is off; everything is withheld when the
/// corresponding inject toggle is off. Contents never end up in logs — this is
/// the only place file contents and secret values become claim frames.
fn bundle_to_claim(bundle: &Bundle) -> ClaimSpec {
    let mut claim = ClaimSpec::default();
    if bundle.toggles.inject_vars {
        for v in &bundle.vars {
            if v.is_secret && !bundle.toggles.inject_secrets {
                continue;
            }
            claim.env.insert(v.key.clone(), v.value.clone());
        }
    }
    if bundle.toggles.inject_files {
        for f in &bundle.files {
            if f.is_secret && !bundle.toggles.inject_secrets {
                continue;
            }
            claim.secret_files.push(SecretFileSpec {
                path: f.path.clone(),
                contents_b64: base64::engine::general_purpose::STANDARD.encode(&f.content),
            });
        }
    }
    // Repos carry no secret material and are not governed by the var/file/
    // secret toggles; they are always part of the bundle.
    for r in &bundle.repos {
        claim.repos.push(RepoSpec {
            url: r.url.clone(),
            branch: r.branch.clone(),
            path: r.path.clone(),
        });
    }
    claim
}

/// Serialise a claim into the agent's `apply` frame. The wire shape is the
/// agent's own contract (`crates/ori-agent/src/wire.rs`), not something this
/// module invents.
pub fn claim_to_apply_frame(claim: &ClaimSpec) -> Value {
    serde_json::json!({
        "type": "apply",
        "id": format!("req_{}", crate::tunnel::random_hex(8)),
        "env": claim.env,
        "secretFiles": claim
            .secret_files
            .iter()
            .map(|f| serde_json::json!({ "path": f.path, "contentsB64": f.contents_b64 }))
            .collect::<Vec<_>>(),
        "repos": claim
            .repos
            .iter()
            .map(|r| serde_json::json!({ "url": r.url, "ref": r.branch, "path": r.path }))
            .collect::<Vec<_>>(),
    })
}

/// Push the claim for a sandbox's pinned `(environment, version)` to its live
/// agent. Best-effort: `None` means no live tunnel, which the connect-time
/// push in the tunnel handler will retry on the next `hello`.
pub async fn push_claim_for_sandbox(state: &AppState, sandbox_id: &str) -> ApiResult<()> {
    let row = match repo::get_sandbox_including_deleted(&state.db, sandbox_id).await? {
        Some(r) => r,
        None => return Ok(()),
    };
    if row.deleted_at.is_some() {
        return Ok(());
    }
    let claim = build_claim(
        &state.db,
        &row.account_id,
        &row.environment,
        row.environment_version,
        row.no_env,
    )
    .await?;
    let frame = claim_to_apply_frame(&claim);
    let result = state.agents.apply(sandbox_id, frame).await;
    match result {
        Some(Ok(())) => {
            tracing::info!(
                sandbox = %sandbox_id,
                environment = %row.environment,
                version = row.environment_version,
                no_env = row.no_env,
                "env: claim applied"
            );
        }
        Some(Err(message)) => {
            tracing::warn!(
                sandbox = %sandbox_id,
                environment = %row.environment,
                version = row.environment_version,
                error = %message,
                "env: agent rejected the claim"
            );
        }
        None => {
            tracing::debug!(
                sandbox = %sandbox_id,
                "env: no live tunnel to push the claim"
            );
        }
    }
    Ok(())
}

/// Push the claim to a single sandbox after the given set of states, and bump
/// its pinned version. Used by `env upgrade`.
async fn upgrade_one(state: &AppState, row: &SandboxRow, version: i64) -> ApiResult<bool> {
    if row.environment_version == version {
        return Ok(false);
    }
    sqlx::query("UPDATE sandboxes SET environment_version = ?, updated_at = ? WHERE id = ?")
        .bind(version)
        .bind(now_ts())
        .bind(&row.id)
        .execute(&state.db)
        .await?;
    let running = matches!(
        row.state_enum(),
        crate::proto::BoxState::Ready
            | crate::proto::BoxState::Running
            | crate::proto::BoxState::Idle
    );
    if running {
        push_claim_for_sandbox(state, &row.id).await?;
        return Ok(true);
    }
    Ok(false)
}

/// `env upgrade`: move every sandbox on the environment onto its latest
/// version and push the new claim to the running ones. A sandbox whose
/// environment removed a secret gets a claim that does not carry it — the
/// removal is the point of the upgrade.
pub async fn upgrade(state: &AppState, account_id: &str, name: &str) -> ApiResult<UpgradeReport> {
    let env = get_env(&state.db, account_id, name)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("environment {name:?}")))?;
    let version = latest_version(&state.db, &env.id)
        .await?
        .ok_or_else(|| ApiError::internal("environment has no versions"))?;

    let sandboxes = sqlx::query_as::<_, SandboxRow>(&format!(
        "SELECT {} FROM sandboxes WHERE account_id = ? AND environment = ? AND deleted_at IS NULL",
        repo::SAND_COLUMNS
    ))
    .bind(account_id)
    .bind(&env.name)
    .fetch_all(&state.db)
    .await?;

    let mut applied = 0;
    for row in &sandboxes {
        if upgrade_one(state, row, version).await? {
            applied += 1;
        }
    }
    Ok(UpgradeReport {
        environment: env.name,
        version,
        sandboxes: sandboxes.len(),
        applied,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpgradeReport {
    pub environment: String,
    pub version: i64,
    pub sandboxes: usize,
    pub applied: usize,
}

// ---------------------------------------------------------------------------
// DTOs for routes (secret values never leave the server)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VarDto {
    pub key: String,
    pub secret: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDto {
    pub path: String,
    pub secret: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoDto {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentDto {
    pub name: String,
    pub is_default: bool,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
    pub vars: Vec<VarDto>,
    pub files: Vec<FileDto>,
    pub repos: Vec<RepoDto>,
    pub toggles: Toggles,
}

impl EnvironmentDto {
    pub fn from_row(env: &EnvironmentRow, bundle: &Bundle) -> EnvironmentDto {
        EnvironmentDto {
            name: env.name.clone(),
            is_default: env.is_default,
            version: 0,
            created_at: env.created_at.clone(),
            updated_at: env.updated_at.clone(),
            vars: bundle
                .vars
                .iter()
                .map(|v| VarDto {
                    key: v.key.clone(),
                    secret: v.is_secret,
                    value: if v.is_secret {
                        None
                    } else {
                        Some(v.value.clone())
                    },
                })
                .collect(),
            files: bundle
                .files
                .iter()
                .map(|f| FileDto {
                    path: f.path.clone(),
                    secret: f.is_secret,
                    content: if f.is_secret {
                        None
                    } else {
                        Some(f.content.clone())
                    },
                })
                .collect(),
            repos: bundle
                .repos
                .iter()
                .map(|r| RepoDto {
                    url: r.url.clone(),
                    branch: r.branch.clone(),
                    path: r.path.clone(),
                })
                .collect(),
            toggles: bundle.toggles.clone(),
        }
    }
}

/// The version number an environment is currently on. Resolved for DTOs.
pub async fn dto_for_env(db: &SqlitePool, env: &EnvironmentRow) -> ApiResult<EnvironmentDto> {
    let version = latest_version(db, &env.id).await?.unwrap_or(1);
    let vr = version_row(db, &env.id, version).await?;
    let bundle = match vr {
        Some(v) => bundle_for_version(db, &v.id).await?,
        None => Bundle::default(),
    };
    let mut dto = EnvironmentDto::from_row(env, &bundle);
    dto.version = version;
    Ok(dto)
}

/// The default checkout path for a repo url: the final path segment minus any
/// trailing `.git`.
fn default_repo_path(url: &str) -> String {
    let trimmed = url.trim_end_matches('/');
    let name = trimmed
        .rsplit('/')
        .next()
        .map(|s| s.strip_suffix(".git").unwrap_or(s))
        .filter(|s| !s.is_empty())
        .unwrap_or("repo");
    name.to_string()
}

// ---------------------------------------------------------------------------
// random id helper (re-exported for the tunnel frame id)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    async fn pool() -> SqlitePool {
        db::open_in_memory().await.unwrap()
    }

    #[tokio::test]
    async fn versioning_is_immutable_and_cumulative() {
        let db = pool().await;
        create_env(&db, "default", "prod").await.unwrap();

        // v1 empty
        let e = get_env(&db, "default", "prod").await.unwrap().unwrap();
        let b = latest_bundle(&db, &e.id).await.unwrap();
        assert!(b.vars.is_empty());

        // v2: one var
        set_var(&db, "default", "prod", "API_URL", "https://x", false)
            .await
            .unwrap();
        let e = get_env(&db, "default", "prod").await.unwrap().unwrap();
        assert_eq!(latest_version(&db, &e.id).await.unwrap(), Some(2));

        // v3: a secret var; v2 must be unchanged
        set_var(&db, "default", "prod", "TOKEN", "hunter2", true)
            .await
            .unwrap();
        let v2 = version_row(&db, &e.id, 2).await.unwrap().unwrap();
        let v3 = version_row(&db, &e.id, 3).await.unwrap().unwrap();
        let b2 = bundle_for_version(&db, &v2.id).await.unwrap();
        assert_eq!(b2.vars.len(), 1);
        assert_eq!(b2.vars[0].key, "API_URL");
        assert!(!b2.vars[0].is_secret);
        let b3 = bundle_for_version(&db, &v3.id).await.unwrap();
        assert_eq!(b3.vars.len(), 2);

        // the claim for v3 carries both; the secret value is in the claim env
        let claim = build_claim(&db, "default", "prod", 3, false).await.unwrap();
        assert_eq!(claim.env["TOKEN"], "hunter2");
        assert_eq!(claim.env["API_URL"], "https://x");
    }

    #[tokio::test]
    async fn no_env_scrubs_everything() {
        let db = pool().await;
        create_env(&db, "default", "prod").await.unwrap();
        set_var(&db, "default", "prod", "K", "v", true)
            .await
            .unwrap();
        set_file(&db, "default", "prod", ".netrc", "password", true)
            .await
            .unwrap();
        set_var(&db, "default", "prod", "K2", "v2", false)
            .await
            .unwrap();
        let claim = build_claim(&db, "default", "prod", 4, true).await.unwrap();
        assert!(claim.env.is_empty(), "no-env claim must be empty");
        assert!(claim.secret_files.is_empty());
        assert!(claim.repos.is_empty());
    }

    #[tokio::test]
    async fn inject_secrets_off_withholds_secrets_but_keeps_plain_vars() {
        let db = pool().await;
        create_env(&db, "default", "prod").await.unwrap();
        set_var(&db, "default", "prod", "SECRET", "hunter2", true)
            .await
            .unwrap();
        set_var(&db, "default", "prod", "PLAIN", "x", false)
            .await
            .unwrap();
        set_toggle(&db, "default", "prod", "inject_secrets", false)
            .await
            .unwrap();
        let claim = build_claim(&db, "default", "prod", 4, false).await.unwrap();
        assert!(!claim.env.contains_key("SECRET"), "secret must be withheld");
        assert_eq!(claim.env["PLAIN"], "x");
    }

    #[tokio::test]
    async fn removed_secret_is_withheld_from_the_new_version() {
        let db = pool().await;
        create_env(&db, "default", "prod").await.unwrap();
        set_var(&db, "default", "prod", "TOKEN", "hunter2", true)
            .await
            .unwrap();
        set_file(&db, "default", "prod", ".aws/creds", "AKIA...", true)
            .await
            .unwrap();
        let e = get_env(&db, "default", "prod").await.unwrap().unwrap();
        let version = latest_version(&db, &e.id).await.unwrap().unwrap();
        // remove both
        rm_var(&db, "default", "prod", "TOKEN").await.unwrap();
        rm_file(&db, "default", "prod", ".aws/creds").await.unwrap();
        let claim = build_claim(&db, "default", "prod", version + 2, false)
            .await
            .unwrap();
        assert!(claim.env.is_empty(), "removed secret var must be withheld");
        assert!(
            claim.secret_files.is_empty(),
            "removed secret file must be withheld"
        );
    }

    #[tokio::test]
    async fn default_repo_paths() {
        assert_eq!(
            default_repo_path("https://github.com/user/repo.git"),
            "repo"
        );
        assert_eq!(default_repo_path("git@github.com:user/repo"), "repo");
        assert_eq!(default_repo_path("https://host/x/y/"), "y");
    }
}
