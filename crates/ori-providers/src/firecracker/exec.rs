//! Bootstrap-only `exec` over Firecracker's vsock device.
//!
//! The trait contract for `Provider::exec` is explicit: the **primary** exec
//! path is the guest agent over the control-plane tunnel (C6), and the
//! provider method is the bootstrap-only fallback. On a bare microVM there is
//! no `docker exec` or `pct exec` to fall back to, so this backend defines its
//! own minimal channel: the guest runs a tiny exec server on a vsock port and
//! the provider connects to it through the host-side Unix socket Firecracker
//! exposes.
//!
//! Host side (this module):
//! 1. connect to `<jail_root>/vsock.sock` (inside the jail),
//! 2. send `CONNECT <port>\n` (Firecracker's vsock host protocol),
//! 3. read the `OK <port>\n` ack,
//! 4. write one JSON request line, read JSON frames until the `exit` frame.
//!
//! The guest side is [`EXEC_SHIM_RS`], a reference implementation the operator
//! builds into the rootfs (it is deliberately not the C6 agent). Until the
//! agent exists, a rootfs that runs this shim is what makes `exec` work; if no
//! shim is listening, the connection is refused and `exec` fails loudly —
//! never a fake success.
//!
//! Frame protocol (newline-delimited JSON):
//!
//! ```text
//! host -> guest  {"cmd":["sh","-c","echo hi"],"env":["K=V"],"cwd":"/"}
//! guest -> host  {"stream":"stdout","data":"<base64>"}
//!                {"stream":"stderr","data":"<base64>"}
//!                {"stream":"exit","code":0}
//! ```

use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

use crate::reconcile::{ExecRequest, ExecResult};

use super::error::FcError;

/// Default vsock port the guest shim listens on (matches
/// `FirecrackerConfig::exec_port`).
pub const DEFAULT_EXEC_PORT: u32 = 8086;

/// Guest-side reference implementation of the exec server.
///
/// Build statically and run it from the rootfs init:
///
/// ```text
/// cargo build --release --target x86_64-unknown-linux-musl
/// # copy target/x86_64-unknown-linux-musl/release/ori-execd into the rootfs
/// # run from init:  /usr/libexec/ori-execd &
/// ```
///
/// Dependencies: `libc`, `serde`, `serde_json`, `base64`. It listens on the
/// vsock port from `ORI_EXECD_PORT` (default 8086).
pub const EXEC_SHIM_RS: &str = r#"// ori-execd: bootstrap exec server for the Firecracker provider.
// Reference guest side of crates/ori-providers/src/firecracker/exec.rs.
#![deny(warnings)]
use std::io::{Read, Write};
use std::os::unix::io::FromRawFd;
use std::process::{Command, Stdio};

#[derive(serde::Deserialize)]
struct Request {
    cmd: Vec<String>,
    #[serde(default)]
    env: Vec<String>,
    cwd: Option<String>,
}

#[derive(serde::Serialize)]
struct Frame<'a> {
    stream: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<i32>,
}

