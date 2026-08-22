//! Subcommand dispatch.

pub mod access;
pub mod account;
pub mod completions;
pub mod lifecycle;
pub mod stub;

use crate::cli::{Command, DebugCommand, EnvCommand, SnapshotCommand};
use crate::context::Ctx;
use crate::error::CliError;

pub async fn dispatch(cmd: Command, mut ctx: Ctx) -> Result<(), CliError> {
    match cmd {
        Command::New(a) => lifecycle::new(a, &ctx).await,
        Command::List(a) => lifecycle::list(a, &ctx).await,
        Command::Info(a) => lifecycle::info(a, &ctx).await,
        Command::Stop(a) => lifecycle::stop(a, &ctx).await,
        Command::Resume(a) => lifecycle::resume(a, &ctx).await,
        Command::Fork(a) => lifecycle::fork(a, &ctx).await,
        Command::Delete(a) => lifecycle::delete(a, &mut ctx).await,
        Command::Exec(a) => access::exec(a, &ctx).await,
        Command::Login(a) => account::login(a, &mut ctx).await,
        Command::Logout(a) => account::logout(a, &mut ctx).await,
        Command::Status(a) => account::status(a, &ctx).await,
        Command::Completions(a) => completions::run(a),
        Command::CompleteSandbox(_) => completions::complete_sandbox(&ctx).await,
        Command::Debug(a) => debug(a.cmd, &ctx).await,

        Command::Extend(_) => Err(stub::unimplemented("extend")),
        Command::Operation(_) => Err(stub::unimplemented("operation")),
        Command::Ssh(_) => Err(stub::unimplemented("ssh")),
        Command::Scp(_) => Err(stub::unimplemented("scp")),
        Command::Forward(_) => Err(stub::unimplemented("forward")),
        Command::Host(_) => Err(stub::unimplemented("host")),
        Command::Desktop(_) => Err(stub::unimplemented("desktop")),
        Command::Snapshots(_) => Err(stub::unimplemented("snapshots")),
        Command::Snapshot(sub) => snapshot_stub(&sub),
        Command::Env(sub) => env_stub(&sub),
        Command::Limits(_) => Err(stub::unimplemented("limits")),
        Command::ApiKey(_) => Err(stub::unimplemented("api-key")),
        Command::Webhook(_) => Err(stub::unimplemented("webhook")),
        Command::Team(_) => Err(stub::unimplemented("team")),
        Command::DataRetention(_) => Err(stub::unimplemented("data-retention")),
        Command::Dashboard(_) => Err(stub::unimplemented("dashboard")),
        Command::SelfUpdate(_) => Err(stub::unimplemented("self-update")),
        Command::Prompt(_) => Err(stub::unimplemented("prompt")),
        Command::Interrupt(_) => Err(stub::unimplemented("interrupt")),
        Command::Events(_) => Err(stub::unimplemented("events")),
        Command::Serve(_) => Err(stub::unimplemented("serve")),
        Command::Agent(_) => Err(stub::unimplemented("agent")),
    }
}

fn snapshot_stub(sub: &SnapshotCommand) -> Result<(), CliError> {
    let name = match sub {
        SnapshotCommand::Save { .. } => "snapshot save",
        SnapshotCommand::Latest { .. } => "snapshot latest",
        SnapshotCommand::Tree { .. } => "snapshot tree",
        SnapshotCommand::Pull { .. } => "snapshot pull",
        SnapshotCommand::Delete { .. } => "snapshot delete",
        SnapshotCommand::Rm { .. } => "snapshot rm",
    };
    Err(stub::unimplemented(name))
}

fn env_stub(sub: &EnvCommand) -> Result<(), CliError> {
    let name = match sub {
        EnvCommand::List => "env list",
        EnvCommand::Info { .. } => "env info",
        EnvCommand::New { .. } => "env new",
        EnvCommand::Rename { .. } => "env rename",
        EnvCommand::Default { .. } => "env default",
        EnvCommand::Rm { .. } => "env rm",
        EnvCommand::Set { .. } => "env set",
        EnvCommand::SetVar { .. } => "env set-var",
        EnvCommand::RmVar { .. } => "env rm-var",
        EnvCommand::SetFile { .. } => "env set-file",
        EnvCommand::RmFile { .. } => "env rm-file",
        EnvCommand::AddRepo { .. } => "env add-repo",
        EnvCommand::RmRepo { .. } => "env rm-repo",
        EnvCommand::Upgrade { .. } => "env upgrade",
    };
    Err(stub::unimplemented(name))
}

async fn debug(cmd: DebugCommand, ctx: &Ctx) -> Result<(), CliError> {
    match cmd {
        DebugCommand::JsonMode => {
            println!("{}", if ctx.json { "true" } else { "false" });
        }
    }
    Ok(())
}