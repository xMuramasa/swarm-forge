<p align="center" style="color: red; font-weight: bold; font-size: 2em; font-style: italic; text-decoration: underline;">
Do not spend any money on a bankrbot SWARM token.
</p>

# SwarmForge

SwarmForge coordinates AI agents in isolated git worktrees, each running as a
[herdr](https://herdr.dev/) agent. Agents exchange committed work through durable
handoffs. The operator watches the agents in the herdr TUI, talks to the
specifier directly in its pane, and controls the swarm with `./swarm` commands.

This is a fork of [unclebob/swarm-forge](https://github.com/unclebob/swarm-forge).
This repository's `main` branch is the installer source, the shared runtime, and
the shared engineering law. It is not itself a runnable SwarmForge product.

## Product

| Command | Branch | Shape |
|---|---|---|
| `get-swarm-forge mini-forge [language]` | [`mini-forge`](../../tree/mini-forge) | Four Claude agents: `specifier` → `coder` → `architect` → `QA`, with a model per role. |

A pack is composed into an existing project. Running `./swarm` starts that
project's configured roles. Other packs are branches with the same layout (see
Composition); add one to the `case` in `get-swarm-forge` to install it.

## Prerequisites

- `zsh`, `git`
- [`herdr`](https://herdr.dev/), running (the operator watches the swarm in its TUI)
- [`bun`](https://bun.sh/), which runs the whole runtime (TypeScript, no build step)
- Optional: Babashka (`bb`), only for unclebob's Gherkin acceptance tools (`gherkin-parser` and friends), which are Babashka programs
- Claude Code (`claude`), or another supported backend: `codex`, `grok`, `copilot`

## Install the helper

Put `get-swarm-forge` somewhere on `PATH`, for example `~/.local/bin`:

```sh
curl -L -o ~/.local/bin/get-swarm-forge \
  https://raw.githubusercontent.com/xMuramasa/swarm-forge/main/get-swarm-forge
chmod +x ~/.local/bin/get-swarm-forge
```

Recopy it when it changes. It is the supported entry point because it composes
files from two branches.

## Composition

The helper downloads two branches:

```text
main
  swarmforge/scripts/                    shared runtime and operator commands
  swarmforge/constitution/articles/      shared engineering, workflow, handoffs

<pack branch>
  swarm                                  launcher
  swarmforge/swarmforge.conf             roles, agents, and worktrees
  swarmforge/constitution.prompt         constitution entry point
  swarmforge/constitution/articles/      pack-local additions
  swarmforge/roles/                      role ownership
```

The result is written into the current project. The article names
`engineering.prompt`, `workflow.prompt`, and `handoffs.prompt` always come from
`main`; a pack specializes them with `project.prompt` and `local-*.prompt` files.

The optional language (`typescript`, `python`, `go`, `clojure`, `java`,
`babashka`) is written into the project's `project.prompt`, which selects the
quality tools the agents use (see the language defaults in `engineering.prompt`).
Without one, the install warns and the agents ask you before starting.

## Start on an integration branch

The role on the `master` worktree (the specifier in `mini-forge`) has no worktree
of its own: it works in your checkout, on whatever branch is checked out, and the
finished work of every other role is merged into it. Anything the swarm commits
lands on that branch. So start each swarm from a branch made for it, and merge
that branch yourself when you have reviewed it:

```sh
git switch -c swarm/<task>
./swarm
# ...when the work is done and reviewed, open a PR from swarm/<task>
```

The other roles use their own worktrees under `.worktrees/`, on `swarmforge-<role>`
branches created from that branch at startup.

The launcher refuses to start on `main`, `master` or `develop` in a repo that
already has commits, and says how to fix it. `SWARMFORGE_ALLOW_BRANCH=1 ./swarm`
overrides that for one run. A repo without commits yet is not checked.

## Operate the swarm

Once `./swarm` has started the agents (one pane each in a herdr workspace named
after the project), you work with it from the project directory:

```sh
./swarm status                        # roles (with herdr's state), tasks, and what waits for you
./swarm task new <name> "description" # start work: a card, and a note to the master agent
./swarm approve <id>                  # release a spec the specifier submitted
./swarm reject <id> "comments"        # send a spec back to the specifier with your comments
```

- **Talk to the specifier in its pane.** It is a normal interactive session: answer
  its questions there, give it feedback, ask for the next feature. It is the only
  role that talks to you. Every other role sends its questions to it as a `note`.
- **Approvals are yours.** The specifier's spec is held until you run
  `./swarm approve <id>`; the agents cannot release it themselves. `status` shows
  the id, the task, and the files it touches. Review the files in your editor.
  `reject` discards the held spec and prompts the specifier with your comments; it
  revises and resubmits with a new commit.
- **A role waiting for input** (a permission or trust dialog, say) shows as
  `blocked` in `status` and in the herdr sidebar.
- **Stop the swarm** with `close-swarm <project>`: it archives each role's pane,
  stops the handoff daemon, and closes the herdr workspace.

`--root <dir>` runs a command against another project, and `status --json` is
machine readable.

## Accounts

A project runs on one billing account, chosen per project rather than per role.
Accounts live in `~/.config/swarmforge/accounts.conf`, one line each, naming
the config directory of every backend that account uses:

```text
account personal claude=~/.claude-personal
account work     claude=~/.claude codex=~/.codex
```

The project picks one with a line in `swarmforge/swarmforge.conf`:

```text
account personal
```

`SWARMFORGE_ACCOUNT=work ./swarm` overrides it for one run. Every agent in the
project starts with that account's directory (`CLAUDE_CONFIG_DIR` for Claude,
`CODEX_HOME` for Codex), and Codex trust is recorded there. Startup stops with
a reason if the account is unknown, lacks a directory for a backend a role
uses, or the directory does not exist (log in there once first). With no
account selected, agents inherit the environment of the herdr pane, which is
usually your default account.

## Configuration contract

Every running project has a `swarmforge/swarmforge.conf`. Each non-comment line
has this shape:

```text
window[-invisible] <role> <backend> <worktree> [task|batch] [forward-only|back-one|back-all] [backend arguments...]
```

- File order is the default forward pipeline. Exactly one role must use the
  `master` worktree; that sentinel means the project's main checkout on its
  current branch. Other names become `.worktrees/<name>` checkouts.
- `window` and `window-invisible` both start the role as a herdr agent in its own
  pane of the project's workspace (two rows, roles filled in file order); the two
  spellings are kept for old configs.
- Receive mode defaults to `task`. `batch` lets a role accept a compatible
  group of queued handoffs together.
- Propagation defaults to `forward-only`. `back-one` and `back-all` arrange
  merge-only copies for earlier roles after downstream work.
- Supported backends are `codex`, `grok`, `claude`, and `copilot`; remaining
  tokens are passed to that backend, for example `--model sonnet`.

## Constitution and role prompts

The installer composes instructions as data; it does not bake every product's
rules into the launcher. A pack agent is started with instructions to read
`swarmforge/constitution.prompt`, recursively read what it names, and then read
`swarmforge/roles/<role>.prompt`.

The three article names owned by `main` are:

| Article | Shared responsibility |
|---|---|
| [`engineering.prompt`](swarmforge/constitution/articles/engineering.prompt) | Language defaults and tools (TypeScript, Python, Go, Clojure, Java), testability, acceptance-pipeline tooling, verification, and quality-tool guardrails. |
| [`workflow.prompt`](swarmforge/constitution/articles/workflow.prompt) | Worktree discipline, commit attribution, temporary files, and failure conditions. |
| [`handoffs.prompt`](swarmforge/constitution/articles/handoffs.prompt) | The structured send, receive, merge, retry, and completion protocol. |

A pack branch contributes its constitution entry point and any differently named
local articles, such as `project.prompt`. The composer reserves the three shared
names for `main`, so a pack cannot silently replace common law.

Role prompts divide ownership inside that law: what a role may change, what it
must verify, what it must leave to another role, and where its next handoff
goes. There must be a matching prompt for every configured role.

## What `main` owns

```text
get-swarm-forge                        pack composer
close-swarm                            stop a swarm
swarmforge/scripts/                    launcher, operator commands, board, handoffs
swarmforge/constitution/articles/      shared agent rules
swarmforge/handoff-protocol.md         durable handoff protocol
test/                                  runtime tests
```

Changes to shared launch, worktree, board, operator-command, or handoff behavior
belong on `main` first. Pack branches own only their configuration, local
constitution additions, role prompts, and launcher.

Do not pin prompt prose with automated tests. Test observable runtime behavior
instead. Run the tests with `bun test test/cli`.

## Runtime components and generated state

| Component | Responsibility |
|---|---|
| `swarmforge.sh` / `swarmforge.ts` | Parse configuration, create worktrees, synchronize managed files, and launch herdr agents. `swarmforge.sh` also routes the operator commands to `swarmctl.ts`. |
| `swarmctl.ts` | The operator commands: `status`, `task new`, `approve`, `reject`. Runs on bun. |
| `swarm_handoff.*`, `ready_for_next.*`, `done_with_current.*` | Create, accept, merge, audit, and complete durable work items. |
| `handoffd.*` | Deliver queued handoffs, hold the specifier's spec for approval, and wake receiving agents. |
| `pack_board.*` | Persist the board's task cards and archive role panes. |
| `herdr.ts` | The one wrapper over the herdr CLI: workspaces, panes, agents, prompts, reads. |
| `crap.sh`, `swarm_tool.*` | Quality tools for the agents: CRAP from lizard plus lcov coverage, and installers for the language tools. |
| `close-swarm` | Archive role panes, stop the daemon, and close the project's herdr workspace. |

At startup the composed runtime validates the configuration, initializes git
when necessary, creates role worktrees, mirrors the managed SwarmForge files
into them, starts the handoff daemon, and launches each configured agent backend
in its own pane of a per-project herdr workspace, tiled in a grid.

`master` in a role configuration means the project's main checkout on its
current branch; it is a worktree sentinel, not a required git branch name.
Generated transport and process state lives under `.swarmforge/`; generated
role checkouts live under `.worktrees/`. `.swarmforge/` contains such runtime
records as role/agent maps, the herdr workspace id, handoff inboxes and outboxes,
board data, held approvals, and daemon state. It is not product source and
agents must not edit it as a substitute for the helper commands.

Agents send committed work with `swarm_handoff.sh`, accept it with
`ready_for_next.sh`, and finish the current item with `done_with_current.sh`.
See [the handoff protocol](swarmforge/handoff-protocol.md) for message format,
auditing, delivery, retry, merge, and lifecycle details.
