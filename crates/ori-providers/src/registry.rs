//! Provider registry: construct providers by name and surface their
//! capabilities so the server can refuse an operation up front instead of
//! failing halfway through it.
//!
//! The registry is deliberately dumb — it is a name → provider map plus a
//! capability lookup. Composition (which providers exist, from which config) is
//! the server's job: it builds each configured backend, registers it under its
//! `Provider::name()`, then consults [`ProviderRegistry::capabilities`] before
//! accepting a create/suspend/fork so a missing capability becomes a clean
//! `4xx` refusal rather than a provider call that dies mid-flight.
//!
//! Example:
//! ```no_run
//! # async fn demo() -> Result<(), Box<dyn std::error::Error>> {
//! use std::sync::Arc;
//! use ori_providers::registry::ProviderRegistry;
//! use ori_providers::reconcile::Provider as _;
//!
//! let mut registry = ProviderRegistry::new();
//! # #[cfg(feature = "docker")]
//! {
//!     let cfg = ori_providers::docker::DockerConfig::from_env()?;
//!     let provider = ori_providers::docker::DockerProvider::new(cfg)?;
//!     registry.register(Arc::new(provider))?;
//! }
//! # #[cfg(feature = "firecracker")]
//! registry.register(Arc::new(ori_providers::firecracker::FirecrackerProvider::new()))?;
//!
//! if let Some(caps) = registry.capabilities("docker") {
//!     // refuse live_suspend up front: docker does not persist pause state.
//!     if !caps.live_suspend {
//!         return Err("live suspend not supported by docker".into());
//!     }
//! }
//! # Ok(())
//! # }
//! ```

use std::collections::HashMap;
use std::sync::Arc;

use crate::reconcile::{Capabilities, Error, Provider};

/// A registry of constructed providers keyed by their `Provider::name()`.
#[derive(Default)]
pub struct ProviderRegistry {
    providers: HashMap<&'static str, Arc<dyn Provider>>,
}

impl std::fmt::Debug for ProviderRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProviderRegistry")
            .field("providers", &self.names())
            .finish()
    }
}

