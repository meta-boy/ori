use std::time::Duration;

use reqwest::Method;
use serde::de::DeserializeOwned;

use super::dto::{
    ContentEntry, Interface, NextId, NodeEntry, StorageEntry, TaskStatus, VmConfig, VmStatusCurrent,
};
use super::error::PveError;

/// How often the UPID poller re-checks a task's status.
pub const TASK_POLL_INTERVAL: Duration = Duration::from_millis(500);
/// How often `wait_vm_status` re-checks an instance's state.
pub const VM_POLL_INTERVAL: Duration = Duration::from_millis(500);

/// Thin HTTP client over the Proxmox REST API (`/api2/json`).
///
/// The single most important rule of this client: **every mutating call returns
/// a UPID task id and HTTP 200 only means "queued"**. All mutations go through
/// [`PveClient::wait_task`], which polls the task to completion and only then
/// treats the operation as done.
#[derive(Clone, Debug)]
pub struct PveClient {
    /// Node all operations target.
    pub node: String,
    base: String,
    auth: Option<String>,
    http: reqwest::Client,
}

impl PveClient {
    /// Build from config. `base` becomes `{host}/api2/json`.
    pub fn new(config: &crate::proxmox::ProxmoxConfig, http: reqwest::Client) -> Self {
        let base = format!("{}/api2/json", config.host.trim_end_matches('/'));
        let auth = Some(format!(
            "PVEAPIToken={}={}",
            config.token_id, config.token_secret
        ));
        Self {
            node: config.node.clone(),
            base,
            auth,
            http,
        }
    }

    /// Build with an explicit base URL (no auth header). Used by tests against
    /// a mock server and by tools that already hold a token out-of-band.
    pub fn from_parts(
        node: impl Into<String>,
        base: impl Into<String>,
        auth: Option<String>,
        http: reqwest::Client,
    ) -> Self {
        Self {
            node: node.into(),
            base: base.into(),
            auth,
            http,
        }
    }

