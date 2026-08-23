//! SQLite access for sandboxes and friends.

use sqlx::FromRow;
use sqlx::SqlitePool;

use crate::error::ApiResult;
use crate::proto::{BoxState, MachineType, Sandbox};
use crate::util::now_ts;

const SAND_COLUMNS: &str = "id, account_id, name, state, machine_type, slug, provider, \
     provider_handle, environment, environment_version, no_env, ip, url, ssh_endpoint, \
     desktop_available, desktop_url, created_at, updated_at, stop_after, snapshot_available, \
     last_snapshot_attempt_at, last_snapshot_status, snapshot_completed_at, setup_status, \
     setup_error, team, deleted_at";

#[derive(Debug, FromRow, Clone)]
pub struct SandboxRow {
    pub id: String,
    pub account_id: String,
    pub name: String,
    pub state: String,
    pub machine_type: String,
    pub slug: String,
    pub provider: String,
    pub provider_handle: String,
    pub environment: String,
    pub environment_version: i64,
    pub no_env: bool,
    pub ip: Option<String>,
    pub url: Option<String>,
    pub ssh_endpoint: Option<String>,
    pub desktop_available: bool,
    pub desktop_url: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub stop_after: Option<String>,
    pub snapshot_available: bool,
    pub last_snapshot_attempt_at: Option<String>,
    pub last_snapshot_status: Option<String>,
    pub snapshot_completed_at: Option<String>,
    pub setup_status: Option<String>,
    pub setup_error: Option<String>,
    pub team: Option<String>,
    pub deleted_at: Option<String>,
}

impl SandboxRow {
    pub fn state_enum(&self) -> BoxState {
        self.state.parse().unwrap_or(BoxState::Error)
    }

    pub fn machine_enum(&self) -> MachineType {
        self.machine_type.parse().unwrap_or(MachineType::Default)
    }

    pub fn to_sandbox(&self) -> Sandbox {
        let m = self.machine_enum();
        Sandbox {
            id: self.id.clone(),
            name: self.name.clone(),
            state: self.state_enum(),
            machine_type: m,
            vcpu: m.vcpu(),
            memory_gb: m.memory_gb(),
            billing_multiplier: m.billing_multiplier(),
            slug: self.slug.clone(),
            url: self.url.clone(),
            ip: self.ip.clone(),
            ssh_endpoint: self.ssh_endpoint.clone(),
            desktop_available: self.desktop_available,
            desktop_url: self.desktop_url.clone(),
            environment: self.environment.clone(),
            environment_version: self.environment_version,
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
            stop_after: self.stop_after.clone(),
            snapshot_available: self.snapshot_available,
            last_snapshot_attempt_at: self.last_snapshot_attempt_at.clone(),
            last_snapshot_status: self.last_snapshot_status.clone(),
            snapshot_completed_at: self.snapshot_completed_at.clone(),
            setup_status: self.setup_status.clone(),
            setup_error: self.setup_error.clone(),
            provider: self.provider.clone(),
            team: self.team.clone(),
        }
    }
}

#[derive(Debug)]
pub struct NewSandbox {
    pub id: String,
    pub account_id: String,
    pub name: String,
    pub state: BoxState,
    pub machine_type: MachineType,
    pub slug: String,
    pub provider: String,
    pub provider_handle: String,
    pub environment: String,
    pub environment_version: i64,
    pub no_env: bool,
    pub stop_after: Option<String>,
    pub team: Option<String>,
}

