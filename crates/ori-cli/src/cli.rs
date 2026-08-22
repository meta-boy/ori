//! The complete clap surface for the `ori` binary, matching `docs/SPEC-CLI.md`:
//! every command, subcommand, short flag, default, and value name.

use clap::{Args, Parser, Subcommand, ValueEnum};

#[derive(Parser)]
#[command(
    name = "ori",
    version,
    about = "ori: run machines in the cloud",
    long_about = "ori: run machines in the cloud.\n\n\
                 `ori <command>` is the client. `ori serve` runs the control plane, \
                 `ori agent` runs inside each sandbox.",
    propagate_version = true
)]
pub struct Cli {
    /// Control-plane API URL (env: ORI_API_URL)
    #[arg(long, global = true, env = "ORI_API_URL", value_name = "URL")]
    pub api_url: Option<String>,

    /// Emit JSON instead of human-readable output; auto-enabled when stdout is not a TTY
    #[arg(long, global = true)]
    pub json: bool,

    /// Skip checking for a newer release
    #[arg(long, global = true)]
    pub no_update: bool,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand)]
pub enum Command {
    /// Create a sandbox
    New(NewArgs),
    /// List sandboxes
    List(ListArgs),
    /// Detail for one sandbox
    Info(InfoArgs),
    /// Snapshot, then power off
    Stop(StopArgs),
    /// Start a stopped sandbox
    Resume(ResumeArgs),
    /// New sandbox from a snapshot of another
    Fork(ForkArgs),
    /// Change the auto-stop deadline
    Extend(ExtendArgs),
    /// Permanently delete a sandbox
    Delete(DeleteArgs),
    /// Async operation status
    Operation(OperationArgs),
    /// Interactive shell, or run one command
    #[command(trailing_var_arg = true)]
    Ssh(SshArgs),
    /// Run a command via the API, no SSH
    #[command(trailing_var_arg = true)]
    Exec(ExecArgs),
    /// Copy files; <id>:<path> for remote
    Scp(ScpArgs),
    /// Forward a TCP port to localhost
    Forward(ForwardArgs),
    /// Expose a port on a stable HTTPS URL
    Host(HostArgs),
    /// Open the graphical desktop
    Desktop(DesktopArgs),
    /// List snapshots, all sandboxes or one
    Snapshots(SnapshotsArgs),
    /// Filesystem snapshots
    #[command(subcommand)]
    Snapshot(SnapshotCommand),
    /// Named bundles of repos, variables, secrets, safety toggles
    #[command(subcommand)]
    Env(EnvCommand),
    /// Log in (API key, or device-code)
    Login(LoginArgs),
    /// Forget the stored token
    Logout(LogoutArgs),
    /// Account, api, config
    Status(StatusArgs),
    /// Plan, quota, rate limits
    Limits(LimitsArgs),
    /// Manage API keys
    #[command(subcommand)]
    ApiKey(ApiKeyCommand),
    /// Lifecycle webhooks
    #[command(subcommand)]
    Webhook(WebhookCommand),
    /// Billing scopes
    #[command(subcommand)]
    Team(TeamCommand),
    /// Delete-on-stop toggle
    #[command(subcommand)]
    DataRetention(DataRetentionCommand),
    /// Open the dashboard
    Dashboard(DashboardArgs),
    /// Self-update
    SelfUpdate(SelfUpdateArgs),
    /// Shell completions (bash/zsh/fish/powershell)
    Completions(CompletionsArgs),
    /// Drive a coding agent inside a sandbox
    Prompt(PromptArgs),
    /// Interrupt the agent inside a sandbox
    Interrupt(InterruptArgs),
    /// Stream agent events from a sandbox
    Events(EventsArgs),
    /// Run the control plane
    Serve(ServeArgs),
    /// Guest agent (Linux only)
    Agent(AgentArgs),
    #[command(name = "_debug", hide = true)]
    Debug(DebugArgs),
    #[command(name = "_complete-sandbox", hide = true)]
    CompleteSandbox(CompleteSandboxArgs),
}

