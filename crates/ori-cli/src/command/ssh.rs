//! `ssh`, `scp` and `forward` — all one transport.
//!
//! The CLI does **not** speak the SSH protocol. It hands off to the system
//! `ssh` with a `ProxyCommand` that relays stdio over a WebSocket to the
//! control plane, which splices those bytes to the sandbox's own `sshd`. Real
//! SSH runs end to end inside that pipe.
//!
//! Why this shape rather than a hand-rolled terminal protocol:
//!
//! - **SSH's cryptography stays end to end.** The tunnel is transport; it
//!   authorises *access to the machine* and never sees the session.
//! - **`scp`, `rsync`, `git` over ssh, VS Code Remote-SSH and JetBrains remote
//!   all work for free**, because it is genuinely SSH. A custom pty protocol
//!   gets none of them.
//! - **`sshd` stays bound to loopback.** Nothing new is exposed; the golden
//!   image already ships it that way.
//! - It works through any HTTPS reverse proxy that passes WebSockets, which is
//!   how a self-hosted control plane is usually reached.

use std::path::PathBuf;
use std::process::Stdio;

use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

use crate::cli::{ForwardArgs, ScpArgs, SshArgs};
use crate::context::Ctx;
use crate::error::CliError;

/// The sandbox user keys are authorised for. The golden image ships the distro
/// default `PermitRootLogin prohibit-password`, so authorising root would
/// produce a key that silently cannot log in.
const SANDBOX_USER: &str = "work";

/// Where the managed keypair lives.
fn key_path() -> Result<PathBuf, CliError> {
    let home = directories::UserDirs::new()
        .map(|d| d.home_dir().to_path_buf())
        .ok_or_else(|| CliError::usage("cannot resolve the home directory"))?;
    Ok(home.join(".ssh").join("ori_ed25519"))
}

/// Ensure a keypair exists; return the public half.
///
/// Generated with an empty passphrase because it is a per-machine credential
/// for ephemeral sandboxes, used non-interactively by `ProxyCommand`. The
/// private half is 0600 by `ssh-keygen`'s own default.
async fn ensure_key() -> Result<(PathBuf, String), CliError> {
    let priv_path = key_path()?;
    let pub_path = priv_path.with_extension("pub");
    if !pub_path.exists() {
        if let Some(dir) = priv_path.parent() {
            tokio::fs::create_dir_all(dir).await.ok();
        }
        let status = tokio::process::Command::new("ssh-keygen")
            .args([
                "-t",
                "ed25519",
                "-N",
                "",
                "-C",
                "ori",
                "-f",
                &priv_path.to_string_lossy(),
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .status()
            .await
            .map_err(|e| CliError::usage(format!("ssh-keygen not available: {e}")))?;
        if !status.success() {
            return Err(CliError::usage("ssh-keygen failed"));
        }
    }
    let pubkey = tokio::fs::read_to_string(&pub_path)
        .await
        .map_err(|e| CliError::usage(format!("reading {}: {e}", pub_path.display())))?;
    Ok((priv_path, pubkey.trim().to_string()))
}

/// `http(s)://host` -> `ws(s)://host`.
fn ws_base(api_url: &str) -> String {
    let t = api_url.trim_end_matches('/');
    if let Some(rest) = t.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = t.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        format!("ws://{t}")
    }
}

/// Relay stdin/stdout over a WebSocket to a port in the sandbox.
///
/// This is the `ProxyCommand`: `ssh` speaks its protocol over our stdio and
/// never learns there is a WebSocket in the middle.
pub async fn stdio(id: &str, port: u16, ctx: &Ctx) -> Result<(), CliError> {
    let token = ctx
        .config
        .token
        .clone()
        .ok_or_else(|| CliError::usage("not logged in; run `ori login`"))?;
    let url = format!(
        "{}/api/v1/sandboxes/{}/tcp/{}",
        ws_base(&ctx.api_url_raw),
        id,
        port
    );
    let mut req = url
        .as_str()
        .into_client_request()
        .map_err(|e| CliError::usage(format!("bad tunnel url: {e}")))?;
    req.headers_mut().insert(
        "authorization",
        format!("Bearer {token}")
            .parse()
            .map_err(|_| CliError::usage("bad token"))?,
    );
    let (ws, _) = tokio_tungstenite::connect_async(req)
        .await
        .map_err(|e| CliError::usage(format!("connect {url}: {e}")))?;
    let (mut tx, mut rx) = ws.split();

    let mut stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();

    // Either direction ending tears the other down: a closed ssh session must
    // not leave the opposite half waiting on bytes that will never arrive.
    let up = async {
        let mut buf = vec![0u8; 32 * 1024];
        loop {
            match stdin.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(Message::Binary(buf[..n].to_vec())).await.is_err() {
                        break;
                    }
                }
            }
        }
        let _ = tx.close().await;
    };
    let down = async {
        while let Some(Ok(msg)) = rx.next().await {
            let bytes = match msg {
                Message::Binary(b) => b,
                Message::Text(t) => t.into_bytes(),
                Message::Close(_) => break,
                _ => continue,
            };
            if stdout.write_all(&bytes).await.is_err() {
                break;
            }
            let _ = stdout.flush().await;
        }
    };
    tokio::select! {
        _ = up => {}
        _ = down => {}
    }
    Ok(())
}

