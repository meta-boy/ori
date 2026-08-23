//! Arg-parsing tests for every subcommand. Asserting the parsed struct catches
//! a renamed flag or a moved positional.

use clap::Parser;

use ori_cli::cli::{
    Cli, Command, DebugCommand, EnvCommand, Shell, SnapshotCommand, WebhookCommand,
};

fn parse(args: &[&str]) -> Cli {
    Cli::try_parse_from(["ori"].into_iter().chain(args.iter().copied())).unwrap()
}

#[test]
fn new_full_flags() {
    let cli = parse(&[
        "new",
        "--type",
        "large",
        "--ttl",
        "3600",
        "--no-auto-stop",
        "-e",
        "A=B",
        "-e",
        "C=D",
        "--no-env",
        "--setup-file",
        "/tmp/setup.sh",
        "--environment",
        "prod",
        "--from",
        "snap1",
        "--team",
        "t1",
        "--personal",
    ]);
    match cli.command {
        Command::New(a) => {
            assert_eq!(a.type_.as_deref(), Some("large"));
            assert_eq!(a.ttl, Some(3600));
            assert!(a.no_auto_stop);
            assert_eq!(a.env, vec!["A=B", "C=D"]);
            assert!(a.no_env);
            assert_eq!(a.setup_file.as_deref(), Some("/tmp/setup.sh"));
            assert_eq!(a.environment.as_deref(), Some("prod"));
            assert_eq!(a.from.as_deref(), Some("snap1"));
            assert_eq!(a.team.as_deref(), Some("t1"));
            assert!(a.personal);
        }
        other => panic!("expected new, got {other:?}"),
    }
}

#[test]
fn list_defaults_and_all() {
    match parse(&["list"]).command {
        Command::List(a) => {
            assert_eq!(a.filter, "r");
            assert!(!a.all);
        }
        other => panic!("expected list, got {other:?}"),
    }
    match parse(&["list", "--all", "--filter", "se"]).command {
        Command::List(a) => {
            assert!(a.all);
            assert_eq!(a.filter, "se");
        }
        other => panic!("expected list, got {other:?}"),
    }
}

#[test]
fn resume_and_fork_share_flags() {
    let args = [
        "--type",
        "small",
        "--ttl",
        "120",
        "--no-auto-stop",
        "-e",
        "K=V",
        "--environment",
        "base",
    ];
    match parse(&["resume", "ori_x", "--ttl", "300"]).command {
        Command::Resume(a) => {
            assert_eq!(a.id, "ori_x");
            assert_eq!(a.opts.ttl, Some(300));
        }
        other => panic!("expected resume, got {other:?}"),
    }
    match parse(&["fork", "ori_x", "--type", "large"]).command {
        Command::Fork(a) => {
            assert_eq!(a.id, "ori_x");
            assert_eq!(a.opts.type_.as_deref(), Some("large"));
        }
        other => panic!("expected fork, got {other:?}"),
    }
    let full = parse(&[&["fork", "ori_x"], &args[..]].concat());
    match full.command {
        Command::Fork(a) => {
            assert_eq!(a.opts.type_.as_deref(), Some("small"));
            assert_eq!(a.opts.ttl, Some(120));
            assert!(a.opts.no_auto_stop);
            assert_eq!(a.opts.env, vec!["K=V"]);
            assert_eq!(a.opts.environment.as_deref(), Some("base"));
            assert!(!a.no_stop);
        }
        other => panic!("expected fork, got {other:?}"),
    }
    match parse(&["fork", "ori_x", "--no-stop"]).command {
        Command::Fork(a) => assert!(a.no_stop),
        other => panic!("expected fork, got {other:?}"),
    }
}

