//! Route table. All paths are under `/api/v1` (the base the client uses).
//!
//! Auth: everything except device login and the version check sits behind the
//! bearer-key middleware. Key creation is its own unauthenticated bootstrap
//! route (it checks the bearer token itself when one is present).

use axum::middleware;
use axum::routing::{delete, get, post};
use axum::Router;

use crate::auth;
use crate::state::AppState;

mod account;
mod ai;
mod dashboard;
pub(crate) mod data_retention;
mod environments;
mod login;
mod operations;
mod sandboxes;
mod snapshots;
pub mod webhook;

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
        .route("/api/v1/sandboxes/:id/ports", post(crate::proxy::host_port))
        // Raw TCP splice: the transport under ssh, scp and forward.
        .route(
            "/api/v1/sandboxes/:id/tcp/:port",
            get(crate::tunnel::tcp_splice),
        )
        .route(
            "/api/v1/sandboxes/:id/sshkey",
            post(crate::tunnel::authorize_ssh_key),
        )
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
        .route(
            "/api/v1/webhooks",
            get(webhook::list_webhooks).post(webhook::create_webhook),
        )
        .route("/api/v1/webhooks/:id/rotate", post(webhook::rotate_webhook))
        .route("/api/v1/webhooks/:id/remove", post(webhook::remove_webhook))
        .route(
            "/api/v1/account/data-retention",
            get(data_retention::status).post(data_retention::enable),
        )
        .route(
            "/api/v1/snapshots",
            get(snapshots::list_snapshots).post(snapshots::save_snapshot),
        )
        .route(
            "/api/v1/snapshots/:id",
            get(snapshots::get_snapshot).delete(snapshots::delete_snapshot),
        )
        .route("/api/v1/snapshots/:id/tree", get(snapshots::snapshot_tree))
        .route("/api/v1/snapshots/:id/pull", get(snapshots::pull_snapshot))
        .route(
            "/api/v1/named-snapshots",
            get(snapshots::list_named_snapshots),
        )
        .route(
            "/api/v1/named-snapshots/:name",
            delete(snapshots::rm_named_snapshot),
        )
        .route("/api/v1/api-keys", get(account::list_api_keys))
        .route("/api/v1/api-keys/:id/rotate", post(account::rotate_api_key))
        .route("/api/v1/api-keys/:id/revoke", post(account::revoke_api_key))
        .route(
            "/api/v1/environments",
            get(environments::list_envs).post(environments::create_env),
        )
        .route(
            "/api/v1/environments/:name",
            get(environments::get_env).delete(environments::delete_env),
        )
        .route(
            "/api/v1/environments/:name/rename",
            post(environments::rename_env),
        )
        .route(
            "/api/v1/environments/:name/default",
            post(environments::set_default),
        )
        .route(
            "/api/v1/environments/:name/set",
            post(environments::set_toggle),
        )
        .route(
            "/api/v1/environments/:name/vars",
            post(environments::set_var),
        )
        .route(
            "/api/v1/environments/:name/vars/:key",
            delete(environments::rm_var),
        )
        .route(
            "/api/v1/environments/:name/files",
            post(environments::set_file),
        )
        .route(
            "/api/v1/environments/:name/files/*path",
            delete(environments::rm_file),
        )
        .route(
            "/api/v1/environments/:name/repos",
            post(environments::add_repo),
        )
        .route(
            "/api/v1/environments/:name/repos/*url",
            delete(environments::rm_repo),
        )
        .route(
            "/api/v1/environments/:name/upgrade",
            post(environments::upgrade),
        )
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_auth,
        ));

    Router::new()
        .route("/api/v1/cli/login/start", post(login::login_start))
        .route("/api/v1/cli/login/:id/approve", post(login::login_approve))
        .route("/api/v1/cli/login/poll/:id", get(login::login_poll))
        .route("/api/v1/cli/version", get(login::cli_version))
        // the control-plane dashboard; unauthenticated like the login flow,
        // and matched before the hosted-port fallback
        .route("/dashboard", get(dashboard::page))
        // the agent tunnel authenticates with a per-sandbox token, not an
        // account key, so it sits outside the bearer middleware
        .route("/api/v1/agent/tunnel", get(crate::tunnel::agent_tunnel))
        // key creation lives outside the middleware: it is the bootstrap path
        // and checks the bearer token itself when one is present
        .route("/api/v1/api-keys", post(account::create_api_key))
        .merge(protected)
        // Anything that is not an API path is a hosted-port request,
        // resolved by the sandbox slug in the Host header. API routes are
        // matched first, so this cannot shadow them.
        .fallback(crate::proxy::proxy)
        .with_state(state)
}
