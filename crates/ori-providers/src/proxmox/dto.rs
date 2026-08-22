use serde::Deserialize;

/// PVE wraps every successful response in `{"data": <payload>}`.
#[derive(Debug, Clone, Deserialize)]
pub struct ApiData<T> {
    pub data: T,
}

/// `GET /nodes/{node}/tasks/{upid}/status`.
#[derive(Debug, Clone, Deserialize)]
pub struct TaskStatus {
    /// `running` while the task executes, `stopped` when finished.
    pub status: String,
    /// Present once `status == "stopped"`; `"OK"` on success, otherwise the
    /// failing step's message.
    pub exitstatus: Option<String>,
    #[serde(rename = "type")]
    pub kind: Option<String>,
}

/// `GET /nodes/{node}/lxc/{vmid}/status/current`.
#[derive(Debug, Clone, Deserialize)]
pub struct VmStatusCurrent {
    pub status: String,
    pub name: Option<String>,
}

/// `GET /nodes/{node}/storage` entries.
#[derive(Debug, Clone, Deserialize)]
pub struct StorageEntry {
    pub storage: String,
    #[serde(rename = "type")]
    pub kind: String,
}

/// `GET /nodes` entries.
#[derive(Debug, Clone, Deserialize)]
pub struct NodeEntry {
    pub node: String,
    pub status: Option<String>,
}

/// `GET /nodes/{node}/storage/{storage}/content` entries.
#[derive(Debug, Clone, Deserialize)]
pub struct ContentEntry {
    pub volid: String,
    pub content: String,
}

/// `GET /nodes/{node}/lxc/{vmid}/interfaces` entries.
#[derive(Debug, Clone, Deserialize)]
pub struct Interface {
    pub name: String,
    #[serde(rename = "ip-addresses", default)]
    pub ip_addresses: Vec<IpAddress>,
    #[serde(default)]
    pub inet: Option<String>,
    #[serde(default)]
    pub inet6: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct IpAddress {
    #[serde(rename = "ip-address")]
    pub ip: String,
    #[serde(rename = "ip-address-type")]
    pub kind: String,
}

/// `GET /cluster/nextid` — the smallest free VMID.
#[derive(Debug, Clone, Deserialize)]
pub struct NextId {
    pub data: String,
}

/// `GET /nodes/{node}/lxc/{vmid}/config` — used to read a VM's current
/// cores/memory (for resize preconditions) and hostname.
#[derive(Debug, Clone, Deserialize)]
pub struct VmConfig {
    pub cores: Option<u32>,
    pub memory: Option<u64>,
    pub hostname: Option<String>,
}
