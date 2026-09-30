# SwarmForge mini-forge

`mini-forge` is the six-pack with two roles removed and a model split built in:
four Claude agents, heavy models where the work is judgement and lighter ones
where it is execution.

```text
New Task → specifier → approval → coder → architect → QA → Done
```

| Role | Model (in `swarmforge.conf`) | Owns |
|---|---|---|
| `specifier` | `opus` | Gherkin, end-to-end QA procedures, dashboard approval. |
| `coder` | `sonnet` | TDD and unit tests, the acceptance pipeline, and the cleanup, coverage, and CRAP of the code it touches (the six-pack cleaner's local work). |
| `architect` | `opus` | Boundaries and dependency direction, property tests, and language and Gherkin mutation, DRY, and CRAP gates (the six-pack hardender's work). |
| `QA` | `sonnet` | Executable UI-level QA, independent final verification, narrow fixes. |

The model per role is the `--model` argument on each `window` line. Change it
there.

The account is per project, not per role: add an `account <name>` line to the
conf (accounts are defined in `~/.config/swarmforge/accounts.conf`; see the
Accounts section of the `main` README), or run `SWARMFORGE_ACCOUNT=<name> ./swarm`.

## Install

This branch is the pack-owned half of an installation. The runtime
(`swarmforge/scripts/`, herdr-based) and the shared articles come from `main`:

```sh
cd your-project
get-swarm-forge mini-forge typescript   # or python, go, clojure, java
./swarm
```

The language selects which quality tools the agents use (see the TypeScript and
Python defaults in `main`'s `engineering.prompt`). Without one, the install warns
and the agents ask you before starting.

The agents run in a herdr workspace named after the project, one pane per role
tiled in a 2x2 grid (specifier, coder / architect, QA). herdr must be running.

## Start on an integration branch

The specifier works in your checkout, on the branch you have checked out, and the
other roles' finished work is merged into it. Start each swarm from its own branch
and review it before merging it yourself:

```sh
git switch -c swarm/<task>
./swarm
```

The launcher refuses to start on `main`, `master` or `develop` (in a repo that
already has commits); `SWARMFORGE_ALLOW_BRANCH=1 ./swarm` overrides it. The full
explanation is in the Start on an integration branch section of the `main` README.

## Structure

```text
swarm
swarmforge/
  swarmforge.conf
  constitution.prompt
  constitution/articles/
    project.prompt
    local-engineering.prompt
    local-workflow.prompt
  roles/
    specifier.prompt  coder.prompt  architect.prompt  QA.prompt
```

`architect` and `QA` receive in batch mode and propagate back to every earlier
role. Handbacks from QA are merge-only.
