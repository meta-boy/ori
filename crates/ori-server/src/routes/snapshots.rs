//! Snapshot routes. Snapshots are the substrate of `stop`/`resume`/`fork` —
//! all working — and until this module they were unreachable: no way to list
//! them, save under a name, inspect, pull, or delete.
//!
//! Three rules from `plans/C20-snapshots.md` are load-bearing:
//!
//! - **`takenWhileStopped` is on every row.** `docs/BENCHMARKS.md` establishes
//!   that a snapshot taken while the container was running is permanently
//!   ~20x more expensive to clone from, so this column is the only field that
//!   predicts whether a fork takes 9 s or 51 s. A list that hides it is hiding
//!   the thing that matters — it is surfaced verbatim.
//! - **`delete` refuses a snapshot with dependents** (409, naming them).
//!   Deleting a snapshot another one is layered on is data loss, not an error
//!   to paper over. A named-snapshot replacement records the dependency: the
//!   replacement's `parent_id` is the snapshot the name previously pointed at.
//! - **`pull` streams.** A multi-GB snapshot is never buffered in memory. The
//!   agent's `File` stream frame (chunked, backpressured) is reused verbatim:
//!   the route opens a file stream over the tunnel and relays the chunks into
//!   the HTTP body. `tree` consumes the same stream, parsing tar headers
//!   incrementally rather than holding the archive.

use std::convert::Infallible;

