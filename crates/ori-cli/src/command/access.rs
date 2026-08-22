//! Access commands. `exec` is implemented; `ssh`/`scp`/`forward`/`host`/`desktop`
//! tunnel through the control plane and are stubs in this build.

use std::io::{self, Write};

use crate::cli::ExecArgs;
use crate::context::Ctx;
use crate::error::{ApiError, CliError};
use crate::render::print_json;
use crate::wire::ExecResponse;

pub async fn exec(args: ExecArgs, ctx: &Ctx) -> Result<(), CliError> {
    if args.command.is_empty() && args.status.is_none() {
        return Err(CliError::usage("exec requires a command"));
    }
    if args.detach && args.status.is_some() {
        return Err(CliError::usage("--detach and --status are mutually exclusive"));
    }
    let base = format!("/sandboxes/{}/exec", args.id);

    if let Some(pid) = args.status {
        let res = ctx
            .api
            .get_json::<ExecResponse>(&format!("{base}/{pid}"))
            .await?;
        if ctx.json {
            print_json(&res)?;
        } else {
            println!("pid {} state {}", res.pid, res.state);
        }
        if matches!(res.state.as_str(), "exited" | "done" | "failed") {
            return Err(CliError::RemoteExit(res.exit_code.unwrap_or(1)));
        }
        return Ok(());
    }

    let req = crate::wire::ExecRequest {
        command: args.command.clone(),
        cwd: args.cwd.clone(),
        timeout: args.timeout,
        detach: args.detach,
    };
    let res = ctx.api.post_json::<ExecResponse>(&base, &req).await?;

    if args.detach {
        if ctx.json {
            print_json(&res)?;
        } else {
            println!("started pid {}", res.pid);
        }
        return Ok(());
    }

    if ctx.json {
        print_json(&res)?;
    } else {
        if let Some(out) = &res.stdout {
            print!("{out}");
        }
        if let Some(err) = &res.stderr {
            eprint!("{err}");
        }
        io::stdout().flush().ok();
        io::stderr().flush().ok();
    }

    match res.exit_code {
        Some(code) => Err(CliError::RemoteExit(code)),
        None => Err(CliError::Api(ApiError {
            status: 0,
            code: "bad_response".into(),
            message: "exec response missing exitCode".into(),
        })),
    }
}