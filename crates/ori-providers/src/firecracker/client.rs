//! Minimal HTTP/1.1 client for the Firecracker control API, which is served
//! over a per-microVM unix socket. Only the handful of verbs and bodies this
//! backend uses are needed, so this is ~100 lines instead of a reqwest +
//! hyper-unix-stack dependency.
//!
//! Every request is made against the instance's control socket **inside the
//! jail** (see [`crate::firecracker::handle::api_socket_for`]).

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

use super::error::FcError;

/// REST client bound to one instance's control socket.
#[derive(Debug, Clone)]
pub struct ApiClient {
    socket_path: std::path::PathBuf,
}

impl ApiClient {
    pub fn new(socket_path: impl Into<std::path::PathBuf>) -> Self {
        Self {
            socket_path: socket_path.into(),
        }
    }

    /// `GET /` — the instance's state, as the `state` field of `InstanceInfo`
    /// (`Not started` | `Running` | `Paused`).
    pub async fn describe_instance(&self) -> Result<String, FcError> {
        let (status, body) = self.request("GET", "/", None).await?;
        ensure_ok(status, body.as_ref(), "GET /")?;
        let state = body
            .and_then(|v| v.get("state").and_then(Value::as_str).map(str::to_string))
            .ok_or_else(|| FcError::Data("GET / had no state field".to_string()))?;
        Ok(state)
    }

    /// `PUT /machine-config` — vCPU count and memory. Pre-boot only.
    pub async fn set_machine_config(
        &self,
        vcpu_count: u32,
        mem_size_mib: u64,
    ) -> Result<(), FcError> {
        let body = json!({
            "vcpu_count": vcpu_count,
            "mem_size_mib": mem_size_mib,
            "smt": false,
            "track_dirty_pages": false,
            "huge_pages": "None",
        });
        let (status, body) = self.request("PUT", "/machine-config", Some(body)).await?;
        ensure_ok(status, body.as_ref(), "PUT /machine-config")
    }

    /// `PUT /boot-source` — the kernel image (jail-relative path).
    pub async fn set_boot_source(&self, kernel_path: &str, boot_args: &str) -> Result<(), FcError> {
        let body = json!({
            "kernel_image_path": kernel_path,
            "boot_args": boot_args,
        });
        let (status, body) = self.request("PUT", "/boot-source", Some(body)).await?;
        ensure_ok(status, body.as_ref(), "PUT /boot-source")
    }

    /// `PUT /drives/rootfs` — the root filesystem device.
    pub async fn set_drive(&self, path_on_host: &str) -> Result<(), FcError> {
        let body = json!({
            "drive_id": "rootfs",
            "path_on_host": path_on_host,
            "is_root_device": true,
            "is_read_only": false,
            "cache_type": "Unsafe",
        });
        let (status, body) = self.request("PUT", "/drives/rootfs", Some(body)).await?;
        ensure_ok(status, body.as_ref(), "PUT /drives/rootfs")
    }

    /// `PUT /vsock` — the vsock device that carries bootstrap exec.
    pub async fn set_vsock(&self, guest_cid: u32, uds_path: &str) -> Result<(), FcError> {
        let body = json!({
            "guest_cid": guest_cid,
            "uds_path": uds_path,
        });
        let (status, body) = self.request("PUT", "/vsock", Some(body)).await?;
        ensure_ok(status, body.as_ref(), "PUT /vsock")
    }

    /// `PUT /network-interfaces/eth0` — attach the guest's only NIC to a TAP.
    pub async fn set_network(&self, host_dev_name: &str) -> Result<(), FcError> {
        let body = json!({
            "iface_id": "eth0",
            "host_dev_name": host_dev_name,
        });
        let (status, body) = self
            .request("PUT", "/network-interfaces/eth0", Some(body))
            .await?;
        ensure_ok(status, body.as_ref(), "PUT /network-interfaces/eth0")
    }

    /// `PUT /serial` — guest serial output to a file inside the jail (debug).
    pub async fn set_serial(&self, out_path: &str) -> Result<(), FcError> {
        let body = json!({ "serial_out_path": out_path });
        let (status, body) = self.request("PUT", "/serial", Some(body)).await?;
        ensure_ok(status, body.as_ref(), "PUT /serial")
    }

    /// `PUT /actions` — power the microVM on.
    pub async fn instance_start(&self) -> Result<(), FcError> {
        let body = json!({ "action_type": "InstanceStart" });
        let (status, body) = self.request("PUT", "/actions", Some(body)).await?;
        ensure_ok(status, body.as_ref(), "PUT /actions")
    }

    /// `PATCH /vm` — Paused | Resumed.
    pub async fn set_vm_state(&self, state: &str) -> Result<(), FcError> {
        let body = json!({ "state": state });
        let (status, body) = self.request("PATCH", "/vm", Some(body)).await?;
        ensure_ok(status, body.as_ref(), "PATCH /vm")
    }