// ---------------------------------------------------------------------------
// Lifecycle

#[derive(Args)]
pub struct NewArgs {
    /// Machine type: small|default|large
    #[arg(long = "type", value_name = "TYPE")]
    pub type_: Option<String>,
    /// Auto-stop after N seconds
    #[arg(long, value_name = "SECS")]
    pub ttl: Option<u64>,
    /// Disable auto-stop
    #[arg(long)]
    pub no_auto_stop: bool,
    /// Environment variable, KEY=VALUE (repeatable)
    #[arg(short = 'e', long = "env", value_name = "KEY=VALUE")]
    pub env: Vec<String>,
    /// Create with none of the account's stored secrets; one-way
    #[arg(long)]
    pub no_env: bool,
    /// Setup script file to run on first boot
    #[arg(long, value_name = "PATH")]
    pub setup_file: Option<String>,
    /// Environment bundle name
    #[arg(long, value_name = "NAME")]
    pub environment: Option<String>,
    /// Create from a snapshot
    #[arg(long, value_name = "SNAPSHOT")]
    pub from: Option<String>,
    /// Bill to this team
    #[arg(long, value_name = "ID")]
    pub team: Option<String>,
    /// Bill to the personal scope
    #[arg(long)]
    pub personal: bool,
}

#[derive(Args)]
pub struct ListArgs {
    /// Filter by state group: r/s/p/t/e
    #[arg(long, default_value = "r", value_name = "RSPTE")]
    pub filter: String,
    /// List all states (rspte)
    #[arg(long)]
    pub all: bool,
}

#[derive(Args)]
pub struct InfoArgs {
    /// Sandbox id, or current/self inside a sandbox
    pub id: String,
}

#[derive(Args)]
pub struct StopArgs {
    /// Sandbox id, or current/self inside a sandbox
    pub id: String,
    /// Skip the snapshot; loses everything since the last one
    #[arg(long)]
    pub force: bool,
}

#[derive(Args, Clone)]
pub struct ResumeOptions {
    /// Machine type: small|default|large
    #[arg(long = "type", value_name = "TYPE")]
    pub type_: Option<String>,
    /// Auto-stop after N seconds
    #[arg(long, value_name = "SECS")]
    pub ttl: Option<u64>,
    /// Disable auto-stop
    #[arg(long)]
    pub no_auto_stop: bool,
    /// Environment variable, KEY=VALUE (repeatable)
    #[arg(short = 'e', long = "env", value_name = "KEY=VALUE")]
    pub env: Vec<String>,
    /// Use none of the account's stored secrets
    #[arg(long)]
    pub no_env: bool,
    /// Environment bundle name
    #[arg(long, value_name = "NAME")]
    pub environment: Option<String>,
}

#[derive(Args)]
pub struct ResumeArgs {
    /// Sandbox id, or current/self inside a sandbox
    pub id: String,
    #[command(flatten)]
    pub opts: ResumeOptions,
}

#[derive(Args)]
pub struct ForkArgs {
    /// Sandbox id, or current/self inside a sandbox
    pub id: String,
    #[command(flatten)]
    pub opts: ResumeOptions,
}

#[derive(Args)]
pub struct ExtendArgs {
    /// Sandbox id, or current/self inside a sandbox
    pub id: String,
    /// Extend by N hours
    #[arg(long, value_name = "N")]
    pub hours: Option<u32>,
    /// Set auto-stop to N seconds from now
    #[arg(long, value_name = "SECS")]
    pub ttl: Option<u64>,
    /// Disable auto-stop
    #[arg(long)]
    pub no_auto_stop: bool,
}

#[derive(Args)]
pub struct DeleteArgs {
    /// Sandbox id, or current/self inside a sandbox
    pub id: String,
    /// Skip the confirmation prompt
    #[arg(long)]
    pub yes: bool,
}

#[derive(Args)]
pub struct OperationArgs {
    /// Async operation id (oriop_...)
    pub id: String,
}

// ---------------------------------------------------------------------------
// Access