use axum::body::{Body, Bytes};
use axum::extract::{Extension, Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures_util::stream::unfold;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::auth::ApiKeyAuth;
use crate::error::{ApiError, ApiResult};
use crate::proto::{BoxState, InstanceHandle, PageInfo, SnapshotRef};
use crate::repo::SandboxRow;
use crate::state::AppState;
use crate::util::now_ts;

/// Per-account cap on named snapshots (`docs/SPEC-CLI.md` §Snapshots).
const NAMED_SNAPSHOT_CAP: i64 = 10;

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: String,
    pub sandbox_id: String,
    pub name: Option<String>,
    pub provider_snapshot: String,
    pub state: String,
    pub is_incremental: bool,
    pub parent_id: Option<String>,
    pub created_at: String,
    pub completed_at: Option<String>,
    pub taken_while_stopped: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotList {
    pub snapshots: Vec<Snapshot>,
    pub page_info: PageInfo,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotDetail {
    pub snapshot: Snapshot,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct NamedSnapshot {
    pub name: String,
    pub snapshot_id: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedSnapshotList {
    pub named_snapshots: Vec<NamedSnapshot>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSnapshotResponse {
    pub snapshot: Snapshot,
    pub named: NamedSnapshot,
    /// Always empty in this build; the client renders a note itself. Kept for
    /// the wire shape so a future server-provided warning has a home.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSnapshotRequest {
    pub sandbox_id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotTreeFile {
    pub path: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotTree {
    pub snapshot: Snapshot,
    pub files: Vec<SnapshotTreeFile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotDeleted {
    pub deleted: bool,
}

// ---------------------------------------------------------------------------
// Repository helpers (kept here, not in `repo.rs`, so this card stays in its
// own files; they mirror the shape of the other route-local queries).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, sqlx::FromRow)]
struct SnapshotRow {
    id: String,
    account_id: String,
    sandbox_id: String,
    name: Option<String>,
    provider_snapshot: String,
    state: String,
    is_incremental: bool,
    parent_id: Option<String>,
    created_at: String,
    completed_at: Option<String>,
    taken_while_stopped: bool,
}

impl SnapshotRow {
    fn to_snapshot(&self) -> Snapshot {
        Snapshot {
            id: self.id.clone(),
            sandbox_id: self.sandbox_id.clone(),
            name: self.name.clone(),
            provider_snapshot: self.provider_snapshot.clone(),
            state: self.state.clone(),
            is_incremental: self.is_incremental,
            parent_id: self.parent_id.clone(),
            created_at: self.created_at.clone(),
            completed_at: self.completed_at.clone(),
            taken_while_stopped: self.taken_while_stopped,
        }
    }
}

const SNAP_COLUMNS: &str = "id, account_id, sandbox_id, name, provider_snapshot, state, \
     is_incremental, parent_id, created_at, completed_at, taken_while_stopped";

async fn query_snapshots(
    db: &SqlitePool,
    account_id: &str,
    sandbox_id: Option<&str>,
    all: bool,
    limit: u32,
    offset: u32,
) -> ApiResult<(Vec<SnapshotRow>, bool)> {
    let state_filter = if all { "" } else { " AND state = 'complete'" };
    let sandbox_filter = if sandbox_id.is_some() {
        " AND sandbox_id = ?"
    } else {
        ""
    };
    let q = format!(
        "SELECT {SNAP_COLUMNS} FROM snapshots \
         WHERE account_id = ?{sandbox_filter}{state_filter} \
         ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?"
    );
    let mut qb = sqlx::query_as::<_, SnapshotRow>(&q).bind(account_id);
    if let Some(s) = sandbox_id {
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

async fn get_snapshot_row(db: &SqlitePool, account_id: &str, id: &str) -> ApiResult<SnapshotRow> {
    let row = sqlx::query_as::<_, SnapshotRow>(&format!(
        "SELECT {SNAP_COLUMNS} FROM snapshots WHERE id = ? AND account_id = ?"
    ))
    .bind(id)
    .bind(account_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| ApiError::not_found(format!("snapshot {id}")))?;
    Ok(row)
}

/// Insert a completed provider snapshot and return its id. `taken_while_stopped`
/// must be true only for snapshots taken while the container was powered off
/// (docs/BENCHMARKS.md §Root cause): a running-taken snapshot is permanently
/// ~20x slower to clone from. `parent_id` records the snapshot this one is
/// layered on — set only by named-snapshot replacement, and what `delete`'s
/// dependent check keys on.
async fn insert_snapshot_row(
    db: &SqlitePool,
    account_id: &str,
    sandbox_id: &str,
    name: &str,
    provider_snapshot: &str,
    taken_while_stopped: bool,
    is_incremental: bool,
    parent_id: Option<&str>,
) -> ApiResult<String> {
    let id = new_id("orisnap_");
    let now = now_ts();
    sqlx::query(
        "INSERT INTO snapshots (id, account_id, sandbox_id, name, provider_snapshot, state, \
         is_incremental, parent_id, created_at, completed_at, taken_while_stopped) \
         VALUES (?, ?, ?, ?, ?, 'complete', ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(account_id)
    .bind(sandbox_id)
    .bind(name)
    .bind(provider_snapshot)
    .bind(is_incremental)
    .bind(parent_id)
    .bind(&now)
    .bind(&now)
    .bind(taken_while_stopped)
    .execute(db)
    .await?;
    Ok(id)
}

async fn get_named_snapshot(
    db: &SqlitePool,
    account_id: &str,
    name: &str,
) -> Option<NamedSnapshot> {
    sqlx::query_as::<_, NamedSnapshot>(
        "SELECT name, snapshot_id, created_at FROM named_snapshots \
         WHERE account_id = ? AND name = ?",
    )
    .bind(account_id)
    .bind(name)
    .fetch_optional(db)
    .await
    .ok()
    .flatten()
}

async fn query_named_snapshots(db: &SqlitePool, account_id: &str) -> ApiResult<Vec<NamedSnapshot>> {
    let rows = sqlx::query_as::<_, NamedSnapshot>(
        "SELECT name, snapshot_id, created_at FROM named_snapshots \
         WHERE account_id = ? ORDER BY created_at DESC, rowid DESC",
    )
    .bind(account_id)
    .fetch_all(db)
    .await?;
    Ok(rows)
}

/// Oldest named snapshot, used to say *which* one to remove when the cap is hit.
async fn oldest_named_snapshot(db: &SqlitePool, account_id: &str) -> Option<NamedSnapshot> {
    sqlx::query_as::<_, NamedSnapshot>(
        "SELECT name, snapshot_id, created_at FROM named_snapshots \
         WHERE account_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 1",
    )
    .bind(account_id)
    .fetch_optional(db)
    .await
    .ok()
    .flatten()
}

async fn count_named_snapshots(db: &SqlitePool, account_id: &str) -> ApiResult<i64> {
    let (n,): (i64,) = sqlx::query_as("SELECT count(*) FROM named_snapshots WHERE account_id = ?")
        .bind(account_id)
        .fetch_one(db)
        .await?;
    Ok(n)
}

/// Point the name at a snapshot, creating or replacing the mapping.
async fn upsert_named_snapshot(
    db: &SqlitePool,
    account_id: &str,
    name: &str,
    snapshot_id: &str,
) -> ApiResult<()> {
    sqlx::query(
        "INSERT INTO named_snapshots (id, account_id, name, snapshot_id, created_at) \
         VALUES (?, ?, ?, ?, ?) \
         ON CONFLICT(account_id, name) DO UPDATE SET \
           snapshot_id = excluded.snapshot_id, created_at = excluded.created_at",
    )
    .bind(new_id("orinam_"))
    .bind(account_id)
    .bind(name)
    .bind(snapshot_id)
    .bind(now_ts())
    .execute(db)
    .await?;
    Ok(())
}

/// Snapshots layered on `snapshot_id` — deleting it would orphan them.
async fn dependent_snapshots(db: &SqlitePool, snapshot_id: &str) -> ApiResult<Vec<String>> {
    let ids: Vec<(String,)> =
        sqlx::query_as("SELECT id FROM snapshots WHERE parent_id = ? ORDER BY created_at ASC")
            .bind(snapshot_id)
            .fetch_all(db)
            .await?;
    Ok(ids.into_iter().map(|(id,)| id).collect())
}

fn new_id(prefix: &str) -> String {
    let mut buf = vec![0u8; 32];
    getrandom::fill(&mut buf).expect("csprng");
    let hex: String = buf.iter().map(|b| format!("{b:02x}")).collect();
    format!("{prefix}{hex}")
}

fn is_running(state: BoxState) -> bool {
    matches!(state, BoxState::Ready | BoxState::Running | BoxState::Idle)
}

async fn fetch_sandbox(state: &AppState, id: &str, account_id: &str) -> ApiResult<SandboxRow> {
    crate::repo::get_sandbox(&state.db, id, account_id)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("sandbox {id}")))
}

/// `pull`/`tree` read the sandbox's work dir through the agent tunnel. A
/// stopped sandbox has no agent, and a live agent is what makes streaming
/// (rather than buffering a multi-GB snapshot) possible — so refuse clearly
/// rather than pretending the snapshot is a mounted filesystem.
async fn require_live_agent(state: &AppState, snap: &SnapshotRow) -> ApiResult<()> {
    let sandbox = fetch_sandbox(state, &snap.sandbox_id, &snap.account_id).await?;
    if !is_running(sandbox.state_enum()) {
        return Err(ApiError::conflict(format!(
            "cannot read snapshot {}: sandbox {} is {}, and reading the files needs a live \
             agent (a snapshot is not a mounted filesystem); resume the sandbox first. Note \
             the tree reflects the live work dir, not the point-in-time snapshot",
            snap.id, sandbox.id, sandbox.state
        )));
    }
    if !state.agents.is_connected(&snap.sandbox_id).await {
        return Err(ApiError::provider_unavailable(format!(
            "cannot read snapshot {}: sandbox {} has no live agent tunnel; wait for the agent \
             to connect, then retry",
            snap.id, snap.sandbox_id
        )));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// list / get
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct ListParams {
    sandbox_id: Option<String>,
    /// Include snapshots in non-`complete` states (creating/failed/deleting).
    #[serde(default)]
    all: bool,
    limit: Option<u32>,
    cursor: Option<String>,
}

pub async fn list_snapshots(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
    Query(params): Query<ListParams>,
) -> ApiResult<Json<SnapshotList>> {
    if let Some(sandbox_id) = &params.sandbox_id {
        // The filter names a sandbox the caller owns, or it is a 404.
        let _ = fetch_sandbox(&state, sandbox_id, &auth.account_id).await?;
    }
    let limit = params.limit.unwrap_or(50).clamp(1, 200);
    let offset: u32 = params
        .cursor
        .as_deref()
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    let (rows, has_more) = query_snapshots(
        &state.db,
        &auth.account_id,
        params.sandbox_id.as_deref(),
        params.all,
        limit,
        offset,
    )
    .await?;
    let snapshots: Vec<Snapshot> = rows.iter().map(|r| r.to_snapshot()).collect();
    let next_cursor = if has_more {
        Some((offset + limit).to_string())
    } else {
        None
    };
    Ok(Json(SnapshotList {
        snapshots,
        page_info: PageInfo {
            has_more,
            limit,
            next_cursor,
        },
    }))
}

pub async fn get_snapshot(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
    Path(id): Path<String>,
) -> ApiResult<Json<SnapshotDetail>> {
    let row = get_snapshot_row(&state.db, &auth.account_id, &id).await?;
    Ok(Json(SnapshotDetail {
        snapshot: row.to_snapshot(),
    }))
}

// ---------------------------------------------------------------------------
// save (named snapshot)
// ---------------------------------------------------------------------------

/// `POST /snapshots` — take a fresh snapshot of the sandbox and register it
/// under `name`. Reusing a name replaces the mapping: the previous snapshot
/// the name pointed at becomes the new one's parent, so deleting it is refused
/// (it is layered on). Named snapshots are capped at `NAMED_SNAPSHOT_CAP` per
/// account; a new name at the cap names the oldest to remove.
pub async fn save_snapshot(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
    Json(req): Json<SaveSnapshotRequest>,
) -> ApiResult<Json<SaveSnapshotResponse>> {
    let name = validate_name(&req.name)?;
    let sandbox = fetch_sandbox(&state, &req.sandbox_id, &auth.account_id).await?;

    let handle = InstanceHandle {
        provider: sandbox.provider.clone(),
        id: sandbox.provider_handle.clone(),
    };
    // Snapshot the live container whatever its state. A running-taken snapshot
    // is the ~20x-costly-to-clone kind — `takenWhileStopped` is surfaced so
    // that cost is visible, never hidden.
    let snap = state
        .provider
        .snapshot(&handle, &crate::util::snapshot_name("save"))
        .await
        .map_err(|e| ApiError::provider_unavailable(e.to_string()))?;

    let taken_while_stopped = matches!(sandbox.state_enum(), BoxState::Stopped);
    let prior = get_named_snapshot(&state.db, &auth.account_id, &name).await;
    let parent_id = prior.as_ref().map(|p| p.snapshot_id.clone());
    if prior.is_none() {
        let count = count_named_snapshots(&state.db, &auth.account_id).await?;
        if count >= NAMED_SNAPSHOT_CAP {
            let oldest = oldest_named_snapshot(&state.db, &auth.account_id).await;
            let hint = match &oldest {
                Some(o) => format!(
                    "remove the oldest named snapshot `{}` (created {}) with `ori snapshot rm {}`, \
                     or save under an existing name (reusing a name replaces it)",
                    o.name, o.created_at, o.name
                ),
                None => "remove one with `ori snapshot rm <name>`".to_string(),
            };
            return Err(ApiError::conflict(format!(
                "named snapshot cap ({NAMED_SNAPSHOT_CAP} per account) reached: {hint}"
            )));
        }
    }

    // The snapshot row's `name` is a unique-per-sandbox action label
    // (`save-<ms>`), not the user-facing name — the `named_snapshots` mapping
    // holds that, and re-saving under the same name must not collide on the
    // `UNIQUE (sandbox_id, name)` constraint.
    let snapshot_id = insert_snapshot_row(
        &state.db,
        &auth.account_id,
        &sandbox.id,
        &snap.name,
        &snap.name,
        taken_while_stopped,
        parent_id.is_some(),
        parent_id.as_deref(),
    )
    .await?;
    upsert_named_snapshot(&state.db, &auth.account_id, &name, &snapshot_id).await?;

    let row = get_snapshot_row(&state.db, &auth.account_id, &snapshot_id).await?;
    let named = get_named_snapshot(&state.db, &auth.account_id, &name)
        .await
        .ok_or_else(|| ApiError::internal("named snapshot vanished"))?;
    Ok(Json(SaveSnapshotResponse {
        snapshot: row.to_snapshot(),
        named,
        notice: None,
    }))
}

// ---------------------------------------------------------------------------
// delete / rm
// ---------------------------------------------------------------------------

/// `DELETE /snapshots/{id}` — delete one filesystem snapshot. Refused with a
/// 409 naming the dependents when another snapshot is layered on it; deleting
/// a snapshot another one is built on is data loss, not an error to paper over.
pub async fn delete_snapshot(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
    Path(id): Path<String>,
) -> ApiResult<Json<SnapshotDeleted>> {
    let row = get_snapshot_row(&state.db, &auth.account_id, &id).await?;
    delete_snapshot_inner(&state, &row).await?;
    Ok(Json(SnapshotDeleted { deleted: true }))
}

/// `DELETE /named-snapshots/{name}` — remove a named snapshot. Removes the
/// mapping and the underlying filesystem snapshot (refusing with the same 409
/// if that snapshot has dependents).
pub async fn rm_named_snapshot(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
    Path(name): Path<String>,
) -> ApiResult<Json<SnapshotDeleted>> {
    let named = get_named_snapshot(&state.db, &auth.account_id, &name)
        .await
        .ok_or_else(|| ApiError::not_found(format!("named snapshot {name}")))?;
    if let Ok(row) = get_snapshot_row(&state.db, &auth.account_id, &named.snapshot_id).await {
        delete_snapshot_inner(&state, &row).await?;
    }
    sqlx::query("DELETE FROM named_snapshots WHERE account_id = ? AND name = ?")
        .bind(&auth.account_id)
        .bind(&name)
        .execute(&state.db)
        .await?;
    Ok(Json(SnapshotDeleted { deleted: true }))
}

async fn delete_snapshot_inner(state: &AppState, row: &SnapshotRow) -> ApiResult<()> {
    let dependents = dependent_snapshots(&state.db, &row.id).await?;
    if !dependents.is_empty() {
        let listed = dependents
            .iter()
            .take(5)
            .map(|d| d.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        let more = if dependents.len() > 5 {
            format!(" and {} more", dependents.len() - 5)
        } else {
            String::new()
        };
        return Err(ApiError::conflict(format!(
            "cannot delete snapshot {}: {} dependent snapshot(s) are layered on it ({listed}{more}); \
             deleting it would orphan them. Delete the dependents first (`ori snapshot delete <id>`)",
            row.id,
            dependents.len()
        )));
    }

    // Clear the name mapping if the snapshot is still named — a name pointing
    // at a deleted snapshot would be dangling.
    let _ = sqlx::query("DELETE FROM named_snapshots WHERE snapshot_id = ?")
        .bind(&row.id)
        .execute(&state.db)
        .await;

    // The provider-scoped ref lives in `provider_snapshot` (`node/vmid/name`
    // on proxmox); the provider name comes from the owning sandbox.
    let provider = crate::repo::get_sandbox_including_deleted(&state.db, &row.sandbox_id)
        .await
        .ok()
        .flatten()
        .map(|s| s.provider)
        .unwrap_or_default();
    let snap_ref = SnapshotRef {
        provider,
        name: row.provider_snapshot.clone(),
    };
    state
        .provider
        .snapshot_delete(&snap_ref)
        .await
        .map_err(|e| ApiError::provider_unavailable(e.to_string()))?;

    sqlx::query("DELETE FROM snapshots WHERE id = ?")
        .bind(&row.id)
        .execute(&state.db)
        .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// tree
// ---------------------------------------------------------------------------

/// `GET /snapshots/{id}/tree` — files and sizes captured in a snapshot. The
/// archive is read off the agent tunnel and tar headers parsed incrementally,
/// so a multi-GB snapshot is never buffered to answer a listing.
pub async fn snapshot_tree(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
    Path(id): Path<String>,
) -> ApiResult<Json<SnapshotTree>> {
    let row = get_snapshot_row(&state.db, &auth.account_id, &id).await?;
    require_live_agent(&state, &row).await?;
    let Some(mut stream) = state.agents.open_file(&row.sandbox_id, ".").await else {
        return Err(ApiError::provider_unavailable(format!(
            "cannot read snapshot {}: failed to open a stream to {}",
            row.id, row.sandbox_id
        )));
    };
    let mut parser = TarListing::new();
    while let Some(chunk) = stream.recv().await {
        parser.feed(&chunk);
        if parser.done() {
            break;
        }
    }
    stream.close(0).await;
    Ok(Json(SnapshotTree {
        snapshot: row.to_snapshot(),
        files: parser.files,
    }))
}

// ---------------------------------------------------------------------------
// pull
// ---------------------------------------------------------------------------

/// `GET /snapshots/{id}/pull` — stream the snapshot's files as a tar over the
/// agent tunnel into the HTTP body. Never buffered: each chunk from the agent
/// is relayed as it arrives, and backpressure is the tunnel's bounded channel.
pub async fn pull_snapshot(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let row = get_snapshot_row(&state.db, &auth.account_id, &id).await?;
    require_live_agent(&state, &row).await?;
    let Some(stream) = state.agents.open_file(&row.sandbox_id, ".").await else {
        return Err(ApiError::provider_unavailable(format!(
            "cannot pull snapshot {}: failed to open a stream to {}",
            row.id, row.sandbox_id
        )));
    };
    let body = Body::from_stream(unfold(stream, |mut stream| async move {
        match stream.recv().await {
            Some(bytes) => Some((Ok::<Bytes, Infallible>(Bytes::from(bytes)), stream)),
            None => {
                stream.close(0).await;
                None
            }
        }
    }));
    let headers = [
        (
            header::CONTENT_TYPE.as_str(),
            "application/octet-stream".to_string(),
        ),
        (
            header::CONTENT_DISPOSITION.as_str(),
            format!("attachment; filename=\"{}.tar\"", row.id),
        ),
    ];
    Ok((StatusCode::OK, headers, body).into_response())
}

// ---------------------------------------------------------------------------
// named-snapshots list
// ---------------------------------------------------------------------------

pub async fn list_named_snapshots(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
) -> ApiResult<Json<NamedSnapshotList>> {
    let named = query_named_snapshots(&state.db, &auth.account_id).await?;
    Ok(Json(NamedSnapshotList {
        named_snapshots: named,
    }))
}

// ---------------------------------------------------------------------------
// tar header parsing (incremental, no buffering of the archive)
// ---------------------------------------------------------------------------

const TAR_BLOCK: usize = 512;

/// Parses a ustar tar stream entry-by-entry, collecting `(path, size)` without
/// retaining the file data. Used by `tree`; `pull` relays the same stream raw.
struct TarListing {
    files: Vec<SnapshotTreeFile>,
    buf: Vec<u8>,
    /// Bytes of the current entry's data still to skip (tar pads to 512).
    remaining_data: u64,
    ended: bool,
}

impl TarListing {
    fn new() -> Self {
        TarListing {
            files: Vec::new(),
            buf: Vec::new(),
            remaining_data: 0,
            ended: false,
        }
    }

    fn done(&self) -> bool {
        self.ended
    }

    fn feed(&mut self, bytes: &[u8]) {
        if self.ended {
            return;
        }
        self.buf.extend_from_slice(bytes);
        self.consume();
    }

    fn consume(&mut self) {
        loop {
            if self.remaining_data > 0 {
                let skip = (self.remaining_data as usize).min(self.buf.len());
                self.buf.drain(..skip);
                self.remaining_data -= skip as u64;
                if self.remaining_data > 0 {
                    return;
                }
            }
            if self.buf.len() < TAR_BLOCK {
                return;
            }
            let mut header = [0u8; TAR_BLOCK];
            header.copy_from_slice(&self.buf[..TAR_BLOCK]);
            if header[0] == 0 {
                self.ended = true;
                self.buf.clear();
                return;
            }
            self.buf.drain(..TAR_BLOCK);
            let name = tar_name(&header[0..100]);
            let size = tar_octal(&header[124..136]);
            let padded = size.div_ceil(TAR_BLOCK as u64) * TAR_BLOCK as u64;
            self.remaining_data = padded;
            let typeflag = header[156];
            // Regular files ('0', '\0', or ' ') have data; directories ('5')
            // and links are listed with their size (0). Everything is reported
            // so a tree shows the whole captured shape.
            if matches!(typeflag, b'0' | 0 | b' ') || typeflag == b'5' {
                self.files.push(SnapshotTreeFile { path: name, size });
            }
        }
    }
}

/// NUL/space-terminated name; `.` entries from `tar -C dir .` are shown as-is
/// (the client untars into its chosen directory).
fn tar_name(bytes: &[u8]) -> String {
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end])
        .trim_end_matches(' ')
        .to_string()
}

/// Octal (base-8) size field, NUL/space terminated.
fn tar_octal(bytes: &[u8]) -> u64 {
    let end = bytes
        .iter()
        .position(|&b| b == 0 || b == b' ')
        .unwrap_or(bytes.len());
    let digits = &bytes[..end];
    if digits.iter().all(|&b| b == b' ' || b == 0) || digits.is_empty() {
        return 0;
    }
    // GNU longname/base-256 encodings are not produced by `tar -cf -`, so the
    // octal parse is sufficient here; anything unparseable is treated as 0.
    std::str::from_utf8(digits)
        .ok()
        .and_then(|s| u64::from_str_radix(s.trim(), 8).ok())
        .unwrap_or(0)
}

fn validate_name(name: &str) -> ApiResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(ApiError::invalid_request("snapshot name must not be empty"));
    }
    if name.len() > 64 {
        return Err(ApiError::invalid_request(
            "snapshot name must be at most 64 characters",
        ));
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(ApiError::invalid_request(
            "snapshot name may contain only letters, digits, '-', '_' and '.'",
        ));
    }
    Ok(name.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(name: &str, size: u64, typeflag: u8) -> Vec<u8> {
        let mut h = [0u8; TAR_BLOCK];
        let name_bytes = name.as_bytes();
        h[..name_bytes.len().min(100)].copy_from_slice(&name_bytes[..name_bytes.len().min(100)]);
        let size_str = format!("{size:011o}\0");
        h[124..124 + size_str.len()].copy_from_slice(size_str.as_bytes());
        h[156] = typeflag;
        h.to_vec()
    }

    fn archive() -> Vec<u8> {
        let mut out = Vec::new();
        out.extend(header("./dir/", 0, b'5'));
        out.extend(header("./file.txt", 5, b'0'));
        out.extend(b"hello");
        out.extend([0u8; 507]);
        out.extend(header("./big.bin", 1024, b'0'));
        out.extend(vec![0xabu8; 1024]);
        out.extend([0u8; TAR_BLOCK * 2]);
        out
    }

    #[test]
    fn tar_listing_parses_files_and_sizes() {
        let mut p = TarListing::new();
        let bytes = archive();
        for chunk in bytes.chunks(257) {
            p.feed(chunk);
        }
        assert!(p.done());
        assert_eq!(
            p.files,
            vec![
                SnapshotTreeFile {
                    path: "./dir/".into(),
                    size: 0
                },
                SnapshotTreeFile {
                    path: "./file.txt".into(),
                    size: 5
                },
                SnapshotTreeFile {
                    path: "./big.bin".into(),
                    size: 1024
                },
            ]
        );
    }

    #[test]
    fn tar_listing_ends_on_zero_block_even_without_terminator() {
        // Some producers omit the double-zero terminator; a single zero header
        // must still stop the parse.
        let mut p = TarListing::new();
        p.feed(&header("./a", 0, b'0'));
        p.feed(&[0u8; TAR_BLOCK]);
        assert!(p.done());
        assert_eq!(p.files.len(), 1);
    }

    #[test]
    fn name_and_size_fields_parse() {
        assert_eq!(tar_name(b"./x.txt\0rest"), "./x.txt");
        assert_eq!(tar_octal(b"0000000012\0"), 10);
        assert_eq!(tar_octal(b"             "), 0);
        assert_eq!(tar_octal(&[0u8; 12]), 0);
    }
}
