//! Route table. All paths are under `/api/v1` (the base the client uses).

use axum::routing::{delete, get, post};
use axum::Router;

use crate::state::AppState;

mod account;
mod ai;
mod login;
mod operations;
mod sandboxes;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/v1/me", get(account::me))
        .route("/api/v1/limits", get(account::limits))
        .route("/api/v1/teams", get(account::teams))
        .route(
            "/api/v1/sandboxes",
            post(sandboxes::create_sandbox).get(sandboxes::list_sandboxes),
        )
        .route(
            "/api/v1/sandboxes/{id}",
            get(sandboxes::get_sandbox).delete(sandboxes::delete_sandbox),
        )
        .route("/api/v1/sandboxes/{id}/stop", post(sandboxes::stop_sandbox))
        .route("/api/v1/sandboxes/{id}/resume", post(sandboxes::resume_sandbox))
        .route("/api/v1/sandboxes/{id}/fork", post(sandboxes::fork_sandbox))
        .route("/api/v1/sandboxes/{id}/extend", post(sandboxes::extend_sandbox))
        .route("/api/v1/sandboxes/{id}/exec", post(sandboxes::exec_sandbox))
        .route("/api/v1/sandboxes/{id}/exec/{pid}", get(sandboxes::exec_status))
        .route("/api/v1/sandboxes/{id}/prompt", post(ai::prompt_sandbox))
        .route("/api/v1/sandboxes/{id}/interrupt", post(ai::interrupt_sandbox))
        .route("/api/v1/sandboxes/{id}/events", get(ai::events_sandbox))
        .route("/api/v1/operations/{id}", get(operations::get_operation))
        .route(
            "/api/v1/api-keys",
            get(account::list_api_keys).post(account::create_api_key),
        )
        .route("/api/v1/api-keys/{id}/revoke", post(account::revoke_api_key))
        .route("/api/v1/cli/login/start", post(login::login_start))
        .route("/api/v1/cli/login/{id}/approve", post(login::login_approve))
        .route("/api/v1/cli/login/poll/{id}", get(login::login_poll))
        .route("/api/v1/cli/version", get(login::cli_version))
        .with_state(state)
}