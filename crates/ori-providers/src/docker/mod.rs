//! Docker Engine backend (`Provider` impl) over the docker API (`bollard`).
//!
//! This provider is the proof that the `Provider` abstraction is real: it is a
//! second, genuinely different backend next to Proxmox, and it needed **no
//! trait change** — the abstraction's one Proxmox-shaped assumption (a
//! caller-allocated `vmid`) is ignored here, and the rest maps directly.
//!
//! Operation mapping:
//!
//! | `Provider` | docker call |
//! |---|---|
//! | `create` | pull image if missing, `create_container` (named), then `start_container` |
//! | `clone_from` | `create_container` from the snapshot image, left **stopped** |
//! | `snapshot` | `commit_container` → image tag as the `SnapshotRef` |
//! | `rollback` | `remove_container` + recreate from the snapshot image |
//! | `stop` | commit (`StopMode::Snapshot`) then `stop_container` |
//! | `start` | `start_container` |
//! | `destroy` | `remove_container --force` |
//! | `resize` | `update_container` (NanoCpus + Memory), online |
//! | `exec` | `create_exec` / `start_exec` / `inspect_exec` |
//! | `addresses` | `inspect_container` → `NetworkSettings.Networks` |
//!
//! Handles are container names; snapshot refs are committed image tags (both
//! opaque provider-scoped strings, see [`handle`]).
//!
//! Capabilities are declared honestly:
//! - `linked_clone: true` — image layers are copy-on-write, so a container
//!   from a committed image is O(1) in disk.
//! - `fs_snapshot: true` — `commit` works while the container is running.
//! - **`live_suspend: false`** — `docker pause` freezes a container but does
//!   not persist state, so it is not resume-across-restart. Do not claim it.
//! - `resize_online: true` — `docker update` changes NanoCpus/Memory live.
//! - `nested_containers` only when running privileged (docker-in-docker needs
//!   `--privileged` plus a guest-side docker runtime).
//! - `desktop: false` — no guest-side VNC/WebRTC story on containers.
//!
//! `exec` here is the bootstrap-only fallback (the primary path is the guest
//! agent over the control-plane tunnel, C6).

pub mod error;
pub mod handle;

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use bollard::container::LogOutput;
use bollard::exec::{CreateExecOptions, StartExecOptions, StartExecResults};
use bollard::models::{
    ContainerConfig, ContainerCreateBody, ContainerStateStatusEnum, ContainerUpdateBody, HostConfig,
};
use bollard::query_parameters::{
    CommitContainerOptionsBuilder, CreateContainerOptionsBuilder, CreateImageOptionsBuilder,
    RemoveContainerOptionsBuilder,
};
use bollard::Docker;
use futures_util::StreamExt;

pub use error::DockerError;
pub use handle::{
    container_name_for, handle_for, memory_bytes_for, nano_cpus_for, parse_handle,
    parse_snapshot_ref, snapshot_ref_for,
};

use crate::reconcile::{
    Addresses, Capabilities, Error, ExecRequest, ExecResult, InstanceHandle, InstanceSpec,
    InstanceStatus, MachineType, Provider, SnapshotRef, StopMode,
};

fn default_image() -> String {
    "alpine:latest".to_string()
}

fn default_snapshot_repo() -> String {
    handle::SNAPSHOT_REPO.to_string()
}

fn default_exec_timeout_secs() -> u64 {
    60
}