#[test]
fn exec_flags_before_command() {
    match parse(&[
        "exec",
        "ori_x",
        "--cwd",
        "/tmp",
        "--timeout",
        "60",
        "echo",
        "hi",
        "-n",
    ])
    .command
    {
        Command::Exec(a) => {
            assert_eq!(a.id, "ori_x");
            assert_eq!(a.cwd.as_deref(), Some("/tmp"));
            assert_eq!(a.timeout, 60);
            assert_eq!(a.command, vec!["echo", "hi", "-n"]);
            assert!(!a.detach);
            assert_eq!(a.status, None);
        }
        other => panic!("expected exec, got {other:?}"),
    }
}

#[test]
fn exec_default_timeout_is_30() {
    match parse(&["exec", "ori_x", "true"]).command {
        Command::Exec(a) => assert_eq!(a.timeout, 30),
        other => panic!("expected exec, got {other:?}"),
    }
}

#[test]
fn exec_timeout_out_of_range_rejected() {
    assert!(Cli::try_parse_from(["ori", "exec", "ori_x", "--timeout", "0", "true"]).is_err());
    assert!(Cli::try_parse_from(["ori", "exec", "ori_x", "--timeout", "601", "true"]).is_err());
}

#[test]
fn exec_detach_and_status() {
    match parse(&["exec", "ori_x", "--detach", "sleep", "10"]).command {
        Command::Exec(a) => assert!(a.detach),
        other => panic!("expected exec, got {other:?}"),
    }
    match parse(&["exec", "ori_x", "--status", "42"]).command {
        Command::Exec(a) => assert_eq!(a.status, Some(42)),
        other => panic!("expected exec, got {other:?}"),
    }
}

#[test]
fn ssh_trailing_command() {
    match parse(&["ssh", "ori_x", "ls", "-la"]).command {
        Command::Ssh(a) => {
            assert_eq!(a.id, "ori_x");
            assert_eq!(a.command, vec!["ls", "-la"]);
        }
        other => panic!("expected ssh, got {other:?}"),
    }
}

#[test]
fn scp_positionals() {
    match parse(&["scp", "-r", "ori_x:/etc/hosts", "./hosts"]).command {
        Command::Scp(a) => {
            assert_eq!(a.src, "ori_x:/etc/hosts");
            assert_eq!(a.dst, "./hosts");
            assert!(a.recursive);
        }
        other => panic!("expected scp, got {other:?}"),
    }
}

#[test]
fn forward_requires_remote() {
    assert!(Cli::try_parse_from(["ori", "forward", "ori_x"]).is_err());
    match parse(&["forward", "ori_x", "--remote", "3000", "--bind", "0.0.0.0"]).command {
        Command::Forward(a) => {
            assert_eq!(a.remote, 3000);
            assert_eq!(a.local, None);
            assert_eq!(a.bind, "0.0.0.0");
        }
        other => panic!("expected forward, got {other:?}"),
    }
}

#[test]
fn host_private_default_public_conflicts() {
    match parse(&["host", "ori_x", "8080"]).command {
        Command::Host(a) => {
            assert!(a.private);
            assert!(!a.public);
        }
        other => panic!("expected host, got {other:?}"),
    }
    assert!(
        Cli::try_parse_from(["ori", "host", "ori_x", "8080", "--private", "--public"]).is_err()
    );
}

#[test]
fn stop_force_delete_yes() {
    match parse(&["stop", "ori_x", "--force"]).command {
        Command::Stop(a) => assert!(a.force),
        other => panic!("expected stop, got {other:?}"),
    }
    match parse(&["delete", "ori_x", "--yes"]).command {
        Command::Delete(a) => assert!(a.yes),
        other => panic!("expected delete, got {other:?}"),
    }
}

