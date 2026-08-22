use std::process::ExitCode;

use clap::Parser;

use ori_cli::cli::Cli;
use ori_cli::command;
use ori_cli::context::Ctx;
use ori_cli::error::{exit_code, CliError};
use ori_cli::render::json_enabled;

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();

    // --json auto-enables when stdout is not a TTY.
    let json = json_enabled(cli.json);

    let ctx = match Ctx::load(&cli, json) {
        Ok(ctx) => ctx,
        Err(e) => {
            eprintln!("ori: {e}");
            return ExitCode::from(exit_code(&e) as u8);
        }
    };

    match command::dispatch(cli.command, ctx).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            if !matches!(e, CliError::RemoteExit(_)) {
                eprintln!("ori: {e}");
            }
            ExitCode::from(exit_code(&e) as u8)
        }
    }
}