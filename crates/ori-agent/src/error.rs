//! Agent error taxonomy. Small on purpose — the guest agent has no web API to
//! map to, so a flat `AgentError` with a message is the right shape.

/// Errors surfaced by the guest agent.
#[derive(Debug, thiserror::Error)]
pub enum AgentError {
    #[error("config: {0}")]
    Config(String),

    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("tunnel: {0}")]
    Tunnel(String),

    #[error("request {id}: {0}")]
    Request { id: String, #[source] source: Box<AgentError> },

    #[error("{0}")]
    Other(String),
}

impl AgentError {
    /// Wrap a request-scoped failure so the tunnel can tag the error frame
    /// with the request id that caused it.
    pub fn for_request(id: impl Into<String>, err: impl Into<AgentError>) -> Self {
        AgentError::Request {
            id: id.into(),
            source: Box::new(err.into()),
        }
    }
}