use crate::reconcile::{InstanceHandle, SnapshotRef};

use super::error::PveError;

/// Proxmox instance handle ids are `node/vmid`, e.g. `sandbox/9911`.
pub fn handle_id(node: &str, vmid: u32) -> String {
    format!("{node}/{vmid}")
}

/// Proxmox snapshot ref ids are `node/vmid/snapshot-name`.
pub fn snapshot_id(node: &str, vmid: u32, name: &str) -> String {
    format!("{node}/{vmid}/{name}")
}

pub fn handle_for(node: &str, vmid: u32) -> InstanceHandle {
    InstanceHandle {
        provider: "proxmox".to_string(),
        id: handle_id(node, vmid),
    }
}

pub fn snapshot_ref_for(node: &str, vmid: u32, name: &str) -> SnapshotRef {
    SnapshotRef {
        provider: "proxmox".to_string(),
        id: snapshot_id(node, vmid, name),
        name: name.to_string(),
    }
}

/// Parse an `InstanceHandle` created by this provider.
pub fn parse_handle(h: &InstanceHandle) -> Result<(String, u32), PveError> {
    if h.provider != "proxmox" {
        return Err(PveError::WrongProvider(h.provider.clone()));
    }
    let (node, vmid) = h
        .id
        .split_once('/')
        .ok_or_else(|| PveError::MalformedHandle(h.id.clone()))?;
    let vmid = vmid
        .parse()
        .map_err(|_| PveError::MalformedHandle(h.id.clone()))?;
    Ok((node.to_string(), vmid))
}

/// Parse a `SnapshotRef` created by this provider into (node, vmid, name).
pub fn parse_snapshot_ref(s: &SnapshotRef) -> Result<(String, u32, String), PveError> {
    if s.provider != "proxmox" {
        return Err(PveError::WrongProvider(s.provider.clone()));
    }
    let mut parts = s.id.splitn(3, '/');
    let node = parts.next().ok_or_else(|| PveError::MalformedSnapshotRef(s.id.clone()))?;
    let vmid = parts
        .next()
        .ok_or_else(|| PveError::MalformedSnapshotRef(s.id.clone()))?
        .parse()
        .map_err(|_| PveError::MalformedSnapshotRef(s.id.clone()))?;
    let name = parts
        .next()
        .ok_or_else(|| PveError::MalformedSnapshotRef(s.id.clone()))?;
    if name.is_empty() {
        return Err(PveError::MalformedSnapshotRef(s.id.clone()));
    }
    Ok((node.to_string(), vmid, name.to_string()))
}