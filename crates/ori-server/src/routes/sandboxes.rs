//! Sandbox lifecycle routes. `create` / `resume` / `fork` stream NDJSON and
//! must be flushed per line; the work runs on a spawned task so the response
//! reaches the client before the operation completes. Errors that happen
//! after the stream starts are terminal events on the stream, not status
//! changes — the HTTP status is long gone by then.

use axum::body::Bytes;
use axum::extract::{Extension, Path, Query, State};
use axum::http::StatusCode;
use axum::response::Response;
use axum::Json;
use serde::Deserialize;
use tokio::sync::mpsc;

use crate::auth::ApiKeyAuth;
use crate::error::{ApiError, ApiResult};
use crate::ndjson::ndjson_response;
use crate::pool::{ClaimResult, PoolKey};
use crate::proto::{
    BoxState, Commands, CreateSandboxRequest, ExecRequest, ExecRequestBody, ExecResponse,
    ExecResult, ExtendResponse, ExtendSandboxRequest, ForkSandboxRequest, HostCapacity,
    InstanceHandle, InstanceSpec, MachineType, PageInfo, ResumeSandboxRequest, Sandbox,
    SandboxDetail, SandboxList, SnapshotRef, StopMode, StopSandboxRequest, StreamEvent, TypedId,
};
use crate::repo::{self, SandboxRow};
use crate::slug;
use crate::state::AppState;
use crate::util::{after_seconds, default_name, now_ts};

const FORK_DEFAULT_TTL_SECONDS: i64 = 3600;

fn sandbox_url(domain: &str, slug: &str) -> String {
    format!("https://{slug}.{domain}")
}

fn commands_for(id: &str) -> Commands {
    Commands {
        ssh: format!("ori ssh {id}"),
        forward: format!("ori forward {id} --remote 3000"),
    }
}