/// Configuration for the Docker provider. `serde`-deserializable so the server
/// can construct it from JSON config.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct DockerConfig {
    /// Docker Engine host, e.g. `unix:///var/run/docker.sock` or
    /// `tcp://127.0.0.1:2375`. Default: `DOCKER_HOST` env or the platform's
    /// default unix socket.
    #[serde(default)]
    pub host: Option<String>,
    /// Image cold creates are made from, e.g. `alpine:latest`.
    #[serde(default = "default_image")]
    pub image: String,
    /// Repository committed snapshot images are tagged into, e.g. `ori/snapshots`.
    #[serde(default = "default_snapshot_repo")]
    pub snapshot_repo: String,
    /// Network containers join (e.g. `bridge`). Default: the engine default.
    #[serde(default)]
    pub network: Option<String>,
    /// Run containers `--privileged`. The only way `nested_containers` can
    /// hold — docker-in-docker needs privileged plus a guest-side docker
    /// runtime. Off by default.
    #[serde(default)]
    pub privileged: bool,
    /// Override the image's `Cmd` with `sleep infinity` so the container stays
    /// running as a sandbox (docker's default image CMDs like `/bin/sh` exit
    /// immediately, leaving a `Stopped` instance). On by default; set false to
    /// let the image's own process define the container lifecycle.
    #[serde(default = "default_keep_alive")]
    pub keep_alive: bool,
    /// Default `exec` timeout in seconds (default 60).
    #[serde(default = "default_exec_timeout_secs")]
    pub exec_timeout_secs: u64,
}

fn default_keep_alive() -> bool {
    true
}

impl DockerConfig {
    /// Build from `ORI_DOCKER_*` environment variables (used by the integration
    /// and conformance tests).
    pub fn from_env() -> Result<Self, Error> {
        fn truthy(v: Result<String, std::env::VarError>) -> bool {
            matches!(v.as_deref(), Ok("1") | Ok("true") | Ok("yes"))
        }
        Ok(DockerConfig {
            host: std::env::var("ORI_DOCKER_HOST").ok(),
            image: std::env::var("ORI_DOCKER_IMAGE").unwrap_or_else(|_| default_image()),
            snapshot_repo: std::env::var("ORI_DOCKER_SNAPSHOT_REPO")
                .unwrap_or_else(|_| default_snapshot_repo()),
            network: std::env::var("ORI_DOCKER_NETWORK").ok(),
            privileged: truthy(std::env::var("ORI_DOCKER_PRIVILEGED")),
            keep_alive: {
                let v = std::env::var("ORI_DOCKER_KEEP_ALIVE").ok();
                v.map(|s| truthy(Ok(s))).unwrap_or(true)
            },
            exec_timeout_secs: std::env::var("ORI_DOCKER_EXEC_TIMEOUT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or_else(default_exec_timeout_secs),
        })
    }
}

/// The Docker backend.
#[derive(Clone, Debug)]
pub struct DockerProvider {
    docker: Docker,
    config: DockerConfig,
}

impl DockerProvider {
    /// Connect to the docker daemon. `new` is I/O-free beyond checking the
    /// socket path exists; call [`Self::preflight`] for a live daemon ping.
    pub fn new(config: DockerConfig) -> Result<Self, Error> {
        let docker = match &config.host {
            Some(host) => Docker::connect_with_host(host),
            None => Docker::connect_with_defaults(),
        }
        .map_err(|e| map_err(DockerError::from_bollard(e)))?;
        Ok(Self { docker, config })
    }

    /// Live daemon check (`ping`) plus a warn — not a fail — when the
    /// cold-create image is missing locally; `create` pulls it on demand.
    pub async fn preflight(&self) -> Result<(), Error> {
        self.docker
            .ping()
            .await
            .map_err(|e| map_err(DockerError::from_bollard(e)))?;
        match self.image_present(&self.config.image).await {
            Ok(true) => {}
            Ok(false) => tracing::warn!(
                "docker: image {} not present locally; the first create will pull it",
                self.config.image
            ),
            Err(e) => tracing::warn!("docker: cannot inspect image {}: {e}", self.config.image),
        }
        Ok(())
    }

    pub fn config(&self) -> &DockerConfig {
        &self.config
    }

    /// The image a given spec creates from: `spec.template` is the instance's
    /// image (the server fills it from config); fall back to `config.image`.
    fn image_for(&self, spec: &InstanceSpec) -> String {
        if spec.template.is_empty() {
            self.config.image.clone()
        } else {
            spec.template.clone()
        }
    }

