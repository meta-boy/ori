//! Provider backends behind cargo features. One trait impl per module.
//!
//! `reconcile` is a temporary mirror of `ori-proto`'s `Provider` trait and
//! domain types; delete it and re-export from `ori_proto` when C1 lands (see
//! its module docs for the reconciliation steps).

/// TODO(reconcile): mirror of `ori-proto`'s `Provider` trait + domain types.
pub mod reconcile;

pub use reconcile::Error;

#[cfg(feature = "proxmox")]
pub mod proxmox;

/// Convenience alias matching the shared error type name.
pub type ProviderError = Error;