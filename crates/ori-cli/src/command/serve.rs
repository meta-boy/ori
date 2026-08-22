//! `ori serve` — the control-plane role of the single binary.

use std::path::PathBuf;

use crate::cli::ServeArgs;
use crate::context::Ctx;
use crate::error::CliError;

pub async fn serve(args: ServeArgs, _ctx: &Ctx) -> Result<(), CliError> {
    let mut cfg = ori_server::config::Config::from_env();
    if let Ok(addr) = args.bind.parse() {
        cfg.listen_addr = addr;
    }
    cfg.database_path = PathBuf::from(&args.db_path);
    cfg.domain = args.domain.clone();
    cfg.provider = args.provider.into();
    cfg.pool_depth = args.pool_depth;

    // tracing for the control plane (mirrors the old standalone binary). The
    // global default is `ori_server=info` so a bare `ori serve` is quiet but
    // the reconciler's drift demotions are visible.
    let filter = std::env::var("RUST_LOG").unwrap_or_else(|_| "ori_server=info".to_string());
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .try_init();

    // run() returns on shutdown or a fatal startup error (bind failure,
    // provider preflight failure, missing ORI_PVE_* config). Surface it as a
    // local error so the exit code is 1 and the message is on stderr.
    ori_server::run(cfg)
        .await
        .map_err(|e| CliError::usage(format!("serve: {e}")))
}
