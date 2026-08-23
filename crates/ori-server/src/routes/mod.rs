//! Route table. All paths are under `/api/v1` (the base the client uses).
//!
//! Auth: everything except device login and the version check sits behind the
//! bearer-key middleware. Key creation is its own unauthenticated bootstrap
//! route (it checks the bearer token itself when one is present).

use axum::middleware;
use axum::routing::{get, post};
use axum::Router;

use crate::auth;
use crate::state::AppState;

mod account;
mod ai;
mod login;
mod operations;
mod sandboxes;

pub fn router(state: AppState) -> Router {
    let protected = Router::new()
        .route(
            "/api/v1/sandboxes",
            post(sandboxes::create_sandbox).get(sandboxes::list_sandboxes),
        )
        .route(
            "/api/v1/sandboxes/:id",
            get(sandboxes::get_sandbox).delete(sandboxes::delete_sandbox),
        )
        .route("/api/v1/sandboxes/:id/stop", post(sandboxes::stop_sandbox))
        .route(
            "/api/v1/sandboxes/:id/resume",
            post(sandboxes::resume_sandbox),
        )
        .route("/api/v1/sandboxes/:id/fork", post(sandboxes::fork_sandbox))
        .route(
            "/api/v1/sandboxes/:id/extend",
            post(sandboxes::extend_sandbox),
        )
        .route("/api/v1/sandboxes/:id/exec", post(sandboxes::exec_sandbox))
        .route(
            "/api/v1/sandboxes/:id/exec/:pid",
            get(sandboxes::exec_status),
        )
        .route("/api/v1/sandboxes/:id/prompt", post(ai::prompt_sandbox))
        .route(
            "/api/v1/sandboxes/:id/interrupt",
            post(ai::interrupt_sandbox),
        )
        .route("/api/v1/sandboxes/:id/events", get(ai::events_sandbox))
        .route("/api/v1/operations/:id", get(operations::get_operation))
        .route("/api/v1/me", get(account::me))
        .route("/api/v1/teams", get(account::teams))
        .route("/api/v1/api-keys", get(account::list_api_keys))
        .route("/api/v1/api-keys/:id/rotate", post(account::rotate_api_key))
        .route("/api/v1/api-keys/:id/revoke", post(account::revoke_api_key))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_auth,
        ));

    Router::new()
        .route("/api/v1/cli/login/start", post(login::login_start))
        .route("/api/v1/cli/login/:id/approve", post(login::login_approve))
        .route("/api/v1/cli/login/poll/:id", get(login::login_poll))
        .route("/api/v1/cli/version", get(login::cli_version))
        // the agent tunnel authenticates with a per-sandbox token, not an
        // account key, so it sits outside the bearer middleware
        .route("/api/v1/agent/tunnel", get(crate::tunnel::agent_tunnel))
        // key creation lives outside the middleware: it is the bootstrap path
        // and checks the bearer token itself when one is present
        .route("/api/v1/api-keys", post(account::create_api_key))
        .merge(protected)
        .with_state(state)
}
