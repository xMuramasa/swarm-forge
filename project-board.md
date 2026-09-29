# Project board

The swarm no longer *is* the project folder. Pack templates live in a
**packs** directory. Each project is a directory under **projects**, with
one pack instantiated in it.
Several projects can run at once on one dashboard. A **lieutenant**
agent oversees the whole swarm. Chat talks to the lieutenant, not to a
project agent.

## Install all packs

Today `get-swarm-forge` composes only the requested pack into the current
directory, and `./swarm` runs there.

`get-swarm-forge` pulls down **all** packs (two-pack, four-pack, six-pack)
plus the shared scripts from `main` into the **packs** directory. Those
packs sit as choices. Running the helper does not turn the current
directory into a single pack.

Opening a project **refreshes** it from **packs**: it picks up the
current pack templates and shared scripts. The project is not frozen at
the copy it was born with.

## New Project

The dashboard has a **New Project** button. The dialog has:

- **name** — the project directory under **projects**, or, with GitHub
  checked, `owner/repo` (for example `unclebob/swarm-forge`). The
  directory name is inferred from the last path segment (`swarm-forge`).
- **github repo** — a checkbox. When checked, that repo is cloned into
  `projects/<inferred-name>` and then treated as the new project.
- **mission** — what the project is for. Written to `mission.md` at the
  top of the project directory.
- **pack** — radio buttons for the installed packs (two-pack, four-pack,
  six-pack).
- **config** — a pane showing that pack's `swarmforge.conf`. The operator
  can edit it (agents, extra CLI args, receive mode, propagation, windows)
  before the project is created.

It creates `projects/<name>` (cloned first if GitHub is checked) and
instantiates the chosen pack there: shared scripts plus that pack's conf
(as edited), roles, and local constitution.

New Project is only for a directory that does not exist yet. If the
inferred name already exists under **projects**, an alert dialog explains
that and does not overwrite or clone over it.

## Cockpit

Top to bottom:

- **New Project** and **Open Project** — at the top, next to each other,
  above Attention.
- **Attention** — stays in the same place. Each row names the **project**
  as well as the task (approvals and clarifications from every open
  project).
- **Board and Work Queue** — stacked project bands, independently
  scrollable (see Concurrent projects).
- **Chat** — follow-ups to the **lieutenant**, who oversees the entire
  swarm. Chat does not talk to a specifier, coder, or any other project
  agent.

Each project band has a **horizontal bar** above its swimlane cards.
That bar is the project header. **New Task** and **Close** are on that
bar. New Task sends a task to that project. Close stops that project.

## Concurrent projects

More than one project can run at the same time. Packs may differ (a
two-pack next to a four-pack). Each band follows its own conf.

The dashboard stacks projects top to bottom, split by a **horizontal bar**,
in both:

- the swimlanes
- the agent list on the right (Work Queue)

Those two sides **scroll independently**. Moving the swimlanes does not
move the agent list, and the other way around. The bars stay the
separators between projects; a board band and an agent-list band do not
have to stay aligned.

## Close Project

**Close** is per project. It is not Teardown of the whole dashboard. The
button is on that project's header bar.

Close:

- kills that project's agents (and that project's swarm runtime)
- removes that project's swimlane band and agent-list band
- leaves the project directory intact (code, git, `.swarmforge`, tasks)

Other projects stay up. The dashboard stays, including New Project and
Open Project, even if the last open project is closed.

## Open Project

**Open Project** is the inverse of Close.

The button pops a menu loaded from the directories under **projects**.
Pick one: it is refreshed from **packs**, that pack starts again in that
directory, agents come back, and its swimlane band and agent list
reappear.

Opening a project that is already open also gets an alert: it is already
on the dashboard. The menu is the directories under **projects**, so a
folder removed by hand simply does not appear.

There is no separate project catalog. A project exists if it is a
directory under **projects**.

GitHub clone is not on this menu. It is on **New Project**.

## Teardown and later rerun

**Teardown** stops every running project, kills the lieutenant, and shuts
the dashboard. It is not Close. Directories under **projects** stay.

Teardown of the swarm does not forget the projects. Every directory
under **projects** stays on disk. There is no closed/in-process catalog.
Whether a project was in process is worked out from the logs and
sessions in that directory.

When the swarm is started again, **every project is inactive**. No
bands come back on their own. An old or in-process project is started
with **Open Project** at the top. Opening uses the state left in that
directory; it is not a new project.