impl ProviderRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a provider under its own name. Duplicate names are a conflict —
    /// a second backend claiming `"proxmox"` would make capability lookups lie.
    pub fn register(&mut self, provider: Arc<dyn Provider>) -> Result<(), Error> {
        let name = provider.name();
        if self.providers.contains_key(name) {
            return Err(Error::Conflict(format!(
                "provider {name} is already registered"
            )));
        }
        self.providers.insert(name, provider);
        Ok(())
    }

    /// The constructed provider for `name`, if registered.
    pub fn get(&self, name: &str) -> Option<Arc<dyn Provider>> {
        self.providers.get(name).cloned()
    }

    /// Registered provider names, sorted for deterministic output.
    pub fn names(&self) -> Vec<&'static str> {
        let mut names: Vec<&'static str> = self.providers.keys().copied().collect();
        names.sort_unstable();
        names
    }

    /// The declared capabilities of `name`, if registered.
    pub fn capabilities(&self, name: &str) -> Option<Capabilities> {
        self.get(name).map(|p| p.capabilities())
    }

    /// Iterate `(name, capabilities)` over every registered provider.
    pub fn all_capabilities(&self) -> impl Iterator<Item = (&'static str, Capabilities)> + '_ {
        self.providers
            .iter()
            .map(|(name, p)| (*name, p.capabilities()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fake provider so the registry is testable without a backend.
    struct Fake(&'static str, Capabilities);

    #[async_trait::async_trait]
    impl Provider for Fake {
        fn name(&self) -> &'static str {
            self.0
        }
        fn capabilities(&self) -> Capabilities {
            self.1
        }
        async fn create(
            &self,
            _spec: &crate::reconcile::InstanceSpec,
        ) -> Result<crate::reconcile::InstanceHandle, Error> {
            Err(Error::ProviderNotImplemented { provider: self.0, operation: "create" })
        }
        async fn clone_from(
            &self,
            _src: &crate::reconcile::SnapshotRef,
            _spec: &crate::reconcile::InstanceSpec,
        ) -> Result<crate::reconcile::InstanceHandle, Error> {
            Err(Error::ProviderNotImplemented { provider: self.0, operation: "clone_from" })
        }
        async fn start(&self, _h: &crate::reconcile::InstanceHandle) -> Result<(), Error> {
            Err(Error::ProviderNotImplemented { provider: self.0, operation: "start" })
        }
        async fn stop(
            &self,
            _h: &crate::reconcile::InstanceHandle,
            _mode: crate::reconcile::StopMode,
        ) -> Result<(), Error> {
            Err(Error::ProviderNotImplemented { provider: self.0, operation: "stop" })
        }
        async fn destroy(&self, _h: &crate::reconcile::InstanceHandle) -> Result<(), Error> {
            Err(Error::ProviderNotImplemented { provider: self.0, operation: "destroy" })
        }
        async fn status(
            &self,
            _h: &crate::reconcile::InstanceHandle,
        ) -> Result<crate::reconcile::InstanceStatus, Error> {
            Err(Error::ProviderNotImplemented { provider: self.0, operation: "status" })
        }
        async fn snapshot(
            &self,
            _h: &crate::reconcile::InstanceHandle,
            _name: &str,
        ) -> Result<crate::reconcile::SnapshotRef, Error> {
            Err(Error::ProviderNotImplemented { provider: self.0, operation: "snapshot" })
        }
        async fn rollback(
            &self,
            _h: &crate::reconcile::InstanceHandle,
            _s: &crate::reconcile::SnapshotRef,
        ) -> Result<(), Error> {
            Err(Error::ProviderNotImplemented { provider: self.0, operation: "rollback" })
        }
        async fn snapshot_delete(
            &self,
            _s: &crate::reconcile::SnapshotRef,
        ) -> Result<(), Error> {
            Err(Error::ProviderNotImplemented { provider: self.0, operation: "snapshot_delete" })
        }
        async fn exec(
            &self,
            _h: &crate::reconcile::InstanceHandle,
            _req: crate::reconcile::ExecRequest,
        ) -> Result<crate::reconcile::ExecResult, Error> {
            Err(Error::ProviderNotImplemented { provider: self.0, operation: "exec" })
        }
        async fn resize(
            &self,
            _h: &crate::reconcile::InstanceHandle,
            _t: crate::reconcile::MachineType,
        ) -> Result<(), Error> {
            Err(Error::ProviderNotImplemented { provider: self.0, operation: "resize" })
        }
        async fn addresses(
            &self,
            _h: &crate::reconcile::InstanceHandle,
        ) -> Result<crate::reconcile::Addresses, Error> {
            Err(Error::ProviderNotImplemented { provider: self.0, operation: "addresses" })
        }
    }

    fn caps() -> Capabilities {
        Capabilities {
            linked_clone: true,
            fs_snapshot: false,
            live_suspend: false,
            resize_online: false,
            desktop: false,
            nested_containers: false,
            max_instances: None,
        }
    }

    #[test]
    fn register_get_and_capabilities_by_name() {
        let mut registry = ProviderRegistry::new();
        registry
            .register(Arc::new(Fake("docker", caps())))
            .expect("register");

        assert_eq!(registry.names(), vec!["docker"]);
        assert!(registry.capabilities("docker").unwrap().linked_clone);
        assert_eq!(registry.capabilities("missing"), None);
        assert_eq!(registry.all_capabilities().count(), 1);
    }

    #[test]
    fn duplicate_name_is_a_conflict() {
        let mut registry = ProviderRegistry::new();
        registry
            .register(Arc::new(Fake("docker", caps())))
            .expect("register");
        let err = registry.register(Arc::new(Fake("docker", caps()))).expect_err("duplicate");
        assert!(err.to_string().contains("docker"), "got: {err}");
    }
}