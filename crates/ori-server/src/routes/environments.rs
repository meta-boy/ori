//! Environment routes: `GET/POST /environments[/{name}]` plus the mutation
//! sub-routes (`vars`, `files`, `repos`, `set`, `upgrade`).
//!
//! Every mutation here mints a **new version** — it never edits an existing
//! one (see `crate::env`). Secret values never appear in a response or a log
//! line: secret vars/files are redacted to `null` content and nothing here
//! logs bundle contents.

use axum::extract::{Extension, Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::auth::ApiKeyAuth;
use crate::env::{self, EnvironmentDto, UpgradeReport};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentList {
    pub environments: Vec<EnvironmentDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentResponse {
    pub environment: EnvironmentDto,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateEnvRequest {
    pub name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameEnvRequest {
    pub new_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetVarRequest {
    pub key: String,
    pub value: String,
    #[serde(default)]
    pub secret: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetFileRequest {
    pub path: String,
    pub content: String,
    #[serde(default)]
    pub secret: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddRepoRequest {
    pub url: String,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetToggleRequest {
    pub toggle: String,
    pub on: bool,
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

pub async fn list_envs(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
) -> ApiResult<Json<EnvironmentList>> {
    let rows = env::list_envs(&state.db, &auth.account_id).await?;
    let mut environments = Vec::with_capacity(rows.len());
    for row in rows {
        environments.push(env::dto_for_env(&state.db, &row).await?);
    }
    Ok(Json(EnvironmentList { environments }))
}

pub async fn get_env(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
    Path(name): Path<String>,
) -> ApiResult<Json<EnvironmentResponse>> {
    let row = fetch_env(&state, &auth.account_id, &name).await?;
    let dto = env::dto_for_env(&state.db, &row).await?;
    Ok(Json(EnvironmentResponse { environment: dto }))
}

pub async fn create_env(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
    Json(req): Json<CreateEnvRequest>,
) -> ApiResult<(StatusCode, Json<EnvironmentResponse>)> {
    let row = env::create_env(&state.db, &auth.account_id, &req.name).await?;
    let dto = env::dto_for_env(&state.db, &row).await?;
    Ok((
        StatusCode::CREATED,
        Json(EnvironmentResponse { environment: dto }),
    ))
}

pub async fn rename_env(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
    Path(name): Path<String>,
    Json(req): Json<RenameEnvRequest>,
) -> ApiResult<Json<EnvironmentResponse>> {
    let row = env::rename_env(&state.db, &auth.account_id, &name, &req.new_name).await?;
    let dto = env::dto_for_env(&state.db, &row).await?;
    Ok(Json(EnvironmentResponse { environment: dto }))
}

pub async fn set_default(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
    Path(name): Path<String>,
) -> ApiResult<Json<EnvironmentResponse>> {
    let row = env::set_default(&state.db, &auth.account_id, &name).await?;
    let dto = env::dto_for_env(&state.db, &row).await?;
    Ok(Json(EnvironmentResponse { environment: dto }))
}

pub async fn delete_env(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
    Path(name): Path<String>,
) -> ApiResult<Json<serde_json::Value>> {
    env::delete_env(&state.db, &auth.account_id, &name).await?;
    Ok(Json(serde_json::json!({ "deleted": true, "name": name })))
}

/// `POST /environments/{name}/set` — toggle a safety toggle. Mints a version.
pub async fn set_toggle(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
    Path(name): Path<String>,
    Json(req): Json<SetToggleRequest>,
) -> ApiResult<Json<EnvironmentResponse>> {
    env::set_toggle(&state.db, &auth.account_id, &name, &req.toggle, req.on).await?;
    let row = fetch_env(&state, &auth.account_id, &name).await?;
    let dto = env::dto_for_env(&state.db, &row).await?;
    Ok(Json(EnvironmentResponse { environment: dto }))
}

/// `POST /environments/{name}/vars` — set (or update) a var. Mints a version.
pub async fn set_var(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
    Path(name): Path<String>,
    Json(req): Json<SetVarRequest>,
) -> ApiResult<Json<EnvironmentResponse>> {
    env::set_var(
        &state.db,
        &auth.account_id,
        &name,
        &req.key,
        &req.value,
        req.secret,
    )
    .await?;
    let row = fetch_env(&state, &auth.account_id, &name).await?;
    let dto = env::dto_for_env(&state.db, &row).await?;
    Ok(Json(EnvironmentResponse { environment: dto }))
}

/// `DELETE /environments/{name}/vars/{key}` — remove a var. Mints a version.
pub async fn rm_var(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
    Path((name, key)): Path<(String, String)>,
) -> ApiResult<Json<EnvironmentResponse>> {
    env::rm_var(&state.db, &auth.account_id, &name, &key).await?;
    let row = fetch_env(&state, &auth.account_id, &name).await?;
    let dto = env::dto_for_env(&state.db, &row).await?;
    Ok(Json(EnvironmentResponse { environment: dto }))
}

/// `POST /environments/{name}/files` — store a file's contents. Mints a version.
pub async fn set_file(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
    Path(name): Path<String>,
    Json(req): Json<SetFileRequest>,
) -> ApiResult<Json<EnvironmentResponse>> {
    env::set_file(
        &state.db,
        &auth.account_id,
        &name,
        &req.path,
        &req.content,
        req.secret,
    )
    .await?;
    let row = fetch_env(&state, &auth.account_id, &name).await?;
    let dto = env::dto_for_env(&state.db, &row).await?;
    Ok(Json(EnvironmentResponse { environment: dto }))
}

/// `DELETE /environments/{name}/files/{path}` — remove a file. Mints a version.
pub async fn rm_file(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
    Path((name, path)): Path<(String, String)>,
) -> ApiResult<Json<EnvironmentResponse>> {
    env::rm_file(&state.db, &auth.account_id, &name, &path).await?;
    let row = fetch_env(&state, &auth.account_id, &name).await?;
    let dto = env::dto_for_env(&state.db, &row).await?;
    Ok(Json(EnvironmentResponse { environment: dto }))
}

/// `POST /environments/{name}/repos` — add a repo checkout. Mints a version.
pub async fn add_repo(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
    Path(name): Path<String>,
    Json(req): Json<AddRepoRequest>,
) -> ApiResult<Json<EnvironmentResponse>> {
    env::add_repo(
        &state.db,
        &auth.account_id,
        &name,
        &req.url,
        req.branch.as_deref(),
        req.path.as_deref(),
    )
    .await?;
    let row = fetch_env(&state, &auth.account_id, &name).await?;
    let dto = env::dto_for_env(&state.db, &row).await?;
    Ok(Json(EnvironmentResponse { environment: dto }))
}

/// `DELETE /environments/{name}/repos/{url}` — remove a repo. Mints a version.
pub async fn rm_repo(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
    Path((name, url)): Path<(String, String)>,
) -> ApiResult<Json<EnvironmentResponse>> {
    env::rm_repo(&state.db, &auth.account_id, &name, &url).await?;
    let row = fetch_env(&state, &auth.account_id, &name).await?;
    let dto = env::dto_for_env(&state.db, &row).await?;
    Ok(Json(EnvironmentResponse { environment: dto }))
}

/// `POST /environments/{name}/upgrade` — move sandboxes onto the latest
/// version. Running sandboxes get the new claim pushed; secrets removed by the
/// upgrade are withheld.
pub async fn upgrade(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
    Path(name): Path<String>,
) -> ApiResult<Json<UpgradeReport>> {
    let report = env::upgrade(&state, &auth.account_id, &name).await?;
    Ok(Json(report))
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async fn fetch_env(
    state: &AppState,
    account_id: &str,
    name: &str,
) -> ApiResult<env::EnvironmentRow> {
    env::get_env(&state.db, account_id, name)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("environment {name:?}")))
}
