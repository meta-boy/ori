//! Sandbox lifecycle routes. `create` / `resume` / `fork` stream NDJSON and
//! must be flushed per line; the work runs on a spawned task so the response
//! reaches the client before the operation completes. Errors that happen
//! after the stream starts are terminal events on the stream, not status
//! changes — the HTTP status is long gone by then.

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde::Deserialize;
use tokio::sync::mpsc;

use crate::auth::ApiKeyAuth;
use crate::error::{ApiError, ApiResult};
use crate::ndjson::ndjson_response;
use crate::proto::{
    BoxState, Commands, CreateSandboxRequest, ExecRequest, ExecRequestBody, ExecResponse,
    ExtendSandboxRequest, ForkSandboxRequest, InstanceHandle, InstanceSpec, MachineType,
    PageInfo, ResumeSandboxRequest, Sandbox, SandboxDetail, SandboxList, StopMode,
    StopSandboxRequest, StreamEvent, TypedId,
};
use crate::repo::{self, SandboxRow};
use crate::slug;
use crate::state::AppState;
use crate::util::{after_seconds, default_name, now_ts};

const MAX_TOTAL_SANDBOXES: i64 = 20;
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
    auth: ApiKeyAuth,
    Json(req): Json<CreateSandboxRequest>,
) -> ApiResult<Response> {
    let machine_type = req.machine_type.unwrap_or(MachineType::Default);
    let environment = req.environment.clone().unwrap_or_else(|| "base".to_string());

    if req.from.is_some() {
        return Err(ApiError::invalid_request(
            "creating from a snapshot is not implemented in this build",
        ));
    }

    let (_, total) = repo::counts(&state.db, &auth.account_id).await?;
    if total >= MAX_TOTAL_SANDBOXES {
        return Err(ApiError::quota_exceeded(format!(
            "plan allows at most {MAX_TOTAL_SANDBOXES} sandboxes; you have {total}"
        )));
    }

    let (tx, rx) = mpsc::unbounded_channel();
    let state2 = state.clone();
    tokio::spawn(async move {
        run_create(state2, auth.account_id, req, machine_type, environment, tx).await;
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
            let _ = emit(&tx, StreamEvent::Error {
                id: id.clone(),
                code: "internal".into(),
                message: e.message,
            });
            return;
        }
    };

    if !emit(&tx, StreamEvent::Created { id: id.clone(), ttl_seconds: ttl, team: req.team.clone() }) {
        return;
    }
    if !emit(&tx, StreamEvent::State { id: id.clone(), state: "provisioning".into() }) {
        return;
    }
    let _ = repo::transition(&state.db, &id, &["init"], BoxState::Provisioning).await;

    let spec = InstanceSpec {
        name: name.clone(),
        machine_type,
        environment: environment.clone(),
        environment_version: 1,
        env_vars,
    };
    let handle = match state.provider.create(&spec).await {
        Ok(h) => h,
        Err(e) => {
            let _ = repo::set_state(&state.db, &id, BoxState::Error).await;
            let _ = emit(&tx, StreamEvent::Error {
                id: id.clone(),
                code: "provider_unavailable".into(),
                message: e.to_string(),
            });
            return;
        }
    };
    let _ = repo::set_provider_handle(&state.db, &id, &handle.to_string()).await;

    if !emit(&tx, StreamEvent::State { id: id.clone(), state: "cloning".into() }) {
        return;
    }
    let _ = repo::transition(&state.db, &id, &["provisioning"], BoxState::Cloning).await;
    if !emit(&tx, StreamEvent::State { id: id.clone(), state: "ready".into() }) {
        return;
    }
    let _ = repo::transition(&state.db, &id, &["cloning"], BoxState::Ready).await;

    let addr = state.provider.addresses(&handle).await.ok();
    let ip = addr.as_ref().and_then(|a| a.ip.clone());
    let desktop_url = addr.as_ref().and_then(|a| a.desktop_url.clone());
    let url = sandbox_url(&state.config.domain, &slug);
    let _ = repo::set_instance_addresses(
        &state.db,
        &id,
        ip.as_deref(),
        Some(&url),
        desktop_url.as_deref(),
    )
    .await;

    let _ = emit(&tx, StreamEvent::Ready {
        id: id.clone(),
        state: "ready".into(),
        ip,
        url: Some(url),
        desktop_url,
        stop_after,
        commands: commands_for(&id),
    });
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
struct ListParams {
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
    auth: ApiKeyAuth,
    Query(params): Query<ListParams>,
) -> ApiResult<Json<SandboxList>> {
    let letters =
        crate::proto::states_for_filter(&params.filter).map_err(ApiError::invalid_request)?;
    let states = repo::state_names_for_letters(&letters);
    let limit = params.limit.unwrap_or(50).clamp(1, 200);
    let offset: u32 = params.cursor.parse().unwrap_or(0);
    let (rows, has_more) =
        repo::list_sandboxes(&state.db, &auth.account_id, &states, limit, offset).await?;
    let sandboxes: Vec<Sandbox> = rows.iter().map(|r| r.to_sandbox()).collect();
    let next_cursor = if has_more { Some((offset + limit).to_string()) } else { None };
    Ok(Json(SandboxList {
        sandboxes,
        page_info: PageInfo { has_more, limit, next_cursor },
    }))
}

pub async fn get_sandbox(
    State(state): State<AppState>,
    auth: ApiKeyAuth,
    Path(id): Path<String>,
) -> ApiResult<Json<SandboxDetail>> {
    let row = fetch(&state, &id, &auth.account_id).await?;
    Ok(Json(SandboxDetail { sandbox: row.to_sandbox() }))
}

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

pub async fn stop_sandbox(
    State(state): State<AppState>,
    auth: ApiKeyAuth,
    Path(id): Path<String>,
    body: Option<Json<StopSandboxRequest>>,
) -> ApiResult<Json<SandboxDetail>> {
    let row = fetch(&state, &id, &auth.account_id).await?;
    let current = row.state_enum();

    // idempotent: stop on a stopped/stopping sandbox is a no-op, not an error
    if matches!(current, BoxState::Stopped | BoxState::Stopping) {
        return Ok(Json(SandboxDetail { sandbox: row.to_sandbox() }));
    }
    if !current.can_transition_to(BoxState::Stopping) {
        return Err(ApiError::invalid_transition(current.as_str(), "stopping"));
    }

    let force = body.map(|b| b.force).unwrap_or(false);
    if !repo::transition(&state.db, &id, &[current.as_str()], BoxState::Stopping).await? {
        // another request moved it; report current truth
        let fresh = repo::get_sandbox(&state.db, &id, &auth.account_id).await?;
        return Ok(Json(SandboxDetail { sandbox: fresh.unwrap_or(row).to_sandbox() }));
    }

    let handle = InstanceHandle { provider: row.provider.clone(), id: row.provider_handle.clone() };
    if !force {
        // v1: snapshots are not persisted; the provider still captures one so
        // a real backend keeps data-preserving semantics.
        let _ = state.provider.snapshot(&handle, "autostop").await;
    }
    let mode = if force { StopMode::Force } else { StopMode::Snapshot };
    if let Err(e) = state.provider.stop(&handle, mode).await {
        let _ = repo::set_state(&state.db, &id, BoxState::Error).await;
        return Err(ApiError::provider_unavailable(e.to_string()));
    }
    repo::set_state(&state.db, &id, BoxState::Stopped).await?;
    let fresh = repo::get_sandbox(&state.db, &id, &auth.account_id).await?;
    Ok(Json(SandboxDetail { sandbox: fresh.unwrap_or(row).to_sandbox() }))
}

// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------

pub async fn resume_sandbox(
    State(state): State<AppState>,
    auth: ApiKeyAuth,
    Path(id): Path<String>,
    body: Option<Json<ResumeSandboxRequest>>,
) -> ApiResult<Response> {
    let row = fetch(&state, &id, &auth.account_id).await?;
    let current = row.state_enum();
    if !current.can_transition_to(BoxState::Provisioning) {
        return Err(ApiError::invalid_transition(current.as_str(), "provisioning"));
    }
    let (tx, rx) = mpsc::unbounded_channel();
    let state2 = state.clone();
    let req = body
        .map(|b| b.0)
        .unwrap_or(ResumeSandboxRequest {
            machine_type: None,
            ttl_seconds: None,
            no_auto_stop: None,
            env: None,
            no_env: None,
            environment: None,
        });
    tokio::spawn(async move { run_resume(state2, row, req, tx).await; });
    Ok(ndjson_response(rx, StatusCode::OK))
}

async fn run_resume(
    state: AppState,
    row: SandboxRow,
    req: ResumeSandboxRequest,
    tx: mpsc::UnboundedSender<Bytes>,
) {
    let id = row.id.clone();
    if !emit(&tx, StreamEvent::Accepted { id: id.clone(), status: "resuming".into() }) {
        return;
    }
    if !emit(&tx, StreamEvent::State { id: id.clone(), state: "provisioning".into() }) {
        return;
    }
    let _ = repo::transition(&state.db, &id, &["stopped"], BoxState::Provisioning).await;

    let handle = InstanceHandle { provider: row.provider.clone(), id: row.provider_handle.clone() };
    if let Err(e) = state.provider.start(&handle).await {
        // If the provider lost the instance the correct fallback is
        // clone_from(latest_snapshot) — never rollback. Snapshots are not
        // wired up in this build, so the honest answer is an error.
        let _ = repo::set_state(&state.db, &id, BoxState::Error).await;
        let _ = emit(&tx, StreamEvent::Error {
            id: id.clone(),
            code: "provider_unavailable".into(),
            message: format!("instance lost and no snapshot is available in this build: {e}"),
        });
        return;
    }

    if !emit(&tx, StreamEvent::State { id: id.clone(), state: "ready".into() }) {
        return;
    }
    let _ = repo::transition(&state.db, &id, &["provisioning"], BoxState::Ready).await;

    // `--no-env` is one-way: once set, resume cannot reintroduce secrets.
    if !row.no_env && req.no_env.unwrap_or(false) {
        let _ = repo::set_no_env(&state.db, &id, true).await;
    }
    let new_stop_after = if req.no_auto_stop == Some(true) {
        Some(None)
    } else if let Some(ttl) = req.ttl_seconds {
        Some(Some(after_seconds(ttl)))
    } else {
        None
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

    let _ = emit(&tx, StreamEvent::Ready {
        id: id.clone(),
        state: "ready".into(),
        ip,
        url,
        desktop_url,
        stop_after,
        commands: commands_for(&id),
    });
}

// ---------------------------------------------------------------------------
// fork
// ---------------------------------------------------------------------------

pub async fn fork_sandbox(
    State(state): State<AppState>,
    auth: ApiKeyAuth,
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
    let req = body
        .map(|b| b.0)
        .unwrap_or(ForkSandboxRequest {
            machine_type: None,
            name: None,
            ttl_seconds: None,
            no_auto_stop: None,
            env: None,
            no_env: None,
            environment: None,
            team: None,
        });
    tokio::spawn(async move { run_fork(state2, auth.account_id, row, req, tx).await; });
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
    let environment = req.environment.clone().unwrap_or(source.environment.clone());
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
            let _ = emit(&tx, StreamEvent::Error {
                id: child_id.clone(),
                code: "internal".into(),
                message: e.message,
            });
            return;
        }
    };

    if !emit(&tx, StreamEvent::Created { id: child_id.clone(), ttl_seconds: ttl, team: req.team.clone() }) {
        return;
    }
    if !emit(&tx, StreamEvent::State { id: child_id.clone(), state: "provisioning".into() }) {
        return;
    }
    let _ = repo::transition(&state.db, &child_id, &["init"], BoxState::Provisioning).await;

    let source_handle =
        InstanceHandle { provider: source.provider.clone(), id: source.provider_handle.clone() };
    let snap = match state.provider.snapshot(&source_handle, "fork").await {
        Ok(s) => s,
        Err(e) => {
            let _ = repo::set_state(&state.db, &child_id, BoxState::Error).await;
            let _ = emit(&tx, StreamEvent::Error {
                id: child_id.clone(),
                code: "provider_unavailable".into(),
                message: e.to_string(),
            });
            return;
        }
    };

    let spec = InstanceSpec {
        name,
        machine_type,
        environment: environment.clone(),
        environment_version: source.environment_version,
        env_vars,
    };
    let handle = match state.provider.clone_from(&snap, &spec).await {
        Ok(h) => h,
        Err(e) => {
            let _ = repo::set_state(&state.db, &child_id, BoxState::Error).await;
            let _ = emit(&tx, StreamEvent::Error {
                id: child_id.clone(),
                code: "provider_unavailable".into(),
                message: e.to_string(),
            });
            return;
        }
    };
    let _ = repo::set_provider_handle(&state.db, &child_id, &handle.to_string()).await;

    if !emit(&tx, StreamEvent::State { id: child_id.clone(), state: "cloning".into() }) {
        return;
    }
    let _ = repo::transition(&state.db, &child_id, &["provisioning"], BoxState::Cloning).await;
    if !emit(&tx, StreamEvent::State { id: child_id.clone(), state: "ready".into() }) {
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

    let _ = emit(&tx, StreamEvent::Ready {
        id: child_id.clone(),
        state: "ready".into(),
        ip,
        url: Some(url),
        desktop_url,
        stop_after,
        commands: commands_for(&child_id),
    });
}

// ---------------------------------------------------------------------------
// extend
// ---------------------------------------------------------------------------

pub async fn extend_sandbox(
    State(state): State<AppState>,
    auth: ApiKeyAuth,
    Path(id): Path<String>,
    body: Option<Json<ExtendSandboxRequest>>,
) -> ApiResult<Json<SandboxDetail>> {
    let row = fetch(&state, &id, &auth.account_id).await?;
    let req = body.map(|b| b.0).unwrap_or(ExtendSandboxRequest {
        hours: None,
        ttl_seconds: None,
        no_auto_stop: None,
    });
    if req.no_auto_stop == Some(true) {
        repo::set_stop_after(&state.db, &id, None).await?;
    } else if let Some(h) = req.hours {
        repo::set_stop_after(&state.db, &id, Some(&after_seconds(h.saturating_mul(3600)))).await?;
    } else if let Some(t) = req.ttl_seconds {
        repo::set_stop_after(&state.db, &id, Some(&after_seconds(t))).await?;
    } else {
        return Err(ApiError::invalid_request(
            "one of hours, ttlSeconds, noAutoStop is required",
        ));
    }
    let fresh = repo::get_sandbox(&state.db, &id, &auth.account_id).await?;
    Ok(Json(SandboxDetail { sandbox: fresh.unwrap_or(row).to_sandbox() }))
}

// ---------------------------------------------------------------------------
// exec
// ---------------------------------------------------------------------------

pub async fn exec_sandbox(
    State(state): State<AppState>,
    auth: ApiKeyAuth,
    Path(id): Path<String>,
    Json(req): Json<ExecRequestBody>,
) -> ApiResult<Json<ExecResponse>> {
    let row = fetch(&state, &id, &auth.account_id).await?;
    let current = row.state_enum();
    if !matches!(current, BoxState::Ready | BoxState::Running | BoxState::Idle) {
        return Err(ApiError::conflict("sandbox is not running"));
    }
    if req.cmd.is_empty() {
        return Err(ApiError::invalid_request("cmd must not be empty"));
    }
    if let Some(t) = req.timeout_secs {
        if !(1..=600).contains(&t) {
            return Err(ApiError::invalid_request("timeoutSecs must be between 1 and 600"));
        }
    }
    let exec_req = ExecRequest {
        cmd: req.cmd,
        cwd: req.cwd,
        timeout_secs: req.timeout_secs,
        env: req.env.unwrap_or_default(),
    };
    let handle =
        InstanceHandle { provider: row.provider.clone(), id: row.provider_handle.clone() };
    let result = state
        .provider
        .exec(&handle, &exec_req)
        .await
        .map_err(|e| ApiError::provider_unavailable(e.to_string()))?;

    let process_id = TypedId::process().to_string();
    let started = now_ts();
    let status = if result.completed && result.exit_code == 0 { "completed" } else { "failed" };
    sqlx::query(
        "INSERT INTO processes (id, account_id, sandbox_id, status, exit_code, cmd, stdout, stderr, started_at, completed_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&process_id)
    .bind(&auth.account_id)
    .bind(&id)
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

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

pub async fn delete_sandbox(
    State(state): State<AppState>,
    auth: ApiKeyAuth,
    Path(id): Path<String>,
) -> ApiResult<Json<crate::proto::OperationDetail>> {
    let _row = fetch(&state, &id, &auth.account_id).await?;
    let op = crate::deletion::start_delete(&state, &id, &auth.account_id).await?;
    Ok(Json(crate::proto::OperationDetail { operation: op.to_operation() }))
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

async fn fetch(state: &AppState, id: &str, account_id: &str) -> ApiResult<SandboxRow> {
    repo::get_sandbox(&state.db, id, account_id)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("sandbox {id}")))
}