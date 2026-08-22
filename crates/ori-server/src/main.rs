//! `ori-server` binary. In the workspace this crate is the control plane for
//! `ori serve`; the standalone binary here runs the same server for dev.

use clap::{Args, Parser, Subcommand};

#[derive(Parser)]
#[command(name = "ori-server", about = "ori control plane", version)]
struct Cli {
    #[command(subcommand)]
    cmd: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run the control-plane HTTP server (default).
    Serve(ServeArgs),
}

#[derive(Args)]
struct ServeArgs {
    /// Address to bind. `ORI_LISTEN`
    #[arg(long, env = "ORI_LISTEN", default_value = "127.0.0.1:8080")]
    bind: String,
    /// SQLite database path. `ORI_DB_PATH`
    #[arg(long, env = "ORI_DB_PATH", default_value = "./ori.db")]
    db_path: String,
    /// Domain used to mint `<slug>.<domain>` URLs. `ORI_DOMAIN`
    #[arg(long, env = "ORI_DOMAIN", default_value = "ori.localhost")]
    domain: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let filter = std::env::var("RUST_LOG").unwrap_or_else(|_| "ori_server=info".to_string());
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .init();

    let cli = Cli::parse();
    let args = match cli.cmd {
        Some(Command::Serve(args)) => args,
        None => ServeArgs {
            bind: "127.0.0.1:8080".into(),
            db_path: "./ori.db".into(),
            domain: "ori.localhost".into(),
        },
    };

    let mut cfg = ori_server::config::Config::from_env();
    if let Ok(addr) = args.bind.parse() {
        cfg.listen_addr = addr;
    }
    cfg.database_path = args.db_path.into();
    cfg.domain = args.domain;

    ori_server::run(cfg).await
}