pub async fn insert_sandbox(db: &SqlitePool, s: &NewSandbox) -> Result<(), sqlx::Error> {
    let now = now_ts();
    sqlx::query(
        "INSERT INTO sandboxes (id, account_id, name, state, machine_type, slug, provider, \
         provider_handle, environment, environment_version, no_env, created_at, updated_at, \
         stop_after, team, agent_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&s.id)
    .bind(&s.account_id)
    .bind(&s.name)
    .bind(s.state.as_str())
    .bind(slugify_type(&s.machine_type))
    .bind(&s.slug)
    .bind(&s.provider)
    .bind(&s.provider_handle)
    .bind(&s.environment)
    .bind(s.environment_version)
    .bind(s.no_env)
    .bind(&now)
    .bind(&now)
    .bind(&s.stop_after)
    .bind(&s.team)
    // Minted per sandbox so the agent has a credential that is not the
    // account key: anything running inside the sandbox can read it.
    .bind(crate::tunnel::new_agent_token())
    .execute(db)
    .await?;
    Ok(())
}

/// Record a completed provider snapshot. `taken_while_stopped` must be true
/// only for snapshots taken while the container was powered off: `fork` clones
/// exclusively from those (docs/BENCHMARKS.md §Root cause), because a
/// running-taken snapshot is permanently ~20x slower to clone from. A snapshot
/// named for the local action ("stop", "ttl", "fork") carries the provider
/// scoped ref in `provider_snapshot` (`node/vmid/name` on proxmox).
pub async fn insert_snapshot(
    db: &SqlitePool,
    account_id: &str,
    sandbox_id: &str,
    name: &str,
    provider_snapshot: &str,
    taken_while_stopped: bool,
) -> Result<(), sqlx::Error> {
    let now = now_ts();
    let id = crate::proto::TypedId::snapshot().to_string();
    sqlx::query(
        "INSERT INTO snapshots (id, account_id, sandbox_id, name, provider_snapshot, state, \
         is_incremental, parent_id, created_at, completed_at, taken_while_stopped) \
         VALUES (?, ?, ?, ?, ?, 'complete', 0, NULL, ?, ?, ?)",
    )
    .bind(&id)
    .bind(account_id)
    .bind(sandbox_id)
    .bind(name)
    .bind(provider_snapshot)
    .bind(&now)
    .bind(&now)
    .bind(taken_while_stopped)
    .execute(db)
    .await?;
    Ok(())
}

/// The newest snapshot of `sandbox_id` that was taken while the container was
/// stopped, or `None`. `fork` clones from this — never from a fresh snapshot
/// of a running source. `created_at` is second-precision, so `rowid DESC`
/// breaks ties toward the most recent insert.
pub async fn latest_stopped_snapshot(
    db: &SqlitePool,
    sandbox_id: &str,
) -> Result<Option<String>, sqlx::Error> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT provider_snapshot FROM snapshots \
         WHERE sandbox_id = ? AND taken_while_stopped = 1 AND state = 'complete' \
         ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .bind(sandbox_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|(s,)| s))
}

pub fn is_unique_violation(e: &sqlx::Error) -> bool {
    e.as_database_error()
        .map(|d| d.is_unique_violation())
        .unwrap_or(false)
}

fn slugify_type(m: &MachineType) -> &'static str {
    match m {
        MachineType::Small => "small",
        MachineType::Default => "default",
        MachineType::Large => "large",
    }
}

pub async fn get_sandbox(
    db: &SqlitePool,
    id: &str,
    account_id: &str,
) -> ApiResult<Option<SandboxRow>> {
    let row = sqlx::query_as::<_, SandboxRow>(&format!(
        "SELECT {SAND_COLUMNS} FROM sandboxes WHERE id = ? AND account_id = ? AND deleted_at IS NULL"
    ))
    .bind(id)
    .bind(account_id)
    .fetch_optional(db)
    .await?;
    Ok(row)
}