/// Authorise our public key on the sandbox.
async fn authorize(id: &str, pubkey: &str, ctx: &Ctx) -> Result<(), CliError> {
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Body<'a> {
        public_key: &'a str,
    }
    #[derive(serde::Deserialize)]
    struct Res {
        #[allow(dead_code)]
        authorized: bool,
    }
    let _: Res = ctx
        .api
        .post_json(
            &format!("/sandboxes/{id}/sshkey"),
            &Body { public_key: pubkey },
        )
        .await?;
    Ok(())
}

/// Common `ssh`/`scp` options.
///
/// Host-key checking is disabled deliberately: the "host" is a `ProxyCommand`
/// pipe to an ephemeral sandbox, and sandbox ids are recycled, so a known_hosts
/// entry would produce a spurious mismatch warning on a *new* sandbox. Access is
/// already authenticated by the API key that opens the tunnel — the host key
/// would be authenticating a pipe we just authorised ourselves.
fn ssh_opts(exe: &str, id: &str, api_url: &str, key: &str) -> Vec<String> {
    vec![
        "-o".into(),
        format!("ProxyCommand={exe} ssh --stdio --api-url {api_url} {id}"),
        "-o".into(),
        "StrictHostKeyChecking=no".into(),
        "-o".into(),
        "UserKnownHostsFile=/dev/null".into(),
        "-o".into(),
        "LogLevel=ERROR".into(),
        "-i".into(),
        key.into(),
    ]
}

fn exe() -> Result<String, CliError> {
    Ok(std::env::current_exe()
        .map_err(|e| CliError::usage(format!("cannot resolve own path: {e}")))?
        .to_string_lossy()
        .to_string())
}

pub async fn ssh(args: SshArgs, ctx: &Ctx) -> Result<(), CliError> {
    if args.stdio {
        return stdio(&args.id, 22, ctx).await;
    }
    let (key, pubkey) = ensure_key().await?;
    authorize(&args.id, &pubkey, ctx).await?;

    let mut argv = ssh_opts(&exe()?, &args.id, &ctx.api_url_raw, &key.to_string_lossy());
    argv.push(format!("{SANDBOX_USER}@{}", args.id));
    argv.extend(args.command.clone());

    let status = tokio::process::Command::new("ssh")
        .args(&argv)
        .status()
        .await
        .map_err(|e| CliError::usage(format!("ssh not available: {e}")))?;
    // Exit with ssh's code so a script can tell a remote failure from ours.
    std::process::exit(status.code().unwrap_or(255));
}

/// Split `<id>:<path>`; `None` when the operand is local.
fn split_remote(operand: &str) -> Option<(String, String)> {
    let (a, b) = operand.split_once(':')?;
    if a.is_empty() || a.contains('/') {
        return None;
    }
    Some((a.to_string(), b.to_string()))
}

