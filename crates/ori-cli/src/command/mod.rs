//! Subcommand dispatch.

pub mod access;
pub mod account;
pub mod agent;
pub mod completions;
pub mod env;
pub mod lifecycle;
pub mod serve;
pub mod snapshots;
pub mod stub;

use crate::cli::{Command, DebugCommand};
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
        Command::Delete(a) => lifecycle::delete(a, &ctx).await,
        Command::Extend(a) => lifecycle::extend(a, &ctx).await,
        Command::Operation(a) => lifecycle::operation(a, &ctx).await,
        Command::Exec(a) => access::exec(a, &ctx).await,
        Command::Login(a) => account::login(a, &mut ctx).await,
        Command::Logout(a) => account::logout(a, &mut ctx).await,
        Command::Status(a) => account::status(a, &ctx).await,
        Command::ApiKey(sub) => account::api_key(sub, &mut ctx).await,
        Command::Completions(a) => completions::run(a),
        Command::CompleteSandbox(_) => completions::complete_sandbox(&ctx).await,
        Command::Debug(a) => debug(a.cmd, &ctx).await,

        Command::Serve(a) => serve::serve(a, &ctx).await,
        Command::Agent(a) => agent::agent(a).await,

        Command::Ssh(_) => Err(stub::unimplemented("ssh")),
        Command::Scp(_) => Err(stub::unimplemented("scp")),
        Command::Forward(_) => Err(stub::unimplemented("forward")),
        Command::Host(a) => access::host(a, &ctx).await,
        Command::Desktop(a) => access::desktop(a, &ctx).await,
        Command::Snapshots(args) => snapshots::cmd(args, &ctx).await,
        Command::Snapshot(sub) => snapshots::snapshot(&sub, &ctx).await,
        Command::Env(sub) => env::cmd(&sub, &ctx).await,
        Command::Webhook(sub) => account::webhook(sub, &mut ctx).await,
        Command::Team(sub) => account::team(sub, &mut ctx).await,
        Command::DataRetention(sub) => account::data_retention(sub, &ctx).await,
        Command::Dashboard(a) => account::dashboard(a, &ctx).await,
        Command::SelfUpdate(a) => account::self_update(a, &ctx).await,
        Command::Prompt(_) => Err(stub::unimplemented("prompt")),
        Command::Interrupt(_) => Err(stub::unimplemented("interrupt")),
        Command::Events(_) => Err(stub::unimplemented("events")),
    }
}

async fn debug(cmd: DebugCommand, ctx: &Ctx) -> Result<(), CliError> {
    match cmd {
        DebugCommand::JsonMode => {
            println!("{}", if ctx.json { "true" } else { "false" });
        }
    }
    Ok(())
}