pub async fn get_sandbox_including_deleted(
    db: &SqlitePool,
    id: &str,
) -> ApiResult<Option<SandboxRow>> {
    let row = sqlx::query_as::<_, SandboxRow>(&format!(
        "SELECT {SAND_COLUMNS} FROM sandboxes WHERE id = ?"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row)
}

/// Guarded transition: only succeeds if the row is currently in one of `from`.
/// Returns false if the row moved under us (another reaper/request got there
/// first). This is what makes stop-on-stopping idempotent and restart-safe.
pub async fn transition(db: &SqlitePool, id: &str, from: &[&str], to: BoxState) -> ApiResult<bool> {
    if from.is_empty() {
        return Ok(false);
    }
    let placeholders = vec!["?"; from.len()].join(",");
    let q = format!(
        "UPDATE sandboxes SET state = ?, updated_at = ? WHERE id = ? AND state IN ({placeholders}) AND deleted_at IS NULL"
    );
    let mut qb = sqlx::query(&q).bind(to.as_str()).bind(now_ts()).bind(id);
    for f in from {
        qb = qb.bind(f);
    }
    let res = qb.execute(db).await?;
    Ok(res.rows_affected() > 0)
}

pub async fn set_state(db: &SqlitePool, id: &str, to: BoxState) -> ApiResult<()> {
    sqlx::query("UPDATE sandboxes SET state = ?, updated_at = ? WHERE id = ?")
        .bind(to.as_str())
        .bind(now_ts())
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

/// Record provider addresses after a create/resume, and refresh `updated_at`.
pub async fn set_instance_addresses(
    db: &SqlitePool,
    id: &str,
    ip: Option<&str>,
    url: Option<&str>,
    desktop_url: Option<&str>,
) -> ApiResult<()> {
    sqlx::query(
        "UPDATE sandboxes SET ip = ?, url = ?, desktop_url = ?, updated_at = ? WHERE id = ?",
    )
    .bind(ip)
    .bind(url)
    .bind(desktop_url)
    .bind(now_ts())
    .bind(id)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn set_provider_handle(db: &SqlitePool, id: &str, handle: &str) -> ApiResult<()> {
    sqlx::query("UPDATE sandboxes SET provider_handle = ?, updated_at = ? WHERE id = ?")
        .bind(handle)
        .bind(now_ts())
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn set_stop_after(db: &SqlitePool, id: &str, stop_after: Option<&str>) -> ApiResult<()> {
    sqlx::query("UPDATE sandboxes SET stop_after = ?, updated_at = ? WHERE id = ?")
        .bind(stop_after)
        .bind(now_ts())
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn set_no_env(db: &SqlitePool, id: &str, no_env: bool) -> ApiResult<()> {
    sqlx::query("UPDATE sandboxes SET no_env = ?, updated_at = ? WHERE id = ?")
        .bind(no_env)
        .bind(now_ts())
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn set_setup_status(
    db: &SqlitePool,
    id: &str,
    status: &str,
    error: Option<&str>,
) -> ApiResult<()> {
    sqlx::query(
        "UPDATE sandboxes SET setup_status = ?, setup_error = ?, updated_at = ? WHERE id = ?",
    )
    .bind(status)
    .bind(error)
    .bind(now_ts())
    .bind(id)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn soft_delete(db: &SqlitePool, id: &str) -> ApiResult<()> {
    sqlx::query("UPDATE sandboxes SET deleted_at = ?, updated_at = ? WHERE id = ?")
        .bind(now_ts())
        .bind(now_ts())
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

/// Expand filter letters (`rspte`) into a state-name list for a SQL `IN`.
pub fn state_names_for_letters(letters: &[char]) -> Vec<String> {
    BoxState::ALL
        .iter()
        .filter(|s| letters.contains(&s.letter()))
        .map(|s| s.as_str().to_string())
        .collect()
}

pub async fn list_sandboxes(
    db: &SqlitePool,
    account_id: &str,
    states: &[String],
    limit: u32,
    offset: u32,
) -> ApiResult<(Vec<SandboxRow>, bool)> {
    let placeholders = vec!["?"; states.len()].join(",");
    let q = format!(
        "SELECT {SAND_COLUMNS} FROM sandboxes WHERE account_id = ? AND deleted_at IS NULL \
         AND state IN ({placeholders}) ORDER BY created_at DESC LIMIT ? OFFSET ?"
    );
    let mut qb = sqlx::query_as::<_, SandboxRow>(&q).bind(account_id);
    for s in states {
        qb = qb.bind(s);
    }
    let rows = qb
        .bind(limit as i64 + 1)
        .bind(offset as i64)
        .fetch_all(db)
        .await?;
    let has_more = rows.len() > limit as usize;
    let rows = rows.into_iter().take(limit as usize).collect();
    Ok((rows, has_more))
}

/// (current_running, current_total) for the account.
pub async fn counts(db: &SqlitePool, account_id: &str) -> ApiResult<(i64, i64)> {
    let row: (i64, i64) = sqlx::query_as(
        "SELECT \
         (SELECT count(*) FROM sandboxes WHERE account_id = ? AND deleted_at IS NULL AND \
          state IN ('ready','running','idle','cloning','provisioning','init','provisioned')), \
         (SELECT count(*) FROM sandboxes WHERE account_id = ? AND deleted_at IS NULL)",
    )
    .bind(account_id)
    .bind(account_id)
    .fetch_one(db)
    .await?;
    Ok(row)
}

/// Every non-deleted sandbox in a set of states.
pub async fn sandboxes_in_states(db: &SqlitePool, states: &[&str]) -> ApiResult<Vec<SandboxRow>> {
    let placeholders = vec!["?"; states.len()].join(",");
    let q = format!(
        "SELECT {SAND_COLUMNS} FROM sandboxes WHERE deleted_at IS NULL AND state IN ({placeholders})"
    );
    let mut qb = sqlx::query_as::<_, SandboxRow>(&q);
    for s in states {
        qb = qb.bind(s);
    }
    Ok(qb.fetch_all(db).await?)
}