pub async fn scp(args: ScpArgs, ctx: &Ctx) -> Result<(), CliError> {
    let remote = split_remote(&args.src).or_else(|| split_remote(&args.dst));
    let (id, _) = remote.ok_or_else(|| {
        CliError::usage("one of source or destination must be <sandbox-id>:<path>")
    })?;

    let (key, pubkey) = ensure_key().await?;
    authorize(&id, &pubkey, ctx).await?;

    let mut argv = ssh_opts(&exe()?, &id, &ctx.api_url_raw, &key.to_string_lossy());
    if args.recursive {
        argv.push("-r".into());
    }
    // `scp` addresses the remote as user@host:path; rewrite the id operand.
    let rewrite = |o: &str| match split_remote(o) {
        Some((_, path)) => format!("{SANDBOX_USER}@{id}:{path}"),
        None => o.to_string(),
    };
    argv.push(rewrite(&args.src));
    argv.push(rewrite(&args.dst));

    let status = tokio::process::Command::new("scp")
        .args(&argv)
        .status()
        .await
        .map_err(|e| CliError::usage(format!("scp not available: {e}")))?;
    std::process::exit(status.code().unwrap_or(255));
}

pub async fn forward(args: ForwardArgs, ctx: &Ctx) -> Result<(), CliError> {
    let local = args.local.unwrap_or(args.remote);
    let listener = tokio::net::TcpListener::bind((args.bind.as_str(), local))
        .await
        .map_err(|e| CliError::usage(format!("cannot bind {}:{local}: {e}", args.bind)))?;
    if !ctx.json {
        eprintln!(
            "forwarding {}:{local} -> {}:{} (ctrl-c to stop)",
            args.bind, args.id, args.remote
        );
    }
    let token = ctx
        .config
        .token
        .clone()
        .ok_or_else(|| CliError::usage("not logged in; run `ori login`"))?;
    let url = format!(
        "{}/api/v1/sandboxes/{}/tcp/{}",
        ws_base(&ctx.api_url_raw),
        args.id,
        args.remote
    );

    loop {
        let (mut sock, peer) = match listener.accept().await {
            Ok(v) => v,
            Err(e) => {
                eprintln!("accept failed: {e}");
                continue;
            }
        };
        let url = url.clone();
        let token = token.clone();
        // One WebSocket per TCP connection; a failed dial closes only that
        // connection rather than the whole forward.
        tokio::spawn(async move {
            let mut req = match url.as_str().into_client_request() {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("{peer}: bad url: {e}");
                    return;
                }
            };
            if let Ok(v) = format!("Bearer {token}").parse() {
                req.headers_mut().insert("authorization", v);
            }
            let ws = match tokio_tungstenite::connect_async(req).await {
                Ok((ws, _)) => ws,
                Err(e) => {
                    eprintln!("{peer}: tunnel connect failed: {e}");
                    return;
                }
            };
            let (mut tx, mut rx) = ws.split();
            let (mut r, mut w) = sock.split();
            let up = async {
                let mut buf = vec![0u8; 32 * 1024];
                loop {
                    match r.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if tx.send(Message::Binary(buf[..n].to_vec())).await.is_err() {
                                break;
                            }
                        }
                    }
                }
                let _ = tx.close().await;
            };
            let down = async {
                while let Some(Ok(msg)) = rx.next().await {
                    let bytes = match msg {
                        Message::Binary(b) => b,
                        Message::Text(t) => t.into_bytes(),
                        Message::Close(_) => break,
                        _ => continue,
                    };
                    if w.write_all(&bytes).await.is_err() {
                        break;
                    }
                }
            };
            tokio::select! { _ = up => {}, _ = down => {} }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ws_base_maps_schemes() {
        assert_eq!(ws_base("https://ori.example.com"), "wss://ori.example.com");
        assert_eq!(ws_base("http://127.0.0.1:8100/"), "ws://127.0.0.1:8100");
    }

    #[test]
    fn split_remote_distinguishes_local_paths() {
        assert_eq!(
            split_remote("ori_abc12345:/tmp/x"),
            Some(("ori_abc12345".into(), "/tmp/x".into()))
        );
        // A Windows-style or absolute local path must not look remote.
        assert_eq!(split_remote("/tmp/x"), None);
        assert_eq!(split_remote("./rel:path"), None);
        assert_eq!(split_remote("plain.txt"), None);
    }
}
