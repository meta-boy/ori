//! In-memory `Provider` impl for tests and for running the control plane with
//! no real hypervisor attached. The warm pool and the Proxmox provider live
//! elsewhere; this is what makes the server runnable and testable anywhere.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::proto::{
    Addresses, Capabilities, ExecRequest, ExecResult, InstanceHandle, InstanceSpec,
    InstanceStatus, MachineType, Provider, ProviderError, SnapshotRef, StopMode,
};

#[derive(Debug, Clone)]
pub struct MockInstance {
    pub state: InstanceStatus,
}

#[derive(Debug, Default)]
pub struct MockRegistry {
    pub instances: HashMap<String, MockInstance>,
    pub stop_calls: u64,
    pub destroy_calls: u64,
    pub snapshot_calls: u64,
    pub create_calls: u64,
}

pub struct MockProvider {
    pub registry: Arc<Mutex<MockRegistry>>,
    pub create_delay: Duration,
    /// When set, the next `create` fails with `Unavailable` — used to test
    /// the error event on the NDJSON stream.
    pub fail_next_create: AtomicBool,
    next_seq: AtomicU64,
    next_pid: AtomicU64,
}

impl MockProvider {
    pub fn new() -> Self {
        MockProvider {
            registry: Arc::new(Mutex::new(MockRegistry::default())),
            create_delay: Duration::ZERO,
            fail_next_create: AtomicBool::new(false),
            next_seq: AtomicU64::new(1),
            next_pid: AtomicU64::new(1000),
        }
    }

    /// With a delay, the NDJSON flush test can assert that lines arrive before
    /// the operation completes.
    pub fn with_create_delay(mut self, d: Duration) -> Self {
        self.create_delay = d;
        self
    }

    fn handle_for(&self, seq: u64) -> InstanceHandle {
        InstanceHandle { provider: "mock".into(), id: seq.to_string() }
    }

    fn register(&self, seq: u64) {
        let handle = self.handle_for(seq);
        self.registry
            .lock()
            .unwrap()
            .instances
            .insert(handle.id.clone(), MockInstance { state: InstanceStatus::Running });
    }

    fn ip_for(&self, seq: u64) -> String {
        format!("10.0.0.{}", seq % 250 + 1)
    }
}