## Implementation plan

Do this in order. Each step should leave a runnable forge. Do not pin
prompt wording in tests.

### 1. Forge layout

The directory where `get-swarm-forge` is run is the **forge**. It holds:

- `packs/` — templates: `two-pack`, `four-pack`, `six-pack`
- `projects/` — one subdirectory per project
- host scripts from `main` (`swarm`, `swarmforge/scripts`, shared
  constitution articles)
- forge `.swarmforge/` — dashboard URL, lieutenant agent, host herdr
  workspace id

`./swarm` starts the **host** only: dashboard, lieutenant, host herdr workspace.
It does not start any project agents.

A project runtime is separate: that project's `swarmforge.conf` roles,
worktrees, `handoffd`, and `.swarmforge/` under `projects/<name>`.
The host dashboard talks to every **open** project. It does not start a
second dashboard per project.

### 2. Installer

Change `get-swarm-forge` so it no longer composes one pack into `.`.

- Download `main` and every pack branch.
- Write pack templates into `packs/<pack>/`.
- Install host scripts from `main`.
- Create empty `projects/` if missing.
- Fail if a required pack or shared article is missing.

Keep compose logic as a function used later: copy shared scripts and
the chosen pack's `swarm`, conf, roles, and local articles into a
target directory.

### 3. Instantiate and refresh

**New Project** (backend first, dialog later):

- Resolve the directory name. With GitHub checked, `owner/repo` → last
  segment.
- Alert and stop if `projects/<name>` already exists.
- If GitHub: `git clone` into that directory, then instantiate.
- If not: create the directory (init git if needed), then instantiate.
- Write `mission.md`.
- Write the edited conf as `swarmforge/swarmforge.conf`.
- Instantiate from `packs/<pack>/` plus host shared scripts.

**Refresh** on Open Project: copy current pack templates and shared
scripts into the project. Keep `mission.md`, project source, git
history, `.swarmforge/`, and the project's `swarmforge.conf`.

**Open** starts that project's agents and `handoffd` from leftover
sessions and logs. It does not create a new project.

**Close** runs that project's cleanup (herdr workspace, `handoffd`, agents) and
leaves the directory.

### 4. Host dashboard API

`pack_web` serves the **forge** root, not a single project.

- List directories under `projects/`.
- Which of those are currently open (agents running).
- New Project, Open Project, Close (per project).
- New Task, board, work queue, attention, pane capture: take a
  **project** name and use `projects/<name>`.
- Chat and Teardown stay on the forge: chat goes to the lieutenant;
  Teardown closes every open project, then kills the lieutenant and
  the dashboard.

Alert payloads for: name exists, already open, clone failed.

### 5. Cockpit UI

- Top: **New Project**, **Open Project**, **Teardown**.
- **Attention** under that. Each row shows project and task.
- Board and Work Queue: one band per **open** project, horizontal bar,
  independently scrollable.
- Project header bar: project name, **New Task**, **Close**.
- Chat rail talks to the lieutenant.

**New Project** dialog: name field, GitHub checkbox, inferred name,
pack radio buttons, conf pane (loads `packs/<pack>/swarmforge/swarmforge.conf`
when the radio changes), mission field. OK runs instantiate and then
Open.

**Open Project** menu: directories under `projects/`. Choosing one
refreshes and starts it. Already open → alert.

Empty forge: no bands, Attention empty, chat still to the lieutenant.

### 6. Lieutenant

Add a host lieutenant: prompt on `main`, one herdr agent in the forge,
not a pack window. Startup launches it with the host. Chat injects to
that pane and shows the reply, same machinery as today's master chat,
aimed at the lieutenant. Close Project does not kill the lieutenant.
Teardown does.

### 7. Restart

Host `./swarm` after Teardown: dashboard and lieutenant only. No project
bands. Open Project starts an old or in-process directory from its
`.swarmforge/` logs and sessions.

### 8. Tests and README

Cover installer layout (`packs/`, `projects/`). Cover New Project
(local and GitHub name inference, existing-name alert). Cover Open,
already-open alert, Close leaving the directory, refresh keeping
`mission.md` and project conf. Cover stacked bands and Attention
showing the project name. Cover Teardown then restart with no bands.
Do not pin prompt wording.

Update the README: forge vs project, `get-swarm-forge` installs all
packs, New/Open/Close/Teardown, lieutenant chat, mission.md.
