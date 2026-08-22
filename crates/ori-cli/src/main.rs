use std::process::ExitCode;

use clap::Parser;

use ori_cli::cli::Cli;
use ori_cli::command;
use ori_cli::context::Ctx;
use ori_cli::error::{exit_code, CliError};
use ori_cli::render::json_enabled;

#[tokio::main]
async fn main() -> ExitCode {
    // Usage errors exit 1 (per SPEC-CLI.md); clap's default is 2, which we
    // reserve for API errors.
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(e) => {
            let code = if e.use_stderr() { 1 } else { 0 };
            let _ = e.print();
            return ExitCode::from(code);
        }
    };

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