    /// `PUT /snapshot/create` — full VM state capture. The microVM must be
    /// paused. Paths are jail-relative.
    pub async fn create_snapshot(
        &self,
        snapshot_path: &str,
        mem_file_path: &str,
    ) -> Result<(), FcError> {
        let body = json!({
            "snapshot_type": "Full",
            "snapshot_path": snapshot_path,
            "mem_file_path": mem_file_path,
        });
        let (status, body) = self.request("PUT", "/snapshot/create", Some(body)).await?;
        ensure_ok(status, body.as_ref(), "PUT /snapshot/create")
    }

    /// `PUT /snapshot/load` — restore a snapshot into this fresh process.
    /// Must be the first configuration call. `File` backend lets the kernel
    /// fault memory pages in on demand (`MAP_PRIVATE`); the memory file must
    /// stay for the resumed VM's lifetime.
    pub async fn load_snapshot(
        &self,
        snapshot_path: &str,
        mem_file_path: &str,
        resume: bool,
    ) -> Result<(), FcError> {
        let body = json!({
            "snapshot_path": snapshot_path,
            "mem_backend": {
                "backend_type": "File",
                "backend_path": mem_file_path,
            },
            "resume_vm": resume,
        });
        let (status, body) = self.request("PUT", "/snapshot/load", Some(body)).await?;
        ensure_ok(status, body.as_ref(), "PUT /snapshot/load")
    }

    /// Raw HTTP round trip over the unix socket.
    async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<(u16, Option<Value>), FcError> {
        let mut stream = UnixStream::connect(&self.socket_path).await.map_err(|e| {
            FcError::Transport(format!("connect {}: {e}", self.socket_path.display()))
        })?;

        let body_bytes = body.map(|v| v.to_string()).unwrap_or_default();
        let head = format!(
            "{method} {path} HTTP/1.1\r\nHost: localhost\r\nAccept: application/json\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
            body_bytes.len()
        );
        stream
            .write_all(head.as_bytes())
            .await
            .map_err(|e| FcError::Transport(format!("write {path}: {e}")))?;
        if !body_bytes.is_empty() {
            stream
                .write_all(body_bytes.as_bytes())
                .await
                .map_err(|e| FcError::Transport(format!("write {path} body: {e}")))?;
        }
        stream
            .flush()
            .await
            .map_err(|e| FcError::Transport(format!("flush {path}: {e}")))?;

        // Read the status line + headers, then exactly Content-Length body bytes.
        let mut buf: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 4096];
        let header_len = loop {
            let n = stream
                .read(&mut chunk)
                .await
                .map_err(|e| FcError::Transport(format!("read {path}: {e}")))?;
            if n == 0 {
                return Err(FcError::Transport(format!(
                    "{method} {path}: connection closed before response headers"
                )));
            }
            buf.extend_from_slice(&chunk[..n]);
            if let Some(pos) = find_header_end(&buf) {
                break pos;
            }
        };

        let head = String::from_utf8_lossy(&buf[..header_len]).into_owned();
        let mut lines = head.lines();
        let status_line = lines.next().unwrap_or_default();
        let status: u16 = status_line
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let content_length = lines
            .filter_map(|l| {
                let (k, v) = l.split_once(':')?;
                if k.trim().eq_ignore_ascii_case("content-length") {
                    v.trim().parse::<usize>().ok()
                } else {
                    None
                }
            })
            .next()
            .unwrap_or(0);

        let body_start = header_len + 4;
        let mut body_buf: Vec<u8> = Vec::new();
        if content_length > 0 {
            if buf.len() >= body_start + content_length {
                body_buf = buf[body_start..body_start + content_length].to_vec();
            } else {
                body_buf.extend_from_slice(&buf[body_start..]);
                while body_buf.len() < content_length {
                    let n = stream
                        .read(&mut chunk)
                        .await
                        .map_err(|e| FcError::Transport(format!("read {path} body: {e}")))?;
                    if n == 0 {
                        break;
                    }
                    body_buf.extend_from_slice(&chunk[..n]);
                }
                body_buf.truncate(content_length);
            }
        }

        let body = if body_buf.is_empty() {
            None
        } else {
            Some(
                serde_json::from_slice(&body_buf)
                    .map_err(|e| FcError::Data(format!("{method} {path} body not JSON: {e}")))?,
            )
        };
        Ok((status, body))
    }
}

/// Find the end of the HTTP header block (`\r\n\r\n`).
fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