fn emit(tx: &mpsc::UnboundedSender<Bytes>, ev: StreamEvent) -> bool {
    tx.send(Bytes::from(ev.to_line())).is_ok()
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

pub async fn create_sandbox(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
    Json(req): Json<CreateSandboxRequest>,
) -> ApiResult<Response> {
    let machine_type = req.machine_type.unwrap_or(MachineType::Default);
    let environment = req
        .environment
        .clone()
        .unwrap_or_else(|| "base".to_string());

    if req.from_snapshot.is_some() {
        return Err(ApiError::invalid_request(
            "creating from a snapshot is not implemented in this build",
        ));
    }

    // Host capacity guard, not a per-account quota: `new` is refused when the
    // host cannot take another sandbox (thin-pool headroom after the warm-pool
    // footprint, and free memory) for the requested machine type. The check is
    // synchronous so the refusal is a 409, not an error event on the stream.
    guard_host_capacity(&state, machine_type).await?;

    let (tx, rx) = mpsc::unbounded_channel();
    let state2 = state.clone();
    let account_id = auth.0.account_id;
    tokio::spawn(async move {
        run_create(state2, account_id, req, machine_type, environment, tx).await;
    });
    Ok(ndjson_response(rx, StatusCode::OK))
}

async fn run_create(
    state: AppState,
    account_id: String,
    req: CreateSandboxRequest,
    machine_type: MachineType,
    environment: String,
    tx: mpsc::UnboundedSender<Bytes>,
) {
    let ttl = if req.no_auto_stop.unwrap_or(false) {
        None
    } else {
        Some(req.ttl_seconds.unwrap_or(state.config.default_ttl_seconds))
    };
    let stop_after = ttl.map(after_seconds);
    let id = TypedId::sandbox().to_string();
    let name = req.name.clone().unwrap_or_else(default_name);
    let no_env = req.no_env.unwrap_or(false);
    let env_vars = req.env.clone().unwrap_or_default();

    let slug = match insert_with_slug(
        &state,
        &account_id,
        &id,
        &name,
        machine_type,
        &environment,
        no_env,
        stop_after.as_deref(),
        req.team.as_deref(),
        "",
    )
    .await
    {
        Ok(s) => s,
        Err(e) => {
            let _ = emit(
                &tx,
                StreamEvent::Error {
                    id: id.clone(),
                    code: "internal".into(),
                    message: e.message,
                },
            );
            return;
        }
    };

    if !emit(
        &tx,
        StreamEvent::Created {
            id: id.clone(),
            ttl_seconds: ttl,
            team: req.team.clone(),
        },
    ) {
        return;
    }
    if !emit(
        &tx,
        StreamEvent::State {
            id: id.clone(),
            state: "provisioning".into(),
        },
    ) {
        return;
    }
    let _ = repo::transition(&state.db, &id, &["init"], BoxState::Provisioning).await;

    let spec = InstanceSpec {
        id: id.clone(),
        name: name.clone(),
        machine_type,
        environment: environment.clone(),
        environment_version: 1,
        env_vars,
    };

    // Warm pool first: a claim hands over a pre-started, already-running
    // instance, so `ori new` returns in ~0.9 s instead of ~9.2 s. Claim is the
    // only pool call on a request path — one atomic `UPDATE ... RETURNING`, no
    // cloning on this path. A miss or a failed claim falls through to the cold
    // path below.
    if let Some(pool) = &state.pool {
        let key = PoolKey {
            provider: state.provider.name().to_string(),
            machine_type,
            environment_version: spec.environment_version,
        };
        match pool.claim(&key, &id).await {
            Ok(ClaimResult::Hit(slot)) => {
                tracing::info!(
                    sandbox = %id, key = %key.key_string(), slot = %slot.slot_id,
                    "create: pool claim"
                );
                let _ = repo::set_provider_handle(&state.db, &id, &slot.instance_handle.id).await;
                if !emit(
                    &tx,
                    StreamEvent::State {
                        id: id.clone(),
                        state: "ready".into(),
                    },
                ) {
                    return;
                }
                let _ = repo::transition(&state.db, &id, &["provisioning"], BoxState::Ready).await;
                finish_ready(
                    &state,
                    &tx,
                    &id,
                    &slot.instance_handle,
                    &slug,
                    stop_after,
                    req.setup_script.as_deref(),
                )
                .await;
                return;
            }
            Ok(ClaimResult::Miss) => {
                tracing::info!(
                    sandbox = %id, key = %key.key_string(),
                    "create: pool miss, taking the cold path"
                );
            }
            Err(e) => {
                tracing::warn!(
                    sandbox = %id, key = %key.key_string(), error = %e,
                    "create: pool claim failed, taking the cold path"
                );
            }
        }
    }

    // Cold path. `cloning` is emitted before `create` so a pool miss shows up
    // in the NDJSON stream rather than as a silent ~9 s pause.
    if !emit(
        &tx,
        StreamEvent::State {
            id: id.clone(),
            state: "cloning".into(),
        },
    ) {
        return;
    }
    let _ = repo::transition(&state.db, &id, &["provisioning"], BoxState::Cloning).await;

    let handle = match state.provider.create(&spec).await {
        Ok(h) => h,
        Err(e) => {
            tracing::warn!(sandbox = %id, error = %e, "create: provider create failed");
            let _ = repo::set_state(&state.db, &id, BoxState::Error).await;
            crate::routes::webhook::emit(&state, &id, "error").await;
            let _ = emit(
                &tx,
                StreamEvent::Error {
                    id: id.clone(),
                    code: "provider_unavailable".into(),
                    message: e.to_string(),
                },
            );
            return;
        }
    };
    // provider_handle stores the provider-scoped id only; the provider name
    // lives in its own column. Storing the combined "provider:id" display
    // string breaks handle reconstruction and the reconciler's drift check.
    let _ = repo::set_provider_handle(&state.db, &id, &handle.id).await;

    if !emit(
        &tx,
        StreamEvent::State {
            id: id.clone(),
            state: "ready".into(),
        },
    ) {
        return;
    }
    let _ = repo::transition(&state.db, &id, &["cloning"], BoxState::Ready).await;

    finish_ready(
        &state,
        &tx,
        &id,
        &handle,
        &slug,
        stop_after,
        req.setup_script.as_deref(),
    )
    .await;
}

/// Shared tail of the create path: resolve the instance addresses, persist
/// them, and emit the terminal `ready` event. Used by both the pool-claim and
/// cold-create paths so they cannot drift apart.
async fn finish_ready(
    state: &AppState,
    tx: &mpsc::UnboundedSender<Bytes>,
    id: &str,
    handle: &InstanceHandle,
    slug: &str,
    stop_after: Option<String>,
    setup_script: Option<&str>,
) {
    let addr = state.provider.addresses(handle).await.ok();
    let ip = addr.as_ref().and_then(|a| a.ip.clone());
    let desktop_url = addr.as_ref().and_then(|a| a.desktop_url.clone());
    let url = sandbox_url(&state.config.domain, slug);
    let _ = repo::set_instance_addresses(
        &state.db,
        id,
        ip.as_deref(),
        Some(&url),
        desktop_url.as_deref(),
    )
    .await;
    // a setup script is accepted and reported as run (the mock runs nothing)
    if setup_script.is_some() {
        let _ = repo::set_setup_status(&state.db, id, "done", None).await;
    }

    let _ = emit(
        tx,
        StreamEvent::Ready {
            id: id.to_string(),
            state: "ready".into(),
            ip,
            url: Some(url),
            desktop_url,
            stop_after,
            commands: commands_for(id),
        },
    );
    crate::routes::webhook::emit(state, id, "ready").await;
}

/// Insert the sandbox row, retrying on a slug collision. The uniqueness
/// constraint is the arbiter, not the generator.
async fn insert_with_slug(
    state: &AppState,
    account_id: &str,
    id: &str,
    name: &str,
    machine_type: MachineType,
    environment: &str,
    no_env: bool,
    stop_after: Option<&str>,
    team: Option<&str>,
    provider_handle: &str,
) -> Result<String, ApiError> {
    for _ in 0..5 {
        let candidate = repo::NewSandbox {
            id: id.to_string(),
            account_id: account_id.to_string(),
            name: name.to_string(),
            state: BoxState::Init,
            machine_type,
            slug: slug::slug(),
            provider: state.provider.name().to_string(),
            provider_handle: provider_handle.to_string(),
            environment: environment.to_string(),
            environment_version: 1,
            no_env,
            stop_after: stop_after.map(|s| s.to_string()),
            team: team.map(|s| s.to_string()),
        };
        let candidate_slug = candidate.slug.clone();
        match repo::insert_sandbox(&state.db, &candidate).await {
            Ok(()) => return Ok(candidate_slug),
            Err(e) if repo::is_unique_violation(&e) => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Err(ApiError::internal("could not allocate a unique slug"))
}

// ---------------------------------------------------------------------------
// list / info
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct ListParams {
    #[serde(default = "default_filter")]
    filter: String,
    limit: Option<u32>,
    cursor: Option<String>,
}

fn default_filter() -> String {
    "r".to_string()
}

pub async fn list_sandboxes(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
    Query(params): Query<ListParams>,
) -> ApiResult<Json<SandboxList>> {
    let letters =
        crate::proto::states_for_filter(&params.filter).map_err(ApiError::invalid_request)?;
    let states = repo::state_names_for_letters(&letters);
    let limit = params.limit.unwrap_or(50).clamp(1, 200);
    let offset: u32 = params
        .cursor
        .as_deref()
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    let (rows, has_more) =
        repo::list_sandboxes(&state.db, &auth.account_id, &states, limit, offset).await?;
    let sandboxes: Vec<Sandbox> = rows.iter().map(|r| r.to_sandbox()).collect();
    let next_cursor = if has_more {
        Some((offset + limit).to_string())
    } else {
        None
    };
    Ok(Json(SandboxList {
        sandboxes,
        page_info: PageInfo {
            has_more,
            limit,
            next_cursor,
        },
    }))
}

pub async fn get_sandbox(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
    Path(id): Path<String>,
) -> ApiResult<Json<SandboxDetail>> {
    let row = fetch(&state, &id, &auth.account_id).await?;
    Ok(Json(SandboxDetail {
        sandbox: row.to_sandbox(),
    }))
}

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

pub async fn stop_sandbox(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
    Path(id): Path<String>,
    body: Option<Json<StopSandboxRequest>>,
) -> ApiResult<Json<SandboxDetail>> {
    let row = fetch(&state, &id, &auth.account_id).await?;
    let current = row.state_enum();

    // idempotent: stop on a stopped/stopping sandbox is a no-op, not an error
    if matches!(current, BoxState::Stopped | BoxState::Stopping) {
        return Ok(Json(SandboxDetail {
            sandbox: row.to_sandbox(),
        }));
    }
    if !current.can_transition_to(BoxState::Stopping) {
        return Err(ApiError::invalid_transition(current.as_str(), "stopping"));
    }

    let force = body.map(|b| b.force).unwrap_or(false);
    if !repo::transition(&state.db, &id, &[current.as_str()], BoxState::Stopping).await? {
        // another request moved it; report current truth
        let fresh = repo::get_sandbox(&state.db, &id, &auth.account_id).await?;
        return Ok(Json(SandboxDetail {
            sandbox: fresh.unwrap_or(row).to_sandbox(),
        }));
    }

    let handle = InstanceHandle {
        provider: row.provider.clone(),
        id: row.provider_handle.clone(),
    };
    // C12: power off first, then snapshot while the container is stopped.
    // The provider's `Snapshot` stop mode snapshots *before* powering off —
    // a running-taken snapshot is permanently ~20x slower to clone from
    // (docs/BENCHMARKS.md §Root cause) — so `stop` uses `Force` (plain power
    // off) and the server snapshots afterwards. Every stopped sandbox then
    // carries a fast-cloneable snapshot for `fork` for free.
    if let Err(e) = state.provider.stop(&handle, StopMode::Force).await {
        let _ = repo::set_state(&state.db, &id, BoxState::Error).await;
        return Err(ApiError::provider_unavailable(e.to_string()));
    }
    // `--force` and delete-on-stop (data retention) both skip the snapshot:
    // with retention enabled there is deliberately nothing to restore from.
    if !force && !crate::routes::data_retention::retention_enabled(&state, &row.account_id).await {
        if let Ok(snap) = state
            .provider
            .snapshot(&handle, &crate::util::snapshot_name("stop"))
            .await
        {
            let _ =
                repo::insert_snapshot(&state.db, &row.account_id, &id, "stop", &snap.name, true)
                    .await;
        }
    }
    repo::set_state(&state.db, &id, BoxState::Stopped).await?;
    let fresh = repo::get_sandbox(&state.db, &id, &auth.account_id).await?;
    Ok(Json(SandboxDetail {
        sandbox: fresh.unwrap_or(row).to_sandbox(),
    }))
}

// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------

pub async fn resume_sandbox(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
    Path(id): Path<String>,
    body: Option<Json<ResumeSandboxRequest>>,
) -> ApiResult<Response> {
    let row = fetch(&state, &id, &auth.account_id).await?;
    let current = row.state_enum();
    if !current.can_transition_to(BoxState::Provisioning) {
        return Err(ApiError::invalid_transition(
            current.as_str(),
            "provisioning",
        ));
    }
    let (tx, rx) = mpsc::unbounded_channel();
    let state2 = state.clone();
    let req = body.map(|b| b.0).unwrap_or(ResumeSandboxRequest {
        machine_type: None,
        ttl_seconds: None,
        no_auto_stop: None,
        env: None,
        no_env: None,
        environment: None,
    });
    tokio::spawn(async move {
        run_resume(state2, row, req, tx).await;
    });
    Ok(ndjson_response(rx, StatusCode::OK))
}

async fn run_resume(
    state: AppState,
    row: SandboxRow,
    req: ResumeSandboxRequest,
    tx: mpsc::UnboundedSender<Bytes>,
) {
    let id = row.id.clone();
    if !emit(
        &tx,
        StreamEvent::Accepted {
            id: id.clone(),
            status: "resuming".into(),
        },
    ) {
        return;
    }
    if !emit(
        &tx,
        StreamEvent::State {
            id: id.clone(),
            state: "provisioning".into(),
        },
    ) {
        return;
    }
    let _ = repo::transition(&state.db, &id, &["stopped"], BoxState::Provisioning).await;

    let handle = InstanceHandle {
        provider: row.provider.clone(),
        id: row.provider_handle.clone(),
    };
    if let Err(e) = state.provider.start(&handle).await {
        // If the provider lost the instance the correct fallback is
        // clone_from(latest_snapshot) — never rollback. Snapshots are not
        // wired up in this build, so the honest answer is an error.
        tracing::warn!(sandbox = %id, error = %e, "resume: provider start failed");
        let _ = repo::set_state(&state.db, &id, BoxState::Error).await;
        crate::routes::webhook::emit(&state, &id, "error").await;
        let _ = emit(
            &tx,
            StreamEvent::Error {
                id: id.clone(),
                code: "provider_unavailable".into(),
                message: format!("instance lost and no snapshot is available in this build: {e}"),
            },
        );
        return;
    }

    if !emit(
        &tx,
        StreamEvent::State {
            id: id.clone(),
            state: "ready".into(),
        },
    ) {
        return;
    }
    let _ = repo::transition(&state.db, &id, &["provisioning"], BoxState::Ready).await;

    // `--no-env` is one-way: once set, resume cannot reintroduce secrets.
    if !row.no_env && req.no_env.unwrap_or(false) {
        let _ = repo::set_no_env(&state.db, &id, true).await;
    }
    let new_stop_after = if req.no_auto_stop == Some(true) {
        Some(None)
    } else {
        req.ttl_seconds.map(|ttl| Some(after_seconds(ttl)))
    };
    if let Some(v) = new_stop_after {
        let _ = repo::set_stop_after(&state.db, &id, v.as_deref()).await;
    }

    let addr = state.provider.addresses(&handle).await.ok();
    let ip = addr.as_ref().and_then(|a| a.ip.clone());
    let desktop_url = addr.as_ref().and_then(|a| a.desktop_url.clone());
    let url = Some(sandbox_url(&state.config.domain, &row.slug));
    let _ = repo::set_instance_addresses(
        &state.db,
        &id,
        ip.as_deref(),
        url.as_deref(),
        desktop_url.as_deref(),
    )
    .await;

    let stop_after = repo::get_sandbox(&state.db, &id, &row.account_id)
        .await
        .ok()
        .flatten()
        .and_then(|r| r.stop_after);

    let _ = emit(
        &tx,
        StreamEvent::Ready {
            id: id.clone(),
            state: "ready".into(),
            ip,
            url,
            desktop_url,
            stop_after,
            commands: commands_for(&id),
        },
    );
    crate::routes::webhook::emit(&state, &id, "ready").await;
}

// ---------------------------------------------------------------------------
// fork
// ---------------------------------------------------------------------------

pub async fn fork_sandbox(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
    Path(id): Path<String>,
    body: Option<Json<ForkSandboxRequest>>,
) -> ApiResult<Response> {
    let row = fetch(&state, &id, &auth.account_id).await?;
    let current = row.state_enum();
    if !matches!(
        current,
        BoxState::Ready | BoxState::Running | BoxState::Idle | BoxState::Stopped
    ) {
        return Err(ApiError::conflict(format!(
            "cannot fork a sandbox in state {}",
            current.as_str()
        )));
    }
    let (tx, rx) = mpsc::unbounded_channel();
    let state2 = state.clone();
    let account_id = auth.0.account_id;
    let req = body.map(|b| b.0).unwrap_or(ForkSandboxRequest {
        machine_type: None,
        name: None,
        ttl_seconds: None,
        no_auto_stop: None,
        env: None,
        no_env: None,
        environment: None,
        team: None,
        no_stop: None,
    });
    tokio::spawn(async move {
        run_fork(state2, account_id, row, req, tx).await;
    });
    Ok(ndjson_response(rx, StatusCode::ACCEPTED))
}

async fn run_fork(
    state: AppState,
    account_id: String,
    source: SandboxRow,
    req: ForkSandboxRequest,
    tx: mpsc::UnboundedSender<Bytes>,
) {
    let machine_type = req.machine_type.unwrap_or(source.machine_enum());
    let environment = req
        .environment
        .clone()
        .unwrap_or(source.environment.clone());
    let ttl = if req.no_auto_stop.unwrap_or(false) {
        None
    } else {
        // fork TTL defaults to 1 h and is never inherited
        Some(req.ttl_seconds.unwrap_or(FORK_DEFAULT_TTL_SECONDS))
    };
    let stop_after = ttl.map(after_seconds);
    let child_id = TypedId::sandbox().to_string();
    let name = req.name.clone().unwrap_or_else(default_name);
    let no_env = source.no_env || req.no_env.unwrap_or(false);
    let env_vars = req.env.clone().unwrap_or_default();

    let slug = match insert_with_slug(
        &state,
        &account_id,
        &child_id,
        &name,
        machine_type,
        &environment,
        no_env,
        stop_after.as_deref(),
        req.team.as_deref(),
        "",
    )
    .await
    {
        Ok(s) => s,
        Err(e) => {
            let _ = emit(
                &tx,
                StreamEvent::Error {
                    id: child_id.clone(),
                    code: "internal".into(),
                    message: e.message,
                },
            );
            return;
        }
    };

    if !emit(
        &tx,
        StreamEvent::Created {
            id: child_id.clone(),
            ttl_seconds: ttl,
            team: req.team.clone(),
        },
    ) {
        return;
    }
    if !emit(
        &tx,
        StreamEvent::State {
            id: child_id.clone(),
            state: "provisioning".into(),
        },
    ) {
        return;
    }
    let _ = repo::transition(&state.db, &child_id, &["init"], BoxState::Provisioning).await;

    let source_handle = InstanceHandle {
        provider: source.provider.clone(),
        id: source.provider_handle.clone(),
    };
    // C12: never snapshot a running source. A snapshot taken while the
    // container is running is permanently ~20x slower to clone from, so fork
    // clones from the newest snapshot that was taken while the source was
    // **stopped** — the one `stop`/the TTL reaper already produced.
    let source_running = matches!(
        source.state_enum(),
        BoxState::Ready | BoxState::Running | BoxState::Idle
    );
    let snap = match repo::latest_stopped_snapshot(&state.db, &source.id).await {
        Ok(Some(provider_snapshot)) => {
            let snap = SnapshotRef {
                provider: source.provider.clone(),
                name: provider_snapshot,
            };
            if source_running {
                // Reusing the last stopped snapshot omits writes made since
                // that stop. That is a real semantic difference and must be
                // stated, not hidden — a fork that silently drops recent work
                // is worse than a slow fork.
                let _ = emit(
                    &tx,
                    StreamEvent::Notice {
                        id: child_id.clone(),
                        message: format!(
                            "forked from the snapshot taken when {} was last stopped; \
                             writes made since that stop are not in this fork",
                            source.id
                        ),
                    },
                );
            }
            snap
        }
        // No stopped-taken snapshot. A fresh snapshot of a *stopped* source is
        // safe (taken while stopped, fast to clone from). A running source is
        // the common case — create, work, fork — and cannot be snapshot cheaply,
        // so fork stops it, snapshots it stopped, restarts it, then clones.
        // `--no-stop` keeps the old refusal for anyone who cannot take the
        // downtime.
        _ => {
            if source_running {
                if req.no_stop.unwrap_or(false) {
                    let _ = repo::set_state(&state.db, &child_id, BoxState::Error).await;
                    crate::routes::webhook::emit(&state, &child_id, "error").await;
                    let _ = emit(
                        &tx,
                        StreamEvent::Error {
                            id: child_id.clone(),
                            code: "invalid_request".into(),
                            message: format!(
                                "cannot fork a running sandbox that has no stopped snapshot \
                                 (--no-stop): fork refuses rather than stopping {} to take a \
                                 fast snapshot (it would be restarted afterwards). Omit \
                                 --no-stop, or stop the source first (`ori stop {}`), then fork",
                                source.id, source.id
                            ),
                        },
                    );
                    return;
                }
                match stop_snapshot_restart_for_fork(&state, &source, &tx, &child_id).await {
                    Ok(s) => s,
                    Err((code, message)) => {
                        let _ = repo::set_state(&state.db, &child_id, BoxState::Error).await;
                        crate::routes::webhook::emit(&state, &child_id, "error").await;
                        let _ = emit(
                            &tx,
                            StreamEvent::Error {
                                id: child_id.clone(),
                                code,
                                message,
                            },
                        );
                        return;
                    }
                }
            } else {
                match state
                    .provider
                    .snapshot(&source_handle, &crate::util::snapshot_name("fork"))
                    .await
                {
                    Ok(s) => {
                        let _ = repo::insert_snapshot(
                            &state.db,
                            &source.account_id,
                            &source.id,
                            "fork",
                            &s.name,
                            true,
                        )
                        .await;
                        s
                    }
                    Err(e) => {
                        let _ = repo::set_state(&state.db, &child_id, BoxState::Error).await;
                        let _ = emit(
                            &tx,
                            StreamEvent::Error {
                                id: child_id.clone(),
                                code: "provider_unavailable".into(),
                                message: e.to_string(),
                            },
                        );
                        return;
                    }
                }
            }
        }
    };

    let spec = InstanceSpec {
        id: child_id.clone(),
        name,
        machine_type,
        environment: environment.clone(),
        environment_version: source.environment_version,
        env_vars,
    };
    let handle = match crate::proto::Provider::clone_from(&*state.provider, &snap, &spec).await {
        Ok(h) => h,
        Err(e) => {
            tracing::warn!(sandbox = %child_id, error = %e, "fork: clone_from failed");
            let _ = repo::set_state(&state.db, &child_id, BoxState::Error).await;
            crate::routes::webhook::emit(&state, &child_id, "error").await;
            let _ = emit(
                &tx,
                StreamEvent::Error {
                    id: child_id.clone(),
                    code: "provider_unavailable".into(),
                    message: e.to_string(),
                },
            );
            return;
        }
    };
    let _ = repo::set_provider_handle(&state.db, &child_id, &handle.id).await;

    // `clone_from` leaves the clone **stopped** on real providers (linked
    // clones are created stopped); fork must start it before reporting ready,
    // or the reconciler demotes the child to `error` on the next pass.
    if let Err(e) = state.provider.start(&handle).await {
        tracing::warn!(sandbox = %child_id, error = %e, "fork: start clone failed");
        let _ = repo::set_state(&state.db, &child_id, BoxState::Error).await;
        crate::routes::webhook::emit(&state, &child_id, "error").await;
        let _ = emit(
            &tx,
            StreamEvent::Error {
                id: child_id.clone(),
                code: "provider_unavailable".into(),
                message: format!("fork: cannot start clone: {e}"),
            },
        );
        return;
    }

    if !emit(
        &tx,
        StreamEvent::State {
            id: child_id.clone(),
            state: "cloning".into(),
        },
    ) {
        return;
    }
    let _ = repo::transition(&state.db, &child_id, &["provisioning"], BoxState::Cloning).await;
    if !emit(
        &tx,
        StreamEvent::State {
            id: child_id.clone(),
            state: "ready".into(),
        },
    ) {
        return;
    }
    let _ = repo::transition(&state.db, &child_id, &["cloning"], BoxState::Ready).await;

    let addr = state.provider.addresses(&handle).await.ok();
    let ip = addr.as_ref().and_then(|a| a.ip.clone());
    let desktop_url = addr.as_ref().and_then(|a| a.desktop_url.clone());
    let url = sandbox_url(&state.config.domain, &slug);
    let _ = repo::set_instance_addresses(
        &state.db,
        &child_id,
        ip.as_deref(),
        Some(&url),
        desktop_url.as_deref(),
    )
    .await;

    let _ = emit(
        &tx,
        StreamEvent::Ready {
            id: child_id.clone(),
            state: "ready".into(),
            ip,
            url: Some(url),
            desktop_url,
            stop_after,
            commands: commands_for(&child_id),
        },
    );
    crate::routes::webhook::emit(&state, &child_id, "ready").await;
}

/// C24: the common path — create, work, fork. A running source that has never
/// been stopped carries no stopped-taken snapshot, and a fresh snapshot of a
/// live container is permanently ~20x slower to clone from. So fork stops the
/// source, snapshots it while stopped (the fast-cloneable kind), restarts it,
/// then returns the snapshot for the caller to clone. Two rules are load
/// bearing:
///
/// - The downtime is **announced on the stream before the stop**, because a
///   user whose shell drops mid-fork with no warning reads it as a crash.
/// - The source is **restarted before cloning**, so a failed fork — a failed
///   clone, a failed snapshot, a failed stop — never leaves the user's sandbox
///   powered off. Every path out of this function has the source back up.
///
/// Returns `Err((code, message))` for the terminal stream event; the source
/// has been restarted in that case too.
async fn stop_snapshot_restart_for_fork(
    state: &AppState,
    source: &SandboxRow,
    tx: &mpsc::UnboundedSender<Bytes>,
    child_id: &str,
) -> Result<SnapshotRef, (String, String)> {
    // Announce the downtime BEFORE it happens. A client that is gone by now
    // gets no fork and the source stays up — nobody is listening to be warned,
    // so stopping a running sandbox on their behalf would be a surprise.
    if !emit(
        tx,
        StreamEvent::Notice {
            id: child_id.to_string(),
            message: format!(
                "{} has never been stopped, so it has no fast snapshot; \
                 stopping it for a moment to take one for this fork, then restarting it",
                source.id
            ),
        },
    ) {
        return Err(("internal".into(), "client disconnected".into()));
    }

    let handle = InstanceHandle {
        provider: source.provider.clone(),
        id: source.provider_handle.clone(),
    };

    // Stop the source. The DB is moved to `stopping` first so the reconciler
    // never sees a `ready` sandbox the provider reports as stopped.
    let _ = repo::transition(
        &state.db,
        &source.id,
        &["ready", "running", "idle"],
        BoxState::Stopping,
    )
    .await;
    if let Err(e) = state.provider.stop(&handle, StopMode::Force).await {
        // The stop may have half-applied; bring the source back up regardless
        // before reporting the fork failed.
        restart_source_after_fork(state, source).await;
        return Err((
            "provider_unavailable".into(),
            format!("fork: cannot stop {} to snapshot it: {e}", source.id),
        ));
    }
    let _ = repo::set_state(&state.db, &source.id, BoxState::Stopped).await;

    // Snapshot while stopped — the fast-cloneable kind.
    let snap = match state
        .provider
        .snapshot(&handle, &crate::util::snapshot_name("fork"))
        .await
    {
        Ok(s) => {
            let _ = repo::insert_snapshot(
                &state.db,
                &source.account_id,
                &source.id,
                "fork",
                &s.name,
                true,
            )
            .await;
            s
        }
        Err(e) => {
            restart_source_after_fork(state, source).await;
            return Err((
                "provider_unavailable".into(),
                format!("fork: cannot snapshot {}: {e}", source.id),
            ));
        }
    };

    // Restart the source before the caller clones from the snapshot: the clone
    // only needs the snapshot, and restarting first means the source is back up
    // even if the clone itself fails.
    restart_source_after_fork(state, source).await;
    Ok(snap)
}

/// Start the source and move it back to `ready`. On a provider failure the
/// sandbox is marked `error` rather than silently left powered off. Used by
/// the fork path, which must never leave the source down.
async fn restart_source_after_fork(state: &AppState, source: &SandboxRow) {
    let handle = InstanceHandle {
        provider: source.provider.clone(),
        id: source.provider_handle.clone(),
    };
    let _ = repo::set_state(&state.db, &source.id, BoxState::Provisioning).await;
    match state.provider.start(&handle).await {
        Ok(()) => {
            let _ = repo::set_state(&state.db, &source.id, BoxState::Ready).await;
        }
        Err(e) => {
            tracing::warn!(sandbox = %source.id, error = %e, "fork: restarting source failed");
            let _ = repo::set_state(&state.db, &source.id, BoxState::Error).await;
        }
    }
}

// ---------------------------------------------------------------------------
// extend
// ---------------------------------------------------------------------------

pub async fn extend_sandbox(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
    Path(id): Path<String>,
    body: Option<Json<ExtendSandboxRequest>>,
) -> ApiResult<Json<ExtendResponse>> {
    let row = fetch(&state, &id, &auth.account_id).await?;
    let req = body.map(|b| b.0).unwrap_or(ExtendSandboxRequest {
        hours: None,
        ttl_seconds: None,
        no_auto_stop: None,
    });
    // The deadline is computed up front so a past deadline is refused before
    // anything is written — `extend` can move the deadline later, never back.
    let stop_after = if req.no_auto_stop == Some(true) {
        None
    } else if let Some(h) = req.hours {
        Some(deadline_after(&id, h.saturating_mul(3600))?)
    } else if let Some(t) = req.ttl_seconds {
        Some(deadline_after(&id, t)?)
    } else {
        return Err(ApiError::invalid_request(
            "one of hours, ttlSeconds, noAutoStop is required",
        ));
    };
    repo::set_stop_after(&state.db, &id, stop_after.as_deref()).await?;
    let fresh = repo::get_sandbox(&state.db, &id, &auth.account_id).await?;
    Ok(Json(ExtendResponse {
        sandbox: fresh.unwrap_or(row).to_sandbox(),
        stop_after,
    }))
}

/// The RFC3339 deadline `secs` from now, refusing a deadline in the past.
fn deadline_after(id: &str, secs: i64) -> ApiResult<String> {
    if secs <= 0 {
        return Err(ApiError::invalid_request(format!(
            "cannot extend {id}: {secs}s from now would put the auto-stop deadline in the past"
        )));
    }
    Ok(after_seconds(secs))
}

// ---------------------------------------------------------------------------
// exec
// ---------------------------------------------------------------------------

pub async fn exec_sandbox(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
    Path(id): Path<String>,
    Json(req): Json<ExecRequestBody>,
) -> ApiResult<Json<ExecResponse>> {
    let row = fetch(&state, &id, &auth.account_id).await?;
    let current = row.state_enum();
    if !matches!(
        current,
        BoxState::Ready | BoxState::Running | BoxState::Idle
    ) {
        return Err(ApiError::conflict("sandbox is not running"));
    }
    if req.cmd.is_empty() {
        return Err(ApiError::invalid_request("cmd must not be empty"));
    }
    if let Some(t) = req.timeout_secs {
        if !(1..=600).contains(&t) {
            return Err(ApiError::invalid_request(
                "timeoutSecs must be between 1 and 600",
            ));
        }
    }
    let exec_req = ExecRequest {
        cmd: req.cmd,
        cwd: req.cwd,
        timeout_secs: req.timeout_secs,
        env: req.env.unwrap_or_default(),
    };
    let handle = InstanceHandle {
        provider: row.provider.clone(),
        id: row.provider_handle.clone(),
    };

    // Prefer the agent tunnel: it is a persistent connection, where the
    // provider path pays an SSH handshake on every call. `None` means this
    // sandbox has no live tunnel, which is a fallback signal and not an error —
    // the response shape is identical either way, so a caller can only tell by
    // latency.
    let tunnelled = state
        .agents
        .exec(
            &id,
            &exec_req.cmd,
            exec_req.cwd.as_deref(),
            exec_req.timeout_secs,
            false,
        )
        .await;

    let result = match tunnelled {
        Some(frame) => {
            // The agent answers a rejected exec with an `error` frame carrying a
            // code and a message. Mapping that through `unwrap_or` defaults
            // would fabricate a success-shaped reply (exit -1, empty stdout)
            // and throw away the only useful diagnostic, so surface it.
            if frame.get("type").and_then(|v| v.as_str()) == Some("error") {
                let code = frame
                    .get("code")
                    .and_then(|v| v.as_str())
                    .unwrap_or("agent_error");
                let message = frame
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("agent rejected the request");
                return Err(ApiError::invalid_request(format!(
                    "agent: {code}: {message}"
                )));
            }
            // Anything that is not an execResult is a protocol mismatch, not a
            // command that exited -1. Say so rather than inventing a result.
            let kind = frame.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if kind != "execResult" {
                return Err(ApiError::internal(format!(
                    "agent returned unexpected frame {kind:?} for exec"
                )));
            }
            let g = |k: &str| frame.get(k).cloned().unwrap_or(serde_json::Value::Null);
            ExecResult {
                pid: g("pid").as_i64().unwrap_or(0),
                completed: g("completed").as_bool().unwrap_or(false),
                exit_code: g("exitCode").as_i64().unwrap_or(-1),
                stdout: g("stdout").as_str().unwrap_or_default().to_string(),
                stderr: g("stderr").as_str().unwrap_or_default().to_string(),
                duration_ms: g("durationMs").as_i64().unwrap_or(0),
            }
        }
        None => state
            .provider
            .exec(&handle, &exec_req)
            .await
            .map_err(|e| ApiError::provider_unavailable(e.to_string()))?,
    };

    let process_id = TypedId::process().to_string();
    let started = now_ts();
    let status = if result.completed && result.exit_code == 0 {
        "completed"
    } else {
        "failed"
    };
    sqlx::query(
        "INSERT INTO processes (id, account_id, sandbox_id, pid, status, exit_code, cmd, stdout, stderr, started_at, completed_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&process_id)
    .bind(&auth.account_id)
    .bind(&id)
    .bind(result.pid)
    .bind(status)
    .bind(result.exit_code)
    .bind(serde_json::to_string(&exec_req.cmd).unwrap_or_default())
    .bind(&result.stdout)
    .bind(&result.stderr)
    .bind(&started)
    .bind(&started)
    .execute(&state.db)
    .await?;

    Ok(Json(ExecResponse {
        pid: result.pid,
        completed: result.completed,
        exit_code: result.exit_code,
        stdout: result.stdout,
        stderr: result.stderr,
        duration_ms: result.duration_ms,
    }))
}

/// `GET /sandboxes/{id}/exec/{pid}` — poll a detached process (`ori exec --status`).
pub async fn exec_status(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
    Path((id, pid)): Path<(String, i64)>,
) -> ApiResult<Json<ExecResponse>> {
    let _row = fetch(&state, &id, &auth.account_id).await?;
    #[derive(sqlx::FromRow)]
    struct ProcRow {
        pid: i64,
        status: String,
        exit_code: Option<i64>,
        stdout: Option<String>,
        stderr: Option<String>,
    }
    let row = sqlx::query_as::<_, ProcRow>(
        "SELECT pid, status, exit_code, stdout, stderr FROM processes \
         WHERE sandbox_id = ? AND pid = ? AND account_id = ?",
    )
    .bind(&id)
    .bind(pid)
    .bind(&auth.account_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| ApiError::not_found(format!("process {pid} on sandbox {id}")))?;

    let (_state_name, completed) = match row.status.as_str() {
        "completed" => ("exited", true),
        "failed" => ("failed", true),
        "killed" => ("failed", true),
        _ => ("running", false),
    };
    Ok(Json(ExecResponse {
        pid: row.pid,
        completed,
        exit_code: row.exit_code.unwrap_or(0),
        stdout: row.stdout.unwrap_or_default(),
        stderr: row.stderr.unwrap_or_default(),
        duration_ms: 0,
    }))
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

pub async fn delete_sandbox(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
    Path(id): Path<String>,
) -> ApiResult<Json<crate::proto::OperationDetail>> {
    let _row = fetch(&state, &id, &auth.account_id).await?;
    let op = crate::deletion::start_delete(&state, &id, &auth.account_id).await?;
    Ok(Json(crate::proto::OperationDetail {
        operation: op.to_operation(),
    }))
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

async fn fetch(state: &AppState, id: &str, account_id: &str) -> ApiResult<SandboxRow> {
    repo::get_sandbox(&state.db, id, account_id)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("sandbox {id}")))
}

/// Refuse `new` when the host cannot take another sandbox. Reuses the
/// `scripts/preflight.sh` §6 arithmetic rather than inventing a second notion
/// of "full": headroom is `storage_avail - pool_depth * slot_gb` (the warm
/// pool's footprint), and free memory is checked against the machine type's
/// RAM. Both must fit or the refusal names which resource is short.
async fn guard_host_capacity(state: &AppState, machine_type: MachineType) -> ApiResult<()> {
    let cap: HostCapacity = state.provider.capacity().await.map_err(|e| {
        // Fail closed: unable to prove the host can take another sandbox is
        // the same as unable to (the leaked-container incident is what this
        // guard exists for).
        ApiError::provider_unavailable(format!("cannot check host capacity: {e}"))
    })?;
    let slot_gb = state.config.pool_slot_gb as f64;
    let pool_footprint = state.config.pool_depth as f64 * slot_gb;
    let headroom_gb = cap.storage_avail_gb - pool_footprint;
    let need_mem = machine_type.memory_gb() as f64;

    let mut short: Vec<String> = Vec::new();
    if headroom_gb < slot_gb {
        short.push(format!(
            "thin-pool storage: {headroom_gb:.1} GB headroom after the {}-slot warm-pool footprint, need {slot_gb:.0} GB for one sandbox",
            state.config.pool_depth
        ));
    }
    if cap.free_memory_gb < need_mem {
        short.push(format!(
            "memory: {:.1} GB free on the host, need {need_mem:.0} GB for a {} sandbox",
            cap.free_memory_gb,
            machine_type.as_str()
        ));
    }
    if short.is_empty() {
        return Ok(());
    }
    Err(ApiError::capacity_exceeded(format!(
        "host cannot take another sandbox: {}",
        short.join("; ")
    )))
}