    /// Send a request and return the raw body text on success.
    async fn send(
        &self,
        method: Method,
        path: &str,
        form: Option<&[(String, String)]>,
    ) -> Result<String, PveError> {
        let url = format!("{}/{}", self.base.trim_end_matches('/'), path.trim_start_matches('/'));
        let mut req = self.http.request(method.clone(), &url);
        if let Some(auth) = &self.auth {
            req = req.header("Authorization", auth);
        }
        if let Some(form) = form {
            req = req.form(form);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| PveError::Transport {
                path: url.clone(),
                source: e,
            })?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| PveError::Transport {
                path: url.clone(),
                source: e,
            })?;
        if !status.is_success() {
            return Err(PveError::from_http(status, &url, text));
        }
        Ok(text)
    }

    /// Parse a successful body's `data` payload into `T`.
    fn parse_data<T: DeserializeOwned>(text: &str, path: &str) -> Result<T, PveError> {
        let value: serde_json::Value = serde_json::from_str(text).map_err(|e| {
            PveError::UnexpectedResponse {
                path: path.to_string(),
                body: format!("{e}: {text}"),
            }
        })?;
        let data = value.get("data").ok_or_else(|| PveError::UnexpectedResponse {
            path: path.to_string(),
            body: text.to_string(),
        })?;
        serde_json::from_value(data.clone()).map_err(|e| PveError::Data(format!("{path}: {e}")))
    }

    pub async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T, PveError> {
        let text = self.send(Method::GET, path, None).await?;
        Self::parse_data(&text, path)
    }

    /// Return the raw response body text for a GET (used where the caller
    /// needs the full JSON, e.g. the permissions dump).
    pub async fn get_raw_text(&self, path: &str) -> Result<String, PveError> {
        self.send(Method::GET, path, None).await
    }

    /// POST a form and deserialize `data`. Mutations that return a UPID use
    /// [`PveClient::post_task`].
    pub async fn post<T: DeserializeOwned>(
        &self,
        path: &str,
        form: &[(String, String)],
    ) -> Result<T, PveError> {
        let text = self.send(Method::POST, path, Some(form)).await?;
        Self::parse_data(&text, path)
    }

    /// PUT a form and deserialize `data` (PVE returns `{"data": null}`).
    pub async fn put<T: DeserializeOwned>(
        &self,
        path: &str,
        form: &[(String, String)],
    ) -> Result<T, PveError> {
        let text = self.send(Method::PUT, path, Some(form)).await?;
        Self::parse_data(&text, path)
    }

    /// DELETE and deserialize `data`.
    pub async fn delete<T: DeserializeOwned>(&self, path: &str) -> Result<T, PveError> {
        let text = self.send(Method::DELETE, path, None).await?;
        Self::parse_data(&text, path)
    }

    /// A mutating call returns a UPID. Extract it; the caller must route it
    /// through [`PveClient::wait_task`].
    pub async fn post_task(&self, path: &str, form: &[(String, String)]) -> Result<String, PveError> {
        let text = self.send(Method::POST, path, Some(form)).await?;
        let upid: String = Self::parse_data(&text, path)?;
        if upid.is_empty() || !upid.starts_with("UPID:") {
            return Err(PveError::UnexpectedResponse {
                path: path.to_string(),
                body: text,
            });
        }
        Ok(upid)
    }

    /// Like [`PveClient::post_task`] but for DELETE, which PVE also answers
    /// with a UPID.
    pub async fn delete_task(&self, path: &str) -> Result<String, PveError> {
        let text = self.send(Method::DELETE, path, None).await?;
        let upid: String = Self::parse_data(&text, path)?;
        if upid.is_empty() || !upid.starts_with("UPID:") {
            return Err(PveError::UnexpectedResponse {
                path: path.to_string(),
                body: text,
            });
        }
        Ok(upid)
    }

    /// `GET /nodes/{node}/tasks/{upid}/status`.
    pub async fn task_status(&self, upid: &str) -> Result<TaskStatus, PveError> {
        let path = format!("nodes/{}/tasks/{upid}/status", self.node);
        self.get(&path).await
    }

    /// **The UPID poller.** Route every mutation through this.
    ///
    /// Polls `GET /nodes/{node}/tasks/{upid}/status` every
    /// [`TASK_POLL_INTERVAL`] until `status == "stopped"`, then requires
    /// `exitstatus == "OK"`. A task that stops with a non-OK exit status, or
    /// that is still running past `timeout`, surfaces as an error — the HTTP
    /// 200 that queued the task is *never* treated as success.
    pub async fn wait_task(&self, upid: &str, timeout: Duration) -> Result<(), PveError> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let st = self.task_status(upid).await?;
            match st.status.as_str() {
                "stopped" => {
                    if st.exitstatus.as_deref() == Some("OK") {
                        return Ok(());
                    }
                    return Err(PveError::TaskFailed {
                        upid: upid.to_string(),
                        reason: st
                            .exitstatus
                            .unwrap_or_else(|| "stopped without exit status".to_string()),
                    });
                }
                "error" => {
                    return Err(PveError::TaskFailed {
                        upid: upid.to_string(),
                        reason: st
                            .exitstatus
                            .unwrap_or_else(|| "task entered error state".to_string()),
                    });
                }
                // "running", or anything unexpected: keep polling.
                _ => {
                    if tokio::time::Instant::now() >= deadline {
                        return Err(PveError::TaskTimeout {
                            upid: upid.to_string(),
                            timeout,
                        });
                    }
                    tokio::time::sleep(TASK_POLL_INTERVAL).await;
                }
            }
        }
    }

    /// Poll `status/current` until it reads `want` or `timeout` elapses.
    pub async fn wait_vm_status(
        &self,
        vmid: u32,
        want: &str,
        timeout: Duration,
    ) -> Result<(), PveError> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            match self.vm_status(vmid).await {
                Ok(st) if st.status == want => return Ok(()),
                Ok(_) => {}
                Err(e) => return Err(e),
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(PveError::StateTimeout {
                    handle: format!("{}/{}", self.node, vmid),
                    want: want.to_string(),
                    timeout,
                });
            }
            tokio::time::sleep(VM_POLL_INTERVAL).await;
        }
    }

    pub async fn nextid(&self) -> Result<u32, PveError> {
        let text = self.send(Method::GET, "cluster/nextid", None).await?;
        let envelope: NextId = serde_json::from_str(&text).map_err(|e| {
            PveError::UnexpectedResponse {
                path: "cluster/nextid".to_string(),
                body: format!("{e}: {text}"),
            }
        })?;
        envelope
            .data
            .parse()
            .map_err(|e| PveError::Data(format!("nextid {:?}: {e}", envelope.data)))
    }

    /// `GET /nodes`.
    pub async fn nodes(&self) -> Result<Vec<NodeEntry>, PveError> {
        self.get("nodes").await
    }

    /// `GET /nodes/{node}/storage`.
    pub async fn storages(&self) -> Result<Vec<StorageEntry>, PveError> {
        self.get(&format!("nodes/{}/storage", self.node)).await
    }

    /// `GET /nodes/{node}/storage/{storage}/content?content={content_type}`.
    pub async fn storage_content(
        &self,
        storage: &str,
        content_type: &str,
    ) -> Result<Vec<ContentEntry>, PveError> {
        self.get(&format!(
            "nodes/{}/storage/{storage}/content?content={content_type}",
            self.node
        ))
        .await
    }

    /// `GET /nodes/{node}/lxc/{vmid}/status/current`.
    pub async fn vm_status(&self, vmid: u32) -> Result<VmStatusCurrent, PveError> {
        self.get(&format!("nodes/{}/lxc/{vmid}/status/current", self.node))
            .await
    }

    /// `GET /nodes/{node}/lxc/{vmid}/config`.
    pub async fn vm_config(&self, vmid: u32) -> Result<VmConfig, PveError> {
        self.get(&format!("nodes/{}/lxc/{vmid}/config", self.node))
            .await
    }

    /// `GET /nodes/{node}/lxc/{vmid}/interfaces`.
    pub async fn interfaces(&self, vmid: u32) -> Result<Vec<Interface>, PveError> {
        self.get(&format!("nodes/{}/lxc/{vmid}/interfaces", self.node))
            .await
    }

    /// `GET /nodes/{node}/lxc` — VMIDs currently on the node.
    pub async fn lxc_vmids(&self) -> Result<Vec<u32>, PveError> {
        let text = self.send(Method::GET, &format!("nodes/{}/lxc", self.node), None).await?;
        let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
            PveError::UnexpectedResponse {
                path: format!("nodes/{}/lxc", self.node),
                body: format!("{e}: {text}"),
            }
        })?;
        let data = value.get("data").ok_or_else(|| PveError::UnexpectedResponse {
            path: format!("nodes/{}/lxc", self.node),
            body: text.clone(),
        })?;
        let arr = data
            .as_array()
            .ok_or_else(|| PveError::UnexpectedResponse {
                path: format!("nodes/{}/lxc", self.node),
                body: text,
            })?;
        let mut vmids: Vec<u32> = arr
            .iter()
            .filter_map(|v| v.get("vmid").and_then(|x| x.as_u64()))
            .filter_map(|x| u32::try_from(x).ok())
            .collect();
        vmids.sort_unstable();
        Ok(vmids)
    }

    /// `POST /nodes/{node}/lxc` → UPID.
    pub async fn create_lxc(&self, form: &[(String, String)]) -> Result<String, PveError> {
        let path = format!("nodes/{}/lxc", self.node);
        self.post_task(&path, form).await
    }

    /// `POST /nodes/{node}/lxc/{vmid}/clone` → UPID.
    pub async fn clone_lxc(&self, vmid: u32, form: &[(String, String)]) -> Result<String, PveError> {
        let path = format!("nodes/{}/lxc/{vmid}/clone", self.node);
        self.post_task(&path, form).await
    }

    /// `POST /nodes/{node}/lxc/{vmid}/snapshot` → UPID. Filesystem-only: we
    /// never pass `vmstate` (memory-state suspend is not supported here — CRIU
    /// measured failing — and this PVE rejects it on the LXC schema).
    pub async fn snapshot_lxc(&self, vmid: u32, name: &str) -> Result<String, PveError> {
        let path = format!("nodes/{}/lxc/{vmid}/snapshot", self.node);
        let form = vec![("snapname".to_string(), name.to_string())];
        self.post_task(&path, &form).await
    }

    /// `DELETE /nodes/{node}/lxc/{vmid}/snapshot/{name}` → UPID.
    pub async fn snapshot_delete(&self, vmid: u32, name: &str) -> Result<String, PveError> {
        let path = format!("nodes/{}/lxc/{vmid}/snapshot/{name}", self.node);
        self.delete_task(&path).await
    }

    /// `POST /nodes/{node}/lxc/{vmid}/snapshot/{name}/rollback` → UPID.
    pub async fn rollback_lxc(&self, vmid: u32, name: &str) -> Result<String, PveError> {
        let path = format!("nodes/{}/lxc/{vmid}/snapshot/{name}/rollback", self.node);
        self.post_task(&path, &[]).await
    }

    /// `POST /nodes/{node}/lxc/{vmid}/status/start` → UPID.
    pub async fn start_lxc(&self, vmid: u32) -> Result<String, PveError> {
        let path = format!("nodes/{}/lxc/{vmid}/status/start", self.node);
        self.post_task(&path, &[]).await
    }

    /// `POST /nodes/{node}/lxc/{vmid}/status/stop` → UPID.
    pub async fn stop_lxc(&self, vmid: u32) -> Result<String, PveError> {
        let path = format!("nodes/{}/lxc/{vmid}/status/stop", self.node);
        self.post_task(&path, &[]).await
    }

    /// `DELETE /nodes/{node}/lxc/{vmid}` → UPID. PVE refuses to destroy a running
    /// container unless `force=1`, which stops it first. destroy must work on
    /// any state (idempotent), so force is always on.
    pub async fn destroy_lxc(&self, vmid: u32) -> Result<String, PveError> {
        let path = format!("nodes/{}/lxc/{vmid}?force=1", self.node);
        self.delete_task(&path).await
    }

    /// `PUT /nodes/{node}/lxc/{vmid}/config` — synchronous, no UPID.
    pub async fn resize_lxc(
        &self,
        vmid: u32,
        cores: u32,
        memory_mb: u64,
    ) -> Result<(), PveError> {
        let path = format!("nodes/{}/lxc/{vmid}/config", self.node);
        let form = vec![
            ("cores".to_string(), cores.to_string()),
            ("memory".to_string(), memory_mb.to_string()),
        ];
        let _: serde_json::Value = self.put(&path, &form).await?;
        Ok(())
    }
}