#[derive(Args)]
pub struct SshArgs {
    /// Sandbox id, or current/self inside a sandbox
    pub id: String,
    /// Optional command to run instead of a shell
    pub command: Vec<String>,
}

#[derive(Args)]
pub struct ExecArgs {
    /// Sandbox id, or current/self inside a sandbox
    pub id: String,
    /// Command and arguments to run
    pub command: Vec<String>,
    /// Working directory for the command
    #[arg(long, value_name = "DIR")]
    pub cwd: Option<String>,
    /// Timeout in seconds, 1-600
    #[arg(long, default_value_t = 30, value_parser = clap::value_parser!(u32).range(1..=600), value_name = "SECS")]
    pub timeout: u32,
    /// Start the command and return immediately
    #[arg(long)]
    pub detach: bool,
    /// Query a detached command by pid
    #[arg(long, value_name = "PID")]
    pub status: Option<u64>,
}

#[derive(Args)]
pub struct ScpArgs {
    /// Source; <id>:<path> for remote
    pub src: String,
    /// Destination; <id>:<path> for remote
    pub dst: String,
    /// Copy directories recursively
    #[arg(short = 'r', long)]
    pub recursive: bool,
}

#[derive(Args)]
pub struct ForwardArgs {
    /// Sandbox id, or current/self inside a sandbox
    pub id: String,
    /// Remote port on the sandbox
    #[arg(long, required = true, value_name = "PORT")]
    pub remote: u16,
    /// Local port to listen on (default: the remote port)
    #[arg(long, value_name = "PORT")]
    pub local: Option<u16>,
    /// Address to bind locally
    #[arg(long, default_value = "127.0.0.1", value_name = "ADDR")]
    pub bind: String,
}

#[derive(Args)]
pub struct HostArgs {
    /// Sandbox id, or current/self inside a sandbox
    pub id: String,
    /// Port to expose
    pub port: u16,
    /// Token-gated URL (default)
    #[arg(long, default_value_t = true, conflicts_with = "public")]
    pub private: bool,
    /// Public, unauthenticated URL
    #[arg(long, conflicts_with = "private")]
    pub public: bool,
    /// Page title on the hosted URL
    #[arg(long, value_name = "TEXT")]
    pub title: Option<String>,
}

#[derive(Args)]
pub struct DesktopArgs {
    /// Sandbox id, or current/self inside a sandbox
    pub id: String,
    /// Use VNC rather than WebRTC
    #[arg(long)]
    pub vnc: bool,
    /// Public, unauthenticated URL
    #[arg(long)]
    pub public: bool,
}

// ---------------------------------------------------------------------------
// Snapshots

#[derive(Args)]
pub struct SnapshotsArgs {
    /// Sandbox id; omit to list all sandboxes
    pub id: Option<String>,
    /// Limit the number returned
    #[arg(long)]
    pub limit: Option<u32>,
    /// Include archived snapshots
    #[arg(long)]
    pub all: bool,
}

#[derive(Subcommand)]
pub enum SnapshotCommand {
    /// Save the current filesystem under a name; reusing a name replaces it
    Save {
        /// Sandbox id, or current/self inside a sandbox
        id: String,
        /// Snapshot name
        name: String,
    },
    /// Most recent snapshot of a sandbox
    Latest {
        /// Sandbox id, or current/self inside a sandbox
        id: String,
    },
    /// Files and sizes captured in a snapshot
    Tree {
        /// Snapshot id
        snap_id: String,
    },
    /// Download and reassemble a snapshot locally
    Pull {
        /// Snapshot id
        snap_id: String,
        /// Directory to write into
        #[arg(short = 'o', long = "output", value_name = "DIR")]
        output: Option<String>,
    },
    /// Delete one filesystem snapshot
    Delete {
        /// Snapshot id
        snap_id: String,
        /// Skip the confirmation prompt
        #[arg(long)]
        yes: bool,
    },
    /// Remove a named snapshot
    Rm {
        /// Snapshot name
        name: String,
    },
}

// ---------------------------------------------------------------------------
// Environments