#[async_trait::async_trait]
impl Provider for MockProvider {
    fn name(&self) -> &'static str {
        "mock"
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            linked_clone: true,
            fs_snapshot: true,
            live_suspend: false,
            resize_online: true,
            desktop: false,
            nested_containers: true,
            max_instances: Some(100),
        }
    }

    async fn create(&self, _spec: &InstanceSpec) -> Result<InstanceHandle, ProviderError> {
        if self.fail_next_create.swap(false, Ordering::SeqCst) {
            return Err(ProviderError::Unavailable("mock provider configured to fail".into()));
        }
        if !self.create_delay.is_zero() {
            tokio::time::sleep(self.create_delay).await;
        }
        let seq = self.next_seq.fetch_add(1, Ordering::SeqCst);
        let handle = self.handle_for(seq);
        self.registry.lock().unwrap().create_calls += 1;
        self.register(seq);
        Ok(handle)
    }

    async fn clone_from(
        &self,
        _src: &SnapshotRef,
        _spec: &InstanceSpec,
    ) -> Result<InstanceHandle, ProviderError> {
        let seq = self.next_seq.fetch_add(1, Ordering::SeqCst);
        self.register(seq);
        Ok(self.handle_for(seq))
    }

    async fn start(&self, h: &InstanceHandle) -> Result<(), ProviderError> {
        let mut reg = self.registry.lock().unwrap();
        let entry = reg
            .instances
            .get_mut(&h.id)
            .ok_or_else(|| ProviderError::NotFound(h.id.clone()))?;
        entry.state = InstanceStatus::Running;
        Ok(())
    }

    async fn stop(&self, h: &InstanceHandle, _mode: StopMode) -> Result<(), ProviderError> {
        let mut reg = self.registry.lock().unwrap();
        reg.stop_calls += 1;
        if let Some(entry) = reg.instances.get_mut(&h.id) {
            entry.state = InstanceStatus::Stopped;
        }
        // Idempotent: stopping a missing instance is Ok, per the trait contract.
        Ok(())
    }

    async fn destroy(&self, h: &InstanceHandle) -> Result<(), ProviderError> {
        let mut reg = self.registry.lock().unwrap();
        reg.destroy_calls += 1;
        reg.instances.remove(&h.id);
        Ok(())
    }

    async fn status(&self, h: &InstanceHandle) -> Result<InstanceStatus, ProviderError> {
        let reg = self.registry.lock().unwrap();
        match reg.instances.get(&h.id) {
            Some(inst) => Ok(inst.state.clone()),
            None => Ok(InstanceStatus::Missing),
        }
    }

    async fn snapshot(&self, h: &InstanceHandle, name: &str) -> Result<SnapshotRef, ProviderError> {
        self.registry.lock().unwrap().snapshot_calls += 1;
        Ok(SnapshotRef { provider: "mock".into(), name: format!("{}-{name}", h.id) })
    }

    async fn rollback(
        &self,
        _h: &InstanceHandle,
        _s: &SnapshotRef,
    ) -> Result<(), ProviderError> {
        Ok(())
    }

    async fn snapshot_delete(&self, _s: &SnapshotRef) -> Result<(), ProviderError> {
        Ok(())
    }

    async fn exec(&self, h: &InstanceHandle, req: &ExecRequest) -> Result<ExecResult, ProviderError> {
        let _seq: u64 = h.id.split(':').nth(1).unwrap_or("1").parse().unwrap_or(1);
        let pid = self.next_pid.fetch_add(1, Ordering::SeqCst);
        let cmdline = req.cmd.join(" ");
        let (exit_code, stdout, stderr) = if req.cmd.first().map(|c| c == "fail").unwrap_or(false) {
            (1, String::new(), format!("command failed: {cmdline}"))
        } else {
            (0, format!("{cmdline}\n"), String::new())
        };
        Ok(ExecResult {
            pid: pid as i64,
            completed: true,
            exit_code,
            stdout,
            stderr,
            duration_ms: 1,
        })
    }

    async fn resize(&self, _h: &InstanceHandle, _t: MachineType) -> Result<(), ProviderError> {
        Ok(())
    }

    async fn addresses(&self, h: &InstanceHandle) -> Result<Addresses, ProviderError> {
        let seq: u64 = h.id.split(':').nth(1).unwrap_or("1").parse().unwrap_or(1);
        Ok(Addresses { ip: Some(self.ip_for(seq)), desktop_url: None })
    }
}

impl Default for MockProvider {
    fn default() -> Self {
        MockProvider::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[tokio::test]
    async fn lifecycle() {
        let p = MockProvider::new();
        let spec = InstanceSpec {
            name: "t".into(),
            machine_type: MachineType::Default,
            environment: "base".into(),
            environment_version: 1,
            env_vars: HashMap::new(),
        };
        let h = p.create(&spec).await.unwrap();
        assert_eq!(p.status(&h).await.unwrap(), InstanceStatus::Running);
        p.stop(&h, StopMode::Snapshot).await.unwrap();
        assert_eq!(p.status(&h).await.unwrap(), InstanceStatus::Stopped);
        // idempotent stop
        p.stop(&h, StopMode::Force).await.unwrap();
        p.start(&h).await.unwrap();
        assert_eq!(p.status(&h).await.unwrap(), InstanceStatus::Running);
        let addr = p.addresses(&h).await.unwrap();
        assert!(addr.ip.is_some());
        p.destroy(&h).await.unwrap();
        assert_eq!(p.status(&h).await.unwrap(), InstanceStatus::Missing);
        // idempotent destroy
        p.destroy(&h).await.unwrap();
    }

    #[tokio::test]
    async fn exec_semantics() {
        let p = MockProvider::new();
        let h = p.create(&InstanceSpec {
            name: "t".into(),
            machine_type: MachineType::Default,
            environment: "base".into(),
            environment_version: 1,
            env_vars: HashMap::new(),
        }).await.unwrap();
        let ok = p.exec(&h, &ExecRequest { cmd: vec!["echo".into(), "hi".into()], cwd: None, timeout_secs: None, env: HashMap::new() }).await.unwrap();
        assert_eq!(ok.exit_code, 0);
        assert!(ok.stdout.contains("echo hi"));
        let bad = p.exec(&h, &ExecRequest { cmd: vec!["fail".into()], cwd: None, timeout_secs: None, env: HashMap::new() }).await.unwrap();
        assert_eq!(bad.exit_code, 1);
        assert!(bad.stderr.contains("failed"));
    }
}