fn main() {
    let port: u32 = std::env::var("ORI_EXECD_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8086);
    let lfd = unsafe { libc::socket(libc::AF_VSOCK, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    if lfd < 0 {
        die("socket");
    }
    let addr = libc::sockaddr_vm {
        svm_family: libc::AF_VSOCK as libc::sa_family_t,
        svm_cid: libc::VMADDR_CID_ANY,
        svm_port: port,
        svm_reserved1: 0,
    };
    let rc = unsafe {
        libc::bind(
            lfd,
            &addr as *const libc::sockaddr_vm as *const libc::sockaddr,
            std::mem::size_of::<libc::sockaddr_vm>() as libc::socklen_t,
        )
    };
    if rc < 0 {
        die("bind");
    }
    if unsafe { libc::listen(lfd, 16) } < 0 {
        die("listen");
    }
    loop {
        let cfd = unsafe {
            libc::accept4(
                lfd,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                libc::SOCK_CLOEXEC,
            )
        };
        if cfd < 0 {
            continue;
        }
        // Fork per connection so a wedged command cannot take down the shim.
        let pid = unsafe { libc::fork() };
        if pid == 0 {
            let _ = handle(cfd);
            unsafe { libc::_exit(0) };
        }
        unsafe { libc::close(cfd) };
    }
}

fn handle(cfd: i32) -> std::io::Result<()> {
    let mut sock = unsafe { std::fs::File::from_raw_fd(cfd) };
    let req = read_request(&mut sock)?;
    let mut cmd = Command::new(&req.cmd[0]);
    cmd.args(&req.cmd[1..]);
    for kv in &req.env {
        if let Some((k, v)) = kv.split_once('=') {
            cmd.env(k, v);
        }
    }
    if let Some(cwd) = &req.cwd {
        cmd.current_dir(cwd);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            write_frame(&mut sock, "exit", None, Some(127))?;
            return Err(e);
        }
    };
    let mut out = child.stdout.take().unwrap();
    let mut err = child.stderr.take().unwrap();
    std::thread::scope(|s| {
        s.spawn(|| {
            let mut buf = [0u8; 8192];
            while let Ok(n) = out.read(&mut buf) {
                if n == 0 {
                    break;
                }
                if write_frame(&mut sock, "stdout", Some(&buf[..n]), None).is_err() {
                    break;
                }
            }
        });
        s.spawn(|| {
            let mut buf = [0u8; 8192];
            while let Ok(n) = err.read(&mut buf) {
                if n == 0 {
                    break;
                }
                if write_frame(&mut sock, "stderr", Some(&buf[..n]), None).is_err() {
                    break;
                }
            }
        });
    });
    let code = child.wait().map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
    write_frame(&mut sock, "exit", None, Some(code))
}

fn read_request(sock: &mut std::fs::File) -> std::io::Result<Request> {
    let mut buf = String::new();
    let mut byte = [0u8; 1];
    loop {
        let n = sock.read(&mut byte)?;
        if n == 0 {
            return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "eof"));
        }
        if byte[0] == b'\n' {
            break;
        }
        buf.push(byte[0] as char);
    }
    serde_json::from_str(&buf).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

fn write_frame(
    sock: &mut std::fs::File,
    stream: &str,
    data: Option<&[u8]>,
    code: Option<i32>,
) -> std::io::Result<()> {
    let frame = Frame {
        stream,
        data: data.map(|d| base64::Engine::encode(&base64::engine::general_purpose::STANDARD, d)),
        code,
    };
    let mut line = serde_json::to_string(&frame).unwrap();
    line.push('\n');
    sock.write_all(line.as_bytes())
}

fn die(what: &str) -> ! {
    eprintln!("ori-execd: {what}: {}", std::io::Error::last_os_error());
    std::process::exit(1);
}
"#;

/// A single command to run in the guest.
#[derive(Debug, Serialize, Deserialize)]
struct ExecRequestWire {
    cmd: Vec<String>,
    env: Vec<String>,
    cwd: Option<String>,
}

/// One frame of guest output or the final exit.
#[derive(Debug, Deserialize)]
struct ExecFrame {
    stream: String,
    #[serde(default)]
    data: Option<String>,
    #[serde(default)]
    code: Option<i32>,
}

/// Run a command in the guest via the vsock bootstrap channel.
///
/// The overall `timeout` bounds the whole exec, including guest boot time:
/// until the shim's vsock listener is up, Firecracker refuses the connection
/// and we retry, so a freshly resumed VM's first exec still works.
pub async fn run_vsock_exec(
    vsock_socket: &Path,
    guest_port: u32,
    req: ExecRequest,
    timeout: Duration,
) -> Result<ExecResult, FcError> {
    let started = tokio::time::Instant::now();
    let deadline = started + timeout;
    let mut reader = connect_with_retry(vsock_socket, guest_port, deadline).await?;

    let wire = ExecRequestWire {
        cmd: req.command,
        env: req
            .env
            .into_iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect(),
        cwd: req.workdir,
    };
    let mut line = serde_json::to_string(&wire).map_err(|e| FcError::Other(e.to_string()))?;
    line.push('\n');
    reader
        .get_mut()
        .write_all(line.as_bytes())
        .await
        .map_err(|e| FcError::Transport(format!("write exec request: {e}")))?;

    let mut stdout: Vec<u8> = Vec::new();
    let mut stderr: Vec<u8> = Vec::new();
    let exit_code = loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let mut line = String::new();
        tokio::time::timeout(remaining, reader.read_line(&mut line))
            .await
            .map_err(|_| FcError::Transport("exec timed out".to_string()))?
            .map_err(|e| FcError::Transport(format!("read exec frame: {e}")))?;
        if line.is_empty() {
            return Err(FcError::Transport(
                "guest closed the exec stream without an exit frame".to_string(),
            ));
        }
        let frame: ExecFrame = serde_json::from_str(line.trim_end())
            .map_err(|e| FcError::Data(format!("bad exec frame: {e}")))?;
        match frame.stream.as_str() {
            "stdout" => stdout.extend(decode_data(frame.data)?),
            "stderr" => stderr.extend(decode_data(frame.data)?),
            "exit" => break frame.code.unwrap_or(-1),
            other => return Err(FcError::Data(format!("unknown exec stream {other:?}"))),
        }
    };
    Ok(ExecResult {
        exit_code,
        stdout,
        stderr,
        duration: started.elapsed(),
    })
}

/// Connect to the vsock UDS and complete Firecracker's `CONNECT` handshake,
/// retrying until `deadline` so a guest that is still booting is not a hard
/// failure.
async fn connect_with_retry(
    vsock_socket: &Path,
    guest_port: u32,
    deadline: tokio::time::Instant,
) -> Result<BufReader<UnixStream>, FcError> {
    loop {
        match try_connect(vsock_socket, guest_port).await {
            Ok(reader) => return Ok(reader),
            Err(e) => {
                if tokio::time::Instant::now() >= deadline {
                    return Err(e);
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    }
}

async fn try_connect(
    vsock_socket: &Path,
    guest_port: u32,
) -> Result<BufReader<UnixStream>, FcError> {
    let stream = UnixStream::connect(vsock_socket).await.map_err(|e| {
        FcError::Transport(format!("connect vsock {}: {e}", vsock_socket.display()))
    })?;
    let mut reader = BufReader::new(stream);
    let msg = format!("CONNECT {guest_port}\n");
    reader
        .get_mut()
        .write_all(msg.as_bytes())
        .await
        .map_err(|e| FcError::Transport(format!("vsock connect write: {e}")))?;
    let mut ack = String::new();
    let n = reader
        .read_line(&mut ack)
        .await
        .map_err(|e| FcError::Transport(format!("vsock connect read: {e}")))?;
    if n == 0 || !ack.starts_with("OK ") {
        return Err(FcError::Transport(format!(
            "guest exec shim not reachable on vsock port {guest_port}"
        )));
    }
    Ok(reader)
}

fn decode_data(data: Option<String>) -> Result<Vec<u8>, FcError> {
    let data = data.unwrap_or_default();
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|e| FcError::Data(format!("exec frame data not base64: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;
    use tokio::net::{UnixListener, UnixStream};

    /// Read a newline-terminated line from a stream, byte by byte.
    async fn read_line(stream: &mut UnixStream) -> String {
        let mut out = String::new();
        let mut b = [0u8; 1];
        loop {
            let n = stream.read(&mut b).await.expect("read");
            if n == 0 || b[0] == b'\n' {
                break;
            }
            out.push(b[0] as char);
        }
        out
    }

    /// A fake guest exec shim: speaks the `CONNECT` handshake, reads the
    /// request line, then emits scripted frames.
    async fn fake_guest(
        listener: UnixListener,
        frames: Vec<(&'static str, Option<String>, Option<i32>)>,
    ) {
        let (mut stream, _) = listener.accept().await.expect("accept");
        let ack = read_line(&mut stream).await;
        assert!(ack.starts_with("CONNECT "), "got: {ack}");
        stream
            .write_all(b"OK 1073741824\n")
            .await
            .expect("ack write");
        let req_line = read_line(&mut stream).await;
        let req: ExecRequestWire = serde_json::from_str(req_line.trim()).expect("request json");
        assert_eq!(
            req.cmd,
            vec!["sh".to_string(), "-c".to_string(), "echo hi".to_string()]
        );
        for (name, data, code) in frames {
            let payload = match data {
                Some(d) => serde_json::json!({ "stream": name, "data": d }),
                None => serde_json::json!({ "stream": name, "code": code }),
            };
            let mut line = payload.to_string();
            line.push('\n');
            stream
                .write_all(line.as_bytes())
                .await
                .expect("frame write");
        }
    }

    fn b64(data: &[u8]) -> String {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(data)
    }

    #[tokio::test]
    async fn exec_streams_stdout_and_exit_code() {
        let dir = std::env::temp_dir().join(format!("fc-exec-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sock_path = dir.join("vsock.sock");
        let listener = UnixListener::bind(&sock_path).unwrap();

        let guest = tokio::spawn(fake_guest(
            listener,
            vec![
                ("stdout", Some(b64(b"hello ")), None),
                ("stdout", Some(b64(b"world\n")), None),
                ("exit", None, Some(0)),
            ],
        ));

        let result = run_vsock_exec(
            &sock_path,
            8086,
            ExecRequest {
                command: vec!["sh".into(), "-c".into(), "echo hi".into()],
                timeout: Some(Duration::from_secs(10)),
                env: vec![],
                workdir: None,
            },
            Duration::from_secs(10),
        )
        .await
        .expect("exec");

        assert_eq!(result.exit_code, 0);
        assert_eq!(String::from_utf8_lossy(&result.stdout), "hello world\n");
        assert!(result.stderr.is_empty());
        guest.await.unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn exec_surfaces_exit_code_and_stderr() {
        let dir = std::env::temp_dir().join(format!("fc-exec2-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sock_path = dir.join("vsock.sock");
        let listener = UnixListener::bind(&sock_path).unwrap();

        let guest = tokio::spawn(fake_guest(
            listener,
            vec![
                ("stderr", Some(b64(b"boom")), None),
                ("exit", None, Some(1)),
            ],
        ));

        let result = run_vsock_exec(
            &sock_path,
            8086,
            ExecRequest {
                command: vec!["sh".into(), "-c".into(), "echo hi".into()],
                timeout: Some(Duration::from_secs(10)),
                env: vec![],
                workdir: None,
            },
            Duration::from_secs(10),
        )
        .await
        .expect("exec");

        assert_eq!(result.exit_code, 1);
        assert_eq!(String::from_utf8_lossy(&result.stderr), "boom");
        guest.await.unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn exec_fails_when_no_shim_is_listening() {
        let dir = std::env::temp_dir().join(format!("fc-exec3-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // A socket file nobody is listening on — Firecracker would refuse the
        // connection the same way, and the retry loop must give up by deadline.
        let sock_path = dir.join("vsock.sock");
        let result = run_vsock_exec(
            &sock_path,
            8086,
            ExecRequest {
                command: vec!["true".into()],
                timeout: Some(Duration::from_secs(2)),
                env: vec![],
                workdir: None,
            },
            Duration::from_secs(2),
        )
        .await;
        assert!(result.is_err(), "expected error, got {result:?}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn connect_handshake_writes_correct_port() {
        let dir = std::env::temp_dir().join(format!("fc-exec4-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sock_path = dir.join("vsock.sock");
        let listener = UnixListener::bind(&sock_path).unwrap();
        let guest = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let line = read_line(&mut stream).await;
            assert_eq!(line, "CONNECT 8086");
            stream.write_all(b"OK 5\n").await.unwrap();
            // Close without frames; run_vsock_exec must error on the missing
            // exit frame rather than hang or succeed.
        });
        let result = run_vsock_exec(
            &sock_path,
            8086,
            ExecRequest {
                command: vec!["true".into()],
                timeout: Some(Duration::from_secs(10)),
                env: vec![],
                workdir: None,
            },
            Duration::from_secs(10),
        )
        .await;
        assert!(result.is_err(), "expected missing-exit-frame error");
        guest.await.unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