#[derive(Subcommand)]
pub enum EnvCommand {
    /// List named environments
    List,
    /// Detail one environment
    Info { name: String },
    /// Create an environment
    New { name: String },
    /// Rename an environment
    Rename { old: String, new: String },
    /// Set the default environment
    Default { name: String },
    /// Delete an environment
    Rm { name: String },
    /// Set safety toggles
    Set { name: String },
    /// Set an environment variable
    SetVar { name: String, key_value: String },
    /// Remove an environment variable
    RmVar { name: String, key: String },
    /// Store a secret file
    SetFile { name: String, key: String, path: String },
    /// Remove a secret file
    RmFile { name: String, key: String },
    /// Add a repo to the bundle
    AddRepo { name: String, repo: String },
    /// Remove a repo from the bundle
    RmRepo { name: String, repo: String },
    /// Move running sandboxes onto the newest version
    Upgrade { name: String },
}

// ---------------------------------------------------------------------------
// Account

#[derive(Args)]
pub struct LoginArgs {
    /// API key to store instead of the device-code flow
    pub key: Option<String>,
    /// Log in with Google
    #[arg(long)]
    pub google: bool,
    /// Log in with an email address
    #[arg(long, value_name = "ADDR")]
    pub email: Option<String>,
}

#[derive(Args)]
pub struct LogoutArgs {}

#[derive(Args)]
pub struct StatusArgs {}

#[derive(Args)]
pub struct LimitsArgs {}

#[derive(Subcommand)]
pub enum ApiKeyCommand {
    /// Create an API key (secret shown once)
    Create,
    /// List API keys (prefix + last four only)
    List,
    /// Rotate an API key
    Rotate { id: Option<String> },
    /// Revoke an API key
    Revoke { id: Option<String> },
}

#[derive(Subcommand)]
pub enum WebhookCommand {
    /// Create a lifecycle webhook (secret shown once)
    Create,
    /// List webhooks
    List,
    /// Rotate a webhook signing secret
    Rotate { id: Option<String> },
    /// Remove a webhook
    Remove { id: Option<String> },
}

#[derive(Subcommand)]
pub enum TeamCommand {
    /// List billing scopes
    List,
    /// Switch the active scope
    Switch { id: String },
}

#[derive(Subcommand)]
pub enum DataRetentionCommand {
    /// Current delete-on-stop setting
    Status,
    /// Enable delete-on-stop
    Enable,
}

#[derive(Args)]
pub struct DashboardArgs {}

#[derive(Args)]
pub struct SelfUpdateArgs {
    /// Apply without prompting
    #[arg(long)]
    pub yes: bool,
}

// ---------------------------------------------------------------------------
// Completions

#[derive(Args)]
pub struct CompletionsArgs {
    /// Shell to generate completion for
    #[arg(value_enum)]
    pub shell: Shell,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, ValueEnum)]
pub enum Shell {
    Bash,
    Zsh,
    Fish,
    PowerShell,
}

// ---------------------------------------------------------------------------
// Agent commands (v1: endpoints only)

#[derive(Args)]
#[command(trailing_var_arg = true)]
pub struct PromptArgs {
    /// Message to send the agent
    pub message: Vec<String>,
}

#[derive(Args)]
pub struct InterruptArgs {
    /// Sandbox id, or current/self inside a sandbox
    pub id: String,
}

#[derive(Args)]
pub struct EventsArgs {
    /// Sandbox id, or current/self inside a sandbox
    pub id: String,
    /// Seconds to stream for
    #[arg(long, value_name = "SECS")]
    pub timeout: Option<u32>,
}

// ---------------------------------------------------------------------------
// Roles owned by other crates

#[derive(Args)]
pub struct ServeArgs {}

#[derive(Args)]
pub struct AgentArgs {}

// ---------------------------------------------------------------------------
// Hidden helpers

#[derive(Subcommand)]
pub enum DebugCommand {
    /// Print whether --json mode is active (for tests)
    JsonMode,
}

#[derive(Args)]
pub struct DebugArgs {
    #[command(subcommand)]
    pub cmd: DebugCommand,
}

#[derive(Args)]
pub struct CompleteSandboxArgs {}