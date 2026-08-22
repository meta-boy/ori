//! `host <port>` support: probe whether anything is listening on a port and
//! whether it would be reachable through the control plane's reverse proxy.
//!
//! The single most common user error with `ori host` is binding a service to
//! `127.0.0.1`: the agent can register the port and the plane can mint a URL,
//! but nothing will ever reach the service. The agent detects that case from
//! `/proc/net/tcp` (Linux) and says so, instead of handing back a URL that
//! 404s.

use std::time::Duration;

use crate::procfs::BindKind;

/// Result of probing a port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostProbe {
    /// Anything reachable on the port right now.
    pub listening: bool,
    /// True when the listener is bound to 127.0.0.1 / ::1 only, and therefore
    /// unreachable through the public URL.
    pub loopback_only: bool,
    /// A human note for the most common failure modes.
    pub note: Option<String>,
}

/// Probe a port. On Linux the bind address is read from `/proc/net/tcp[6]`
/// (authoritative for the loopback trap); elsewhere, or when procfs is
/// unavailable, a best-effort loopback connect is used.
pub async fn probe(port: u16) -> HostProbe {
    if let Ok(entries) = crate::procfs::listening_on_port(port) {
        if !entries.is_empty() {
            let any_public = entries.iter().any(|e| e.kind == BindKind::Wildcard);
            let all_loopback = entries.iter().all(|e| e.kind == BindKind::Loopback);
            if any_public {
                return HostProbe {
                    listening: true,
                    loopback_only: false,
                    note: None,
                };
            }
            if all_loopback {
                return HostProbe {
                    listening: true,
                    loopback_only: true,
                    note: Some(
                        "service is bound to 127.0.0.1 (or ::1) and will not be reachable on the \
                         public URL; rebind it to 0.0.0.0"
                            .to_string(),
                    ),
                };
            }
            return HostProbe {
                listening: true,
                loopback_only: false,
                note: Some("bound to a specific interface; ensure it is reachable".to_string()),
            };
        }
    }

    // Fallback: nothing authoritative to say about the bind address. Report
    // reachability on loopback and flag that the bind address is unverified.
    let connected = tokio::time::timeout(
        Duration::from_millis(300),
        tokio::net::TcpStream::connect(("127.0.0.1", port)),
    )
    .await
    .ok()
    .and_then(|r| r.ok())
    .is_some();

    if connected {
        HostProbe {
            listening: true,
            loopback_only: false,
            note: Some("listening on loopback; bind address could not be verified".to_string()),
        }
    } else {
        HostProbe {
            listening: false,
            loopback_only: false,
            note: Some(format!("nothing is listening on port {port}")),
        }
    }
}
