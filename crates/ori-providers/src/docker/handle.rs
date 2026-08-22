//! Docker instance handles are container names; snapshot refs are image tags.
//! Both are opaque to the server, so the provider defines the encoding.

use crate::reconcile::{InstanceHandle, MachineType, SnapshotRef};

use super::error::DockerError;

/// Fixed prefix on every ori container name. Docker reserves a handful of
/// names (the default bridge, `docker`, …); a prefix makes ori containers
/// identifiable and collision-free regardless of the caller's instance id.
pub const CONTAINER_PREFIX: &str = "ori-";

/// Default repository committed snapshot images are tagged into.
pub const SNAPSHOT_REPO: &str = "ori/snapshots";

/// Docker container names allow `[a-zA-Z0-9][a-zA-Z0-9_.-]*` and are case
/// sensitive. Caller-allocated instance ids (e.g. `mock:1`, UUIDs) are not
/// always valid container names, so the id is sanitized deterministically —
/// the handle id is the sanitized name and round-trips through the server.
pub fn container_name_for(id: &str) -> String {
    let mut name = String::with_capacity(id.len());
    for c in id.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.') {
            name.push(c);
        } else {
            name.push('-');
        }
    }
    if name.is_empty() || !name.as_bytes()[0].is_ascii_alphanumeric() {
        name.insert(0, 'c');
    }
    // 255 chars is the docker limit; stay well under it.
    if name.len() > 128 {
        name.truncate(128);
    }
    format!("{CONTAINER_PREFIX}{name}")
}

/// Image tags allow `[\w][\w.-]{0,127}`. Snapshot names come from the server
/// (e.g. `golden`, `stop-1725…`); sanitize so an odd name cannot 400 the commit.
pub fn snapshot_tag_for(name: &str) -> String {
    let mut tag = String::with_capacity(name.len());
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.') {
            tag.push(c);
        } else {
            tag.push('-');
        }
    }
    if tag.is_empty() || !tag.as_bytes()[0].is_ascii_alphanumeric() {
        tag.insert(0, 't');
    }
    if tag.len() > 128 {
        tag.truncate(128);
    }
    tag
}

pub fn handle_for(id: &str) -> InstanceHandle {
    InstanceHandle {
        provider: "docker".to_string(),
        id: container_name_for(id),
    }
}

pub fn snapshot_ref_for(name: &str, repo: &str) -> SnapshotRef {
    SnapshotRef {
        provider: "docker".to_string(),
        id: format!("{repo}:{}", snapshot_tag_for(name)),
        name: name.to_string(),
    }
}

/// Parse an `InstanceHandle` created by this provider into the container name.
pub fn parse_handle(h: &InstanceHandle) -> Result<String, DockerError> {
    if h.provider != "docker" {
        return Err(DockerError::WrongProvider(h.provider.clone()));
    }
    if h.id.is_empty() {
        return Err(DockerError::MalformedHandle(h.id.clone()));
    }
    Ok(h.id.clone())
}

/// Parse a `SnapshotRef` created by this provider into the committed image ref.
pub fn parse_snapshot_ref(s: &SnapshotRef) -> Result<String, DockerError> {
    if s.provider != "docker" {
        return Err(DockerError::WrongProvider(s.provider.clone()));
    }
    if s.id.is_empty() {
        return Err(DockerError::MalformedSnapshotRef(s.id.clone()));
    }
    Ok(s.id.clone())
}

/// Machine sizing as docker `HostConfig` values. `Small|Default|Large` maps to
/// the same (vcpu, memoryGB) triple as everywhere else; docker expresses cpu as
/// nano-cpus and memory as bytes.
pub const fn nano_cpus_for(t: &MachineType) -> i64 {
    t.vcpu() as i64 * 1_000_000_000
}

pub const fn memory_bytes_for(t: &MachineType) -> i64 {
    t.memory_gb() as i64 * 1024 * 1024 * 1024
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn container_name_sanitizes_non_ascii_and_colons() {
        assert_eq!(container_name_for("sandbox_1"), "ori-sandbox_1");
        assert_eq!(container_name_for("mock:1"), "ori-mock-1");
        assert_eq!(container_name_for("a/b c"), "ori-a-b-c");
    }

    #[test]
    fn container_name_prefixes_non_alphanumeric_leading_char() {
        assert_eq!(container_name_for(":leading"), "ori-c-leading");
        assert_eq!(container_name_for(""), "ori-c");
    }

    #[test]
    fn container_name_is_stable_under_128_chars() {
        let id = "x".repeat(300);
        let name = container_name_for(&id);
        assert!(name.len() <= 128 + CONTAINER_PREFIX.len());
        assert!(name.starts_with(CONTAINER_PREFIX));
    }

    #[test]
    fn snapshot_tag_sanitizes() {
        assert_eq!(snapshot_tag_for("golden"), "golden");
        assert_eq!(snapshot_tag_for("stop-1725000000"), "stop-1725000000");
        assert_eq!(snapshot_tag_for("weird/name"), "weird-name");
        assert_eq!(snapshot_tag_for(""), "t");
    }

    #[test]
    fn handle_round_trips() {
        let h = handle_for("sandbox_1");
        assert_eq!(parse_handle(&h).unwrap(), "ori-sandbox_1");
        assert!(matches!(
            parse_handle(&InstanceHandle {
                provider: "proxmox".to_string(),
                id: "ori-x".to_string(),
            }),
            Err(DockerError::WrongProvider(_))
        ));
        assert!(matches!(
            parse_handle(&InstanceHandle {
                provider: "docker".to_string(),
                id: String::new(),
            }),
            Err(DockerError::MalformedHandle(_))
        ));
    }

    #[test]
    fn snapshot_ref_round_trips() {
        let s = snapshot_ref_for("golden", "ori/snapshots");
        assert_eq!(s.id, "ori/snapshots:golden");
        assert_eq!(parse_snapshot_ref(&s).unwrap(), "ori/snapshots:golden");
        assert!(matches!(
            parse_snapshot_ref(&SnapshotRef {
                provider: "lxc".to_string(),
                id: "ori/snapshots:golden".to_string(),
                name: "golden".to_string(),
            }),
            Err(DockerError::WrongProvider(_))
        ));
    }

    #[test]
    fn machine_sizing_matches_trait_numbers() {
        assert_eq!(nano_cpus_for(&MachineType::Small), 2_000_000_000);
        assert_eq!(
            memory_bytes_for(&MachineType::Small),
            4 * 1024 * 1024 * 1024
        );
        assert_eq!(
            memory_bytes_for(&MachineType::Large),
            16 * 1024 * 1024 * 1024
        );
    }
}
