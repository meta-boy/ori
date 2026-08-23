//! Access commands. `exec` and `host` are implemented; `ssh`/`scp`/`forward`/
//! `desktop` tunnel through the control plane and are stubs in this build.

use std::io::{self, Write};

use serde::{Deserialize, Serialize};

use crate::cli::{DesktopArgs, ExecArgs, HostArgs};
use crate::context::Ctx;
use crate::error::{ApiError, CliError};
use crate::render::print_json;
use crate::wire::ExecResponse;

pub async fn exec(args: ExecArgs, ctx: &Ctx) -> Result<(), CliError> {
    if args.command.is_empty() && args.status.is_none() {
        return Err(CliError::usage("exec requires a command"));
    }
    if args.detach && args.status.is_some() {
        return Err(CliError::usage(
            "--detach and --status are mutually exclusive",
        ));
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostPortRequest {
    port: u16,
    public: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostPortResponse {
    port: u16,
    url: String,
    public: bool,
    listening: bool,
    #[serde(default)]
    note: Option<String>,
}

/// `ori host <id> <port>` — expose a sandbox port on a stable URL.
pub async fn host(args: HostArgs, ctx: &Ctx) -> Result<(), CliError> {
    if args.port == 0 {
        return Err(CliError::usage("port must be non-zero"));
    }
    let res: HostPortResponse = ctx
        .api
        .post_json(
            &format!("/sandboxes/{}/ports", args.id),
            &HostPortRequest {
                port: args.port,
                public: args.public,
                title: args.title.clone(),
            },
        )
        .await?;

    if ctx.json {
        print_json(&res)?;
        return Ok(());
    }

    let mut out = io::stdout();
    writeln!(out, "{}", res.url)?;
    writeln!(
        out,
        "port {} - {}",
        res.port,
        if res.public { "public" } else { "token-gated" }
    )?;
    // A URL for a port nothing is serving is the most common outcome of this
    // command, so say what is wrong instead of leaving a dead link.
    if let Some(note) = &res.note {
        writeln!(out, "\nwarning: {note}")?;
    } else if !res.listening {
        writeln!(
            out,
            "\nwarning: nothing is listening on port {} yet",
            res.port
        )?;
    }
    Ok(())
}

/// Port the golden image's `websockify` serves noVNC on, loopback-only.
const DESKTOP_WEB_PORT: u16 = 6080;
/// Raw VNC port, for a native client via `ori forward`.
const DESKTOP_VNC_PORT: u16 = 5900;

/// `ori desktop <id>` — a URL for the sandbox's graphical desktop.
///
/// The golden image already runs `Xvfb -> x11vnc -> websockify -> noVNC`, all
/// bound to loopback, so this is the `host` mechanism pointed at that port
/// rather than a separate transport: browser -> control plane -> agent tunnel ->
/// loopback inside the sandbox.
///
/// `--vnc` exposes the raw VNC port instead, for a native client. That is a
/// stream, not a web page, so it is reported as a `forward` target rather than
/// dressed up as a URL a browser could open.
pub async fn desktop(args: DesktopArgs, ctx: &Ctx) -> Result<(), CliError> {
    let port = if args.vnc {
        DESKTOP_VNC_PORT
    } else {
        DESKTOP_WEB_PORT
    };
    let res: HostPortResponse = ctx
        .api
        .post_json(
            &format!("/sandboxes/{}/ports", args.id),
            &HostPortRequest {
                port,
                public: args.public,
                title: Some(if args.vnc {
                    "vnc".into()
                } else {
                    "desktop".into()
                }),
            },
        )
        .await?;

    if ctx.json {
        print_json(&res)?;
        return Ok(());
    }

    let mut out = io::stdout();
    if args.vnc {
        // A VNC client cannot speak to an HTTPS endpoint; give the command that
        // actually gets them a local port instead of a misleading link.
        writeln!(out, "vnc is on port {} inside the sandbox", res.port)?;
        writeln!(
            out,
            "point a VNC client at 127.0.0.1:5900 after running:\n  ori forward {} --remote {}",
            args.id, DESKTOP_VNC_PORT
        )?;
    } else {
        writeln!(out, "{}/vnc.html", res.url.trim_end_matches('/'))?;
        writeln!(
            out,
            "desktop on port {} - {}",
            res.port,
            if res.public { "public" } else { "token-gated" }
        )?;
    }
    if let Some(note) = &res.note {
        writeln!(out, "\nwarning: {note}")?;
    } else if !res.listening {
        writeln!(
            out,
            "\nwarning: nothing is listening on port {} - is the desktop stack running?",
            res.port
        )?;
    }
    Ok(())
}