#[test]
fn snapshot_subcommands() {
    match parse(&["snapshot", "save", "ori_x", "before-upgrade"]).command {
        Command::Snapshot(SnapshotCommand::Save { id, name }) => {
            assert_eq!(id, "ori_x");
            assert_eq!(name, "before-upgrade");
        }
        other => panic!("expected snapshot save, got {other:?}"),
    }
    match parse(&["snapshot", "pull", "snap1", "-o", "/tmp"]).command {
        Command::Snapshot(SnapshotCommand::Pull { snap_id, output }) => {
            assert_eq!(snap_id, "snap1");
            assert_eq!(output.as_deref(), Some("/tmp"));
        }
        other => panic!("expected snapshot pull, got {other:?}"),
    }
    match parse(&["snapshot", "delete", "snap1", "--yes"]).command {
        Command::Snapshot(SnapshotCommand::Delete { snap_id, yes }) => {
            assert_eq!(snap_id, "snap1");
            assert!(yes);
        }
        other => panic!("expected snapshot delete, got {other:?}"),
    }
}

#[test]
fn env_subcommands() {
    assert!(matches!(
        parse(&["env", "list"]).command,
        Command::Env(EnvCommand::List)
    ));
    assert!(matches!(
        parse(&["env", "set-var", "prod", "KEY=VALUE"]).command,
        Command::Env(EnvCommand::SetVar { name, key_value }) if name == "prod" && key_value == "KEY=VALUE"
    ));
    assert!(matches!(
        parse(&["env", "rename", "old", "new"]).command,
        Command::Env(EnvCommand::Rename { old, new }) if old == "old" && new == "new"
    ));
}

#[test]
fn login_variants() {
    match parse(&["login"]).command {
        Command::Login(a) => {
            assert_eq!(a.key, None);
            assert!(!a.google);
            assert_eq!(a.email, None);
        }
        other => panic!("expected login, got {other:?}"),
    }
    match parse(&["login", "--google"]).command {
        Command::Login(a) => assert!(a.google),
        other => panic!("expected login, got {other:?}"),
    }
    match parse(&["login", "--email", "a@b.c"]).command {
        Command::Login(a) => assert_eq!(a.email.as_deref(), Some("a@b.c")),
        other => panic!("expected login, got {other:?}"),
    }
    match parse(&["login", "sk_abc123"]).command {
        Command::Login(a) => assert_eq!(a.key.as_deref(), Some("sk_abc123")),
        other => panic!("expected login, got {other:?}"),
    }
}

#[test]
fn api_key_and_team_subcommands() {
    assert!(matches!(
        parse(&["api-key", "create"]).command,
        Command::ApiKey(_)
    ));
    assert!(matches!(
        parse(&["webhook", "create", "https://hooks.example.com/ori"]).command,
        Command::Webhook(WebhookCommand::Create { url }) if url == "https://hooks.example.com/ori"
    ));
    assert!(matches!(
        parse(&["team", "switch", "t1"]).command,
        Command::Team(_)
    ));
    assert!(matches!(
        parse(&["data-retention", "enable"]).command,
        Command::DataRetention(_)
    ));
}

#[test]
fn completions_shell_enum() {
    match parse(&["completions", "bash"]).command {
        Command::Completions(a) => assert_eq!(a.shell, Shell::Bash),
        other => panic!("expected completions, got {other:?}"),
    }
    match parse(&["completions", "powershell"]).command {
        Command::Completions(a) => assert_eq!(a.shell, Shell::PowerShell),
        other => panic!("expected completions, got {other:?}"),
    }
}

#[test]
fn global_flags_are_global() {
    match parse(&["--json", "--no-update", "--api-url", "http://x", "list"]).command {
        Command::List(a) => {
            assert_eq!(a.filter, "r");
        }
        other => panic!("expected list, got {other:?}"),
    }
    let cli = parse(&["list", "--json", "--api-url", "http://x", "--no-update"]);
    assert!(cli.json);
    assert!(cli.no_update);
    assert_eq!(cli.api_url.as_deref(), Some("http://x"));
}

#[test]
fn debug_hidden_command() {
    match parse(&["_debug", "json-mode"]).command {
        Command::Debug(a) => assert!(matches!(a.cmd, DebugCommand::JsonMode)),
        other => panic!("expected _debug, got {other:?}"),
    }
}
