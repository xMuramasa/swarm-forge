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
get-swarm-forge mini-forge
./swarm
```

The agents run in a herdr workspace named after the project, one tab per role.
herdr must be running.

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