/// Map a non-2xx status into an error, extracting `fault_message` when present.
fn ensure_ok(status: u16, body: Option<&Value>, what: &str) -> Result<(), FcError> {
    if (200..300).contains(&status) {
        return Ok(());
    }
    let message = body
        .and_then(|v| v.get("fault_message"))
        .and_then(Value::as_str)
        .unwrap_or("no fault message")
        .to_string();
    Err(FcError::Http {
        status,
        message: format!("{what}: {message}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::net::UnixListener;

    /// Scripted response for a fake control API.
    type Responder = Box<dyn Fn(&str, &str, Option<&str>) -> (u16, &'static str) + Send>;

    /// A fake Firecracker control API that parses one request and returns a
    /// scripted response, so the client's HTTP framing and JSON handling are
    /// tested without a real microVM.
    struct FakeApi {
        listener: UnixListener,
        responder: Responder,
    }

    impl FakeApi {
        fn new(
            responder: impl Fn(&str, &str, Option<&str>) -> (u16, &'static str) + Send + 'static,
        ) -> (Self, std::path::PathBuf) {
            let uniq = format!("{}-{}", std::process::id(), rand_suffix());
            let path = std::env::temp_dir().join(format!("fc-test-{uniq}.sock"));
            let listener = std::os::unix::net::UnixListener::bind(&path).expect("bind");
            listener.set_nonblocking(true).expect("nonblocking");
            (
                Self {
                    listener: tokio::net::UnixListener::from_std(listener).expect("from_std"),
                    responder: Box::new(responder),
                },
                path,
            )
        }

        /// Serve exactly one request, then close. Consumes the fake so the
        /// future is `Send + 'static` and can be spawned.
        async fn serve(self) {
            let (mut sock, _) = self.listener.accept().await.expect("accept");
            let mut reader = BufReader::new(&mut sock);
            let mut head = String::new();
            loop {
                let mut line = String::new();
                let n = reader.read_line(&mut line).await.expect("read line");
                if n == 0 {
                    break;
                }
                head.push_str(&line);
                if line == "\r\n" {
                    break;
                }
            }
            let mut lines = head.lines();
            let request_line = lines.next().unwrap_or_default();
            let mut parts = request_line.split_whitespace();
            let method = parts.next().unwrap_or_default().to_string();
            let path = parts.next().unwrap_or_default().to_string();
            let mut content_length = 0usize;
            for l in lines {
                if let Some((k, v)) = l.split_once(':') {
                    if k.trim().eq_ignore_ascii_case("content-length") {
                        content_length = v.trim().parse().unwrap_or(0);
                    }
                }
            }
            let mut body = String::new();
            let mut buf = vec![0u8; content_length];
            if content_length > 0 {
                reader.read_exact(&mut buf).await.expect("read body");
                body = String::from_utf8_lossy(&buf).into_owned();
            }
            let (status, resp_body) = (self.responder)(&method, &path, Some(&body));
            let out = if resp_body.is_empty() {
                format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\n\r\n")
            } else {
                format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    resp_body.len(),
                    resp_body
                )
            };
            sock.write_all(out.as_bytes()).await.expect("write resp");
        }
    }

    fn rand_suffix() -> u64 {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        N.fetch_add(1, Ordering::SeqCst)
    }

    #[tokio::test]
    async fn describe_instance_parses_running_state() {
        let (api, path) = FakeApi::new(|method, path, _| {
            if method == "GET" && path == "/" {
                (200, "{\"state\":\"Running\",\"id\":\"x\"}")
            } else {
                (500, "")
            }
        });
        let client = ApiClient::new(path);
        let serve = tokio::spawn(api.serve());
        let state = client.describe_instance().await.expect("describe");
        assert_eq!(state, "Running");
        let _ = serve.await;
    }

    #[tokio::test]
    async fn describe_instance_reports_missing_state() {
        let (api, path) = FakeApi::new(|method, path, _| {
            if method == "GET" && path == "/" {
                (200, "{\"id\":\"x\"}")
            } else {
                (500, "")
            }
        });
        let client = ApiClient::new(path);
        let serve = tokio::spawn(api.serve());
        let err = client.describe_instance().await.expect_err("no state");
        assert!(matches!(err, FcError::Data(_)), "got: {err}");
        let _ = serve.await;
    }

    #[tokio::test]
    async fn non_2xx_surfaces_fault_message() {
        let (api, path) = FakeApi::new(|method, path, _| {
            if method == "PUT" && path == "/boot-source" {
                (400, "{\"fault_message\":\"boot source too spicy\"}")
            } else {
                (500, "")
            }
        });
        let client = ApiClient::new(path);
        let serve = tokio::spawn(api.serve());
        let err = client
            .set_boot_source("kernel", "console=ttyS0")
            .await
            .expect_err("400");
        let FcError::Http { status, message } = err else {
            panic!("expected Http error, got {err}");
        };
        assert_eq!(status, 400);
        assert!(message.contains("boot source too spicy"), "{message}");
        let _ = serve.await;
    }

    #[tokio::test]
    async fn success_is_204_no_content() {
        let (api, path) = FakeApi::new(|method, path, body| {
            assert_eq!(method, "PUT");
            assert_eq!(path, "/machine-config");
            let v: Value = serde_json::from_str(body.unwrap()).unwrap();
            assert_eq!(v["vcpu_count"], 2);
            assert_eq!(v["mem_size_mib"], 4096);
            (204, "")
        });
        let client = ApiClient::new(path);
        let serve = tokio::spawn(api.serve());
        client
            .set_machine_config(2, 4096)
            .await
            .expect("machine config");
        let _ = serve.await;
    }
}