    async fn image_present(&self, image: &str) -> Result<bool, Error> {
        match self.docker.inspect_image(image).await {
            Ok(_) => Ok(true),
            Err(e) => {
                let de = DockerError::from_bollard(e);
                match de.status() {
                    Some(404) => Ok(false),
                    _ => Err(map_err(de)),
                }
            }
        }
    }

    /// Pull the image if it is not present locally. Idempotent.
    async fn ensure_image(&self, image: &str) -> Result<(), Error> {
        if self.image_present(image).await? {
            return Ok(());
        }
        tracing::info!("docker: pulling {image}");
        let options = CreateImageOptionsBuilder::default().from_image(image).build();
        let mut stream = self.docker.create_image(Some(options), None, None);
        while let Some(item) = stream.next().await {
            item.map_err(|e| map_err(DockerError::from_bollard(e)))?;
        }
        Ok(())
    }

    /// The create body for an instance: machine-type resource limits, hostname,
    /// and an identifying label. The image varies per call site.
    fn container_body(&self, spec: &InstanceSpec, image: &str) -> ContainerCreateBody {
        let cmd = if self.config.keep_alive {
            Some(vec!["sleep".to_string(), "infinity".to_string()])
        } else {
            None
        };
        ContainerCreateBody {
            image: Some(image.to_string()),
            hostname: Some(spec.name.clone()),
            cmd,
            // `docker stop` waits this long for SIGTERM before SIGKILL. The
            // keep-alive process ignores SIGTERM, so the default 10 s grace is
            // 10 s of dead time per stop; 2 s keeps stop inside budget.
            stop_timeout: Some(2),
            tty: Some(false),
            open_stdin: Some(false),
            attach_stdout: Some(false),
            attach_stderr: Some(false),
            labels: Some([("ori.instance_id".to_string(), spec.id.clone())].into_iter().collect()),
            host_config: Some(HostConfig {
                nano_cpus: Some(nano_cpus_for(&spec.machine_type)),
                memory: Some(memory_bytes_for(&spec.machine_type)),
                network_mode: self.config.network.clone(),
                privileged: Some(self.config.privileged),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    /// `docker create` (never starts). Caller starts explicitly — the warm pool
    /// and fork both start.
    async fn create_container_from_image(
        &self,
        name: &str,
        image: &str,
        spec: &InstanceSpec,
    ) -> Result<(), Error> {
        let options = CreateContainerOptionsBuilder::default().name(name).build();
        let body = self.container_body(spec, image);
        self.docker
            .create_container(Some(options), body)
            .await
            .map(|_| ())
            .map_err(|e| map_err(DockerError::from_bollard(e)))
    }

    /// `docker commit` the container to `repo:tag`. Returns the image ref.
    async fn commit_snapshot(&self, name: &str, tag: &str) -> Result<String, Error> {
        let options = CommitContainerOptionsBuilder::default()
            .container(name)
            .repo(&self.config.snapshot_repo)
            .tag(tag)
            .pause(true)
            .build();
        self.docker
            .commit_container(options, ContainerConfig::default())
            .await
            .map_err(|e| map_err(DockerError::from_bollard(e)))?;
        Ok(format!("{}:{tag}", self.config.snapshot_repo))
    }

    async fn collect_exec(&self, exec_id: &str) -> Result<(Vec<u8>, Vec<u8>), Error> {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        match self.docker.start_exec(exec_id, None::<StartExecOptions>).await {
            Ok(StartExecResults::Attached { mut output, .. }) => {
                while let Some(item) = output.next().await {
                    match item {
                        Ok(LogOutput::StdOut { message }) => stdout.extend_from_slice(&message),
                        Ok(LogOutput::StdErr { message }) => stderr.extend_from_slice(&message),
                        Ok(_) => {}
                        Err(e) => return Err(map_err(DockerError::from_bollard(e))),
                    }
                }
            }
            Ok(StartExecResults::Detached) => {
                return Err(map_err(DockerError::Config(
                    "exec started detached; cannot collect output".to_string(),
                )));
            }
            Err(e) => return Err(map_err(DockerError::from_bollard(e))),
        }
        Ok((stdout, stderr))
    }

    /// Poll `inspect_exec` until the exit code appears (the attached stream can
    /// end a moment before the daemon records the code).
    async fn wait_exec_exit(&self, exec_id: &str) -> Result<i32, Error> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let inspect = self
                .docker
                .inspect_exec(exec_id)
                .await
                .map_err(|e| map_err(DockerError::from_bollard(e)))?;
            if let Some(code) = inspect.exit_code {
                return Ok(code as i32);
            }
            if tokio::time::Instant::now() >= deadline {
                return Ok(-1);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// Create the instance's container (unstarted). Shared by create/clone/rollback.
    async fn recreate_container(&self, name: &str, body: ContainerCreateBody) -> Result<(), Error> {
        let options = CreateContainerOptionsBuilder::default().name(name).build();
        self.docker
            .create_container(Some(options), body)
            .await
            .map(|_| ())
            .map_err(|e| map_err(DockerError::from_bollard(e)))
    }
}

fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Map a docker low-level error into the shared provider error taxonomy.
fn map_err(e: DockerError) -> Error {
    match e {
        DockerError::Http { status, message } => match status {
            404 => Error::NotFound(message),
            409 => Error::Conflict(message),
            429 => Error::RateLimited(message),
            304 => Error::Other(message),
            _ => Error::ProviderUnavailable(format!("docker {status}: {message}")),
        },
        DockerError::Transport(m) | DockerError::Stream(m) | DockerError::Other(m) => {
            Error::ProviderUnavailable(m)
        }
        DockerError::SocketNotFound(path) => {
            Error::ProviderUnavailable(format!("docker socket not found: {path}"))
        }
        DockerError::MalformedHandle(id) => Error::InvalidRequest(format!("malformed handle {id}")),
        DockerError::MalformedSnapshotRef(id) => {
            Error::InvalidRequest(format!("malformed snapshot ref {id}"))
        }
        DockerError::WrongProvider(p) => {
            Error::InvalidRequest(format!("handle belongs to provider {p}"))
        }
        DockerError::Config(m) => Error::InvalidRequest(m),
        DockerError::Io(e) => Error::Other(e.to_string()),
    }
}

#[async_trait]
impl Provider for DockerProvider {
    fn name(&self) -> &'static str {
        "docker"
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            linked_clone: true,
            fs_snapshot: true,
            live_suspend: false,
            resize_online: true,
            desktop: false,
            nested_containers: self.config.privileged,
            max_instances: None,
        }
    }

    /// Cold create from the image, then start. Not idempotent: the same
    /// instance id twice conflicts (docker 409s on the duplicate container
    /// name).
    async fn create(&self, spec: &InstanceSpec) -> Result<InstanceHandle, Error> {
        let image = self.image_for(spec);
        self.ensure_image(&image).await?;
        let name = container_name_for(&spec.id);
        self.create_container_from_image(&name, &image, spec).await?;
        self.docker
            .start_container(&name, None)
            .await
            .map_err(|e| map_err(DockerError::from_bollard(e)))?;
        Ok(handle_for(&spec.id))
    }

    /// Container from the committed snapshot image. The clone is left
    /// **stopped**; the caller starts it. Not idempotent.
    async fn clone_from(
        &self,
        src: &SnapshotRef,
        spec: &InstanceSpec,
    ) -> Result<InstanceHandle, Error> {
        let image = parse_snapshot_ref(src).map_err(map_err)?;
        let name = container_name_for(&spec.id);
        self.create_container_from_image(&name, &image, spec).await?;
        Ok(handle_for(&spec.id))
    }

    /// Idempotent: docker replies 304 (treated as success by bollard) when the
    /// container is already running.
    async fn start(&self, h: &InstanceHandle) -> Result<(), Error> {
        let name = parse_handle(h).map_err(map_err)?;
        self.docker
            .start_container(&name, None)
            .await
            .map_err(|e| map_err(DockerError::from_bollard(e)))
    }

    /// `StopMode::Snapshot` commits first (a stop-{ts} snapshot) then stops;
    /// `Force` skips the commit. Idempotent on an already-stopped container
    /// (docker 304).
    async fn stop(&self, h: &InstanceHandle, mode: StopMode) -> Result<(), Error> {
        let name = parse_handle(h).map_err(map_err)?;
        if mode == StopMode::Snapshot {
            let tag = format!("stop-{}", now_unix_secs());
            self.commit_snapshot(&name, &tag).await?;
        }
        self.docker
            .stop_container(&name, None)
            .await
            .map_err(|e| map_err(DockerError::from_bollard(e)))
    }

    /// Idempotent: destroying a missing container is `Ok`.
    async fn destroy(&self, h: &InstanceHandle) -> Result<(), Error> {
        let name = parse_handle(h).map_err(map_err)?;
        let options = RemoveContainerOptionsBuilder::default().force(true).build();
        match self.docker.remove_container(&name, Some(options)).await {
            Ok(()) => Ok(()),
            Err(e) => {
                let de = DockerError::from_bollard(e);
                match de.status() {
                    Some(404) => Ok(()),
                    _ => Err(map_err(de)),
                }
            }
        }
    }

    async fn status(&self, h: &InstanceHandle) -> Result<InstanceStatus, Error> {
        let name = parse_handle(h).map_err(map_err)?;
        let resp = self
            .docker
            .inspect_container(&name, None)
            .await
            .map_err(|e| map_err(DockerError::from_bollard(e)))?;
        Ok(match resp.state.and_then(|s| s.status) {
            Some(ContainerStateStatusEnum::RUNNING)
            | Some(ContainerStateStatusEnum::RESTARTING)
            | Some(ContainerStateStatusEnum::PAUSED) => InstanceStatus::Running,
            Some(_) => InstanceStatus::Stopped,
            None => InstanceStatus::Unknown,
        })
    }

    /// Filesystem snapshot of a (possibly running) container: commit it to an
    /// image tag that becomes the `SnapshotRef`.
    async fn snapshot(&self, h: &InstanceHandle, name: &str) -> Result<SnapshotRef, Error> {
        let cname = parse_handle(h).map_err(map_err)?;
        self.commit_snapshot(&cname, &handle::snapshot_tag_for(name))
            .await?;
        Ok(snapshot_ref_for(name, &self.config.snapshot_repo))
    }

    /// Management only. Docker rollback is a recreate: drop the live container
    /// and build a fresh one from the snapshot image, preserving the existing
    /// hostname and resource limits. Left stopped; the caller starts it.
    async fn rollback(&self, h: &InstanceHandle, s: &SnapshotRef) -> Result<(), Error> {
        let name = parse_handle(h).map_err(map_err)?;
        let image = parse_snapshot_ref(s).map_err(map_err)?;
        let current = self
            .docker
            .inspect_container(&name, None)
            .await
            .map_err(|e| map_err(DockerError::from_bollard(e)))?;
        let hc = current.host_config.unwrap_or_default();
        let body = ContainerCreateBody {
            image: Some(image.clone()),
            hostname: current
                .config
                .and_then(|c| c.hostname)
                .or(Some(name.clone())),
            stop_timeout: Some(2),
            tty: Some(false),
            open_stdin: Some(false),
            attach_stdout: Some(false),
            attach_stderr: Some(false),
            host_config: Some(HostConfig {
                nano_cpus: hc.nano_cpus,
                memory: hc.memory,
                network_mode: hc.network_mode.or_else(|| self.config.network.clone()),
                privileged: hc.privileged.or(Some(self.config.privileged)),
                ..Default::default()
            }),
            ..Default::default()
        };
        let options = RemoveContainerOptionsBuilder::default().force(true).build();
        match self.docker.remove_container(&name, Some(options)).await {
            Ok(()) => {}
            Err(e) => {
                let de = DockerError::from_bollard(e);
                if de.status() != Some(404) {
                    return Err(map_err(de));
                }
            }
        }
        self.recreate_container(&name, body).await
    }

    /// Idempotent: deleting a missing snapshot is `Ok`. `force` untags even if
    /// a stopped container still references the image.
    async fn snapshot_delete(&self, s: &SnapshotRef) -> Result<(), Error> {
        let image = parse_snapshot_ref(s).map_err(map_err)?;
        let options = bollard::query_parameters::RemoveImageOptionsBuilder::default()
            .force(true)
            .build();
        match self.docker.remove_image(&image, Some(options), None).await {
            Ok(_) => Ok(()),
            Err(e) => {
                let de = DockerError::from_bollard(e);
                match de.status() {
                    Some(404) => Ok(()),
                    _ => Err(map_err(de)),
                }
            }
        }
    }

    /// **Bootstrap-only fallback.** The primary exec path is the guest agent
    /// over the control-plane tunnel (C6); this runs `docker exec` and is only
    /// correct before the agent is up.
    async fn exec(&self, h: &InstanceHandle, req: ExecRequest) -> Result<ExecResult, Error> {
        let name = parse_handle(h).map_err(map_err)?;
        let timeout = req
            .timeout
            .unwrap_or_else(|| Duration::from_secs(self.config.exec_timeout_secs));
        let started_at = Instant::now();
        let exec_config = CreateExecOptions {
            cmd: Some(req.command),
            env: Some(req.env.into_iter().map(|(k, v)| format!("{k}={v}")).collect()),
            working_dir: req.workdir,
            attach_stdout: Some(true),
            attach_stderr: Some(true),
            attach_stdin: Some(false),
            tty: Some(false),
            ..Default::default()
        };
        let (stdout, stderr, exit_code) = tokio::time::timeout(timeout, async {
            let created = self
                .docker
                .create_exec(&name, exec_config)
                .await
                .map_err(|e| map_err(DockerError::from_bollard(e)))?;
            let (stdout, stderr) = self.collect_exec(&created.id).await?;
            let exit_code = self.wait_exec_exit(&created.id).await?;
            Ok::<_, Error>((stdout, stderr, exit_code))
        })
        .await
        .map_err(|_| Error::ProviderUnavailable("exec timed out".to_string()))??;
        Ok(ExecResult {
            exit_code,
            stdout,
            stderr,
            duration: started_at.elapsed(),
        })
    }

    /// Change cpu/memory to the machine type's. `resize_online: true`, so
    /// `docker update` applies it to the running container immediately.
    async fn resize(&self, h: &InstanceHandle, t: MachineType) -> Result<(), Error> {
        let name = parse_handle(h).map_err(map_err)?;
        let body = ContainerUpdateBody {
            nano_cpus: Some(nano_cpus_for(&t)),
            memory: Some(memory_bytes_for(&t)),
            ..Default::default()
        };
        self.docker
            .update_container(&name, body)
            .await
            .map_err(|e| map_err(DockerError::from_bollard(e)))
    }

    async fn addresses(&self, h: &InstanceHandle) -> Result<Addresses, Error> {
        let name = parse_handle(h).map_err(map_err)?;
        let resp = self
            .docker
            .inspect_container(&name, None)
            .await
            .map_err(|e| map_err(DockerError::from_bollard(e)))?;
        let hostname = resp.config.and_then(|c| c.hostname);
        let mut v4: Vec<std::net::IpAddr> = Vec::new();
        let mut v6: Vec<std::net::IpAddr> = Vec::new();
        if let Some(networks) = resp.network_settings.and_then(|n| n.networks) {
            for ep in networks.into_values() {
                if let Some(ip) = ep.ip_address {
                    if let Ok(addr) = ip.parse::<std::net::IpAddr>() {
                        if !addr.is_loopback() && !v4.contains(&addr) {
                            v4.push(addr);
                        }
                    }
                }
                if let Some(ip) = ep.global_ipv6_address {
                    if let Ok(addr) = ip.parse::<std::net::IpAddr>() {
                        if !addr.is_loopback() && !v6.contains(&addr) {
                            v6.push(addr);
                        }
                    }
                }
            }
        }
        Ok(Addresses { v4, v6, hostname })
    }
}