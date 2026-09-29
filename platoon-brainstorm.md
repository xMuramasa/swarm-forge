# Platoon Brainstorm

## Purpose

A platoon is a SwarmForge control layer for building a system from multiple
independently deployable components. It coordinates several squads under one
Lieutenant agent.

Each squad is a normal SwarmForge pack instance. The Lieutenant is the only
agent active at platoon startup. Squads are created later, after the user and
Lieutenant have agreed on a component plan.

## Vocabulary

- **Pack**: A configured SwarmForge workflow pipeline, such as two-pack,
  four-pack, or six-pack.
- **Squad**: A collaborating pack instance. This term is distinct from any
  historical or branch name that may also be called `squad`.
- **Platoon**: A group of collaborating squads working toward a larger system
  objective.
- **Lieutenant**: The platoon-level agent that oversees the squads, assigns
  work, coordinates dependencies, integrates squad outputs, and owns the system
  test procedure.
- **Component**: An independently deployable artifact produced by one squad,
  such as a JAR, DLL, library, executable, or service. Independently deployable
  does not necessarily mean independently running.

## Command Structure

```text
operator
  |
lieutenant
  |
  +-- squad-a
  +-- squad-b
  +-- squad-c
```

The Lieutenant is the platoon-level overseer and integrator. Each squad is a
pack running its own workflow.

## Runtime Flow

1. The user starts the platoon.
2. Only the Lieutenant is active at startup.
3. The user and Lieutenant brainstorm the system.
4. They identify components, their internal architectural layers, anticipated
   polymorphic interfaces, interface ownership, and component dependencies.
5. The Lieutenant evaluates each component and chooses the appropriate squad
   type for it.
6. The Lieutenant produces a system plan that includes the component
   decomposition, dependencies, interfaces, tasks, and pack deployment for
   every component.
7. The user approves or rejects the plan. A rejected plan may be retried for
   revision or deleted. A retry may change any part of the plan, including pack
   deployment, and must be submitted for approval again.
8. After approval, the Lieutenant starts each dependency-ready squad in its own
   directory, one level below the platoon, and gives it its component task.
9. Squads execute their normal pack workflows independently. Squads blocked on
   contracts remain unstarted.
10. When a higher-level squad publishes an interface contract, the Lieutenant
    accepts a version of it and starts newly unblocked dependent squads.
11. The Lieutenant monitors squad progress and handles squad-level approvals.
12. A completed squad becomes integration-ready; it is not merged
    automatically.
13. The Lieutenant reruns the component test suite, reviews the result, and
    explicitly merges the squad's full history into the integration worktree.
14. The Lieutenant runs contract, compatibility, integration, and system tests
    against the integrated result.
15. The Lieutenant reports completion, remaining risks, and any unresolved
    operator decisions.

## Squad Selection

The Lieutenant chooses a pack type for each component while preparing the
system plan. The resulting pack deployment is part of the plan the user
approves and may be changed when a rejected plan is retried.

- **two-pack**: Simple utility components that do not need acceptance tests.
- **four-pack**: Complex components that need Gherkin acceptance tests. These
  components tend to contain business rules.
- **six-pack**: Components with a substantial user interface that require QA.

## System Plan Approval

The system plan is a versioned proposal for executing the platoon objective. It
must identify:

- The components and the deployable artifact each squad will produce.
- Each component's task, internal architecture, dependencies, and completion
  criteria.
- The anticipated polymorphic interfaces, which higher-level component owns
  each one, and which components must wait for accepted contracts.
- The selected pack deployment for each component.
- The integration strategy and system-level test procedure.

Approval makes that revision executable. Rejection starts no squads and offers
two explicit actions:

- **Retry**: Return the plan to the Lieutenant for reanalysis and revision, then
  present the new revision for approval.
- **Delete**: Discard the rejected plan and its platoon task.

No squad may be started from an unapproved or rejected plan revision.

## Filesystem Shape

Squads run in their own directories, one level below the platoon directory.

```text
platoon/                         # integration worktree
  platoonforge.conf
  swarmforge/
    roles/
      lieutenant.prompt
    constitution/
      articles/
        platoon-workflow.prompt
  .platoonforge/
    dashboard-url
    state...
  squad-a/                       # squad-a-squad-root worktree
    swarmforge/
    .swarmforge/
    .worktrees/                  # squad-a-prefixed role worktrees
  squad-b/                       # squad-b-squad-root worktree
    swarmforge/
    .swarmforge/
    .worktrees/                  # squad-b-prefixed role worktrees
  squad-c/                       # squad-c-squad-root worktree
    swarmforge/
    .swarmforge/
    .worktrees/                  # squad-c-prefixed role worktrees
```

The integration worktree and every squad worktree belong to one Git repository.
Each squad owns its herdr workspace, role worktrees, handoff daemon, and
`.swarmforge` state. The platoon directory is the integration worktree and
parent control plane. The platoon owns the single aggregate dashboard.

## Platoon Control Tooling

Platoon operation is tool-first. A dedicated control tool, provisionally named
`platoonctl`, should perform every deterministic operation that can be encoded
and validated, including:

- Recording and revising the system plan.
- Applying approval, rejection, retry, and delete transitions.
- Creating, configuring, starting, inspecting, and stopping squads.
- Generating squad-prefixed worktree, branch, herdr, and runtime identities.
- Assigning approved component tasks.
- Reporting squad status and attention items.
- Routing operator actions to the owning squad.
- Recovering and reconciling durable platoon state after interruption.
- Preparing integration-ready work and performing an explicit full-history
  merge when directed by the Lieutenant.

The Lieutenant decides what should happen and invokes the tool to perform it.
Prompt-directed shell work remains available when the tooling cannot handle an
operation, but it must not bypass approval or other control-plane invariants.
The result of a prompt-directed operation must be reconciled into durable
platoon state.

## Component Architecture

Each squad produces one independently deployable component. The component is a
packaging and deployment boundary, not necessarily a process boundary. It may
contain multiple internal architectural layers.

Levels are defined by distance from IO:

- **Low level**: Close to IO, devices, databases, frameworks, transports,
  external services, and delivery mechanisms.
- **High level**: Far from IO, policy, rules, use cases, and domain decisions.

Dependencies between layers inside a component must point toward the
higher-level policy. A component may contain high-level policy and low-level IO
adapters when its internal dependency structure preserves that direction. A
component should be split only when the resulting artifacts form useful,
cohesive deployment boundaries, not merely because the code occupies different
architectural levels.

## Inter-Component Interfaces

Components communicate through polymorphic interfaces appropriate to their
language:

- Clojure: protocols
- Java: interfaces
- Go: interface types
- TypeScript: interfaces or abstract service contracts

Squads depend on contracts, not on one another's concrete implementations.

Interfaces between two components are defined in the higher-level component and
implemented in the lower-level component. The lower-level component acts as a
plugin to the higher-level component, even when runtime calls flow in the
opposite direction.

An implementation may call local code or communicate with a remote service. In
the remote case, the adapter implements the higher-level polymorphic interface
and hides the wire protocol and service client from the higher-level component.

Interfaces do not have to be complete before the system plan is approved. A
higher-level squad may develop an interface during execution and publish it as
a contract milestone. The Lieutenant accepts a specific contract commit before
starting dependent squads. An accepted contract version is immutable. Any
revision creates a new version, identifies affected squads, blocks incompatible
integration, and creates explicit update work for those dependents.

## Dependency Rule

Dependencies between components always point toward the higher-level component.

Example:

```text
Level 3: order-processing
  Defines PaymentPort.

Level 2: stripe-adapter
  Depends on order-processing.
  Implements PaymentPort.

Level 1: web-api
  Depends on order-processing.
  Drives order-processing use cases.
```

Dependency arrows:

```text
web-api         -> order-processing
stripe-adapter -> order-processing
```

The high-level component must not depend on lower-level implementations.

## Lieutenant Responsibilities

The Lieutenant should:

- Decompose large operator goals into squad-sized component tasks.
- Identify component boundaries and internal architectural layers with the
  user.
- Define or approve cross-component interfaces.
- Select a pack deployment for every component before presenting the system
  plan.
- Produce the complete system plan and wait for user approval before starting
  squads.
- Reanalyze and revise rejected plans on retry, including pack deployment when
  appropriate.
- Approve or reject squad-level work after the operator approves the system
  plan.
- Assign each approved component to its planned squad.
- Ensure every component documents its internal layers and dependency
  directions.
- Maintain the platoon dependency graph.
- Enforce the Dependency Rule across components.
- Ensure cross-component interfaces are owned by the higher-level component.
- Prevent concrete coupling between squad directories.
- Coordinate compatibility between components.
- Accept and version contract commits, and start dependent squads only when
  their required contracts are available.
- Use platoon control tools for all supported operations and use prompt
  direction only for unsupported cases.
- Monitor squad progress.
- Independently rerun a completed component's full test suite before
  integration.
- Review integration-ready work and explicitly merge the squad-root branch with
  full history into the integration worktree.
- Run contract, compatibility, integration, and system tests after integration.
- Write and execute the system-level test procedure for the full platoon
  objective.
- Escalate ambiguous requirements, architectural conflicts, or dependency-rule
  violations to the operator.

## Platoon Dashboard

The platoon dashboard should use the existing pack dashboard as its skeleton,
but scale the board up one level. It is the only dashboard presented to the
operator; individual squads do not expose separate dashboard interfaces.

The board consists of horizontal squad rows. Each row represents one squad and
contains that squad's normal pack swim lanes.

Example:

```text
Squad: billing-core
  specifier | coder | refactorer | architect | Done

Squad: billing-postgres
  coder | cleaner | Done

Squad: billing-web
  specifier | coder | cleaner | architect | hardender | QA | Done
```

This preserves the familiar pack lane model while making platoon-level status
visible at a glance.

The work queue becomes a scrolling list of agents subdivided by squad:

```text
billing-core
  specifier
  coder
  refactorer
  architect

billing-postgres
  coder
  cleaner

billing-web
  specifier
  coder
  cleaner
  architect
  hardender
  QA
```

The Lieutenant should remain visually distinct from the squads, since it is the
platoon-level overseer rather than a member of any one squad. Attention items
should aggregate across the Lieutenant and all squads, with enough labeling to
show which squad and agent require action.

## Ancillary Operational Decisions

### Repository And Namespacing

The platoon uses one Git repository. The platoon directory is its integration
worktree. Every squad root is another worktree from that repository, and all
role worktrees created by the squad are worktrees from the same repository.

Every squad has a stable name. A squad named `billing` uses
`billing-squad-root` as its root worktree and branch identity instead of the
pack keyword `master`. Every other worktree and branch created for that squad
is also prefixed with `billing-`. Pack launch, root-role discovery, handoff
routing, and dashboard aggregation must use the explicit squad-root identity
rather than assuming that the literal name `master` identifies the root.

### Dependency Scheduling

Approved squads are not all started at once. The tooling starts only squads
whose dependencies are ready. A squad waiting for an interface contract remains
unstarted and consumes no agent sessions. When the contract-owning squad
publishes a contract commit, the Lieutenant may accept that immutable version;
the tooling then starts squads that have become ready.

Changing an accepted contract creates a new version and explicit work for every
affected dependent. It does not silently mutate the contract against which an
already-running squad is working.

### Completion And Integration

A squad owns the creation and execution of its internal verification. When its
pack workflow completes, it publishes its final commit and enters
`integration-ready`. Completion does not automatically alter the integration
worktree.

The Lieutenant independently reruns the component's complete test suite. After
review, the Lieutenant explicitly directs the tooling to merge the squad-root
branch into the integration worktree while preserving its full history. The
Lieutenant then runs contract, compatibility, integration, and system tests.

The operator approves the system plan. Once that plan is approved, the
Lieutenant handles squad-level approvals with platoon tooling. The squad remains
responsible for verification within its own workflow; the Lieutenant's test run
is an independent integration gate, not a replacement for squad verification.

### Recovery And Dashboard

Platoon state is durable. After the platoon or Lieutenant process restarts, the
tooling automatically reconciles registered squad directories, branches, herdr
sessions, daemons, and runtime state, and resumes work that had been running.
Conditions it cannot repair are reported for intervention.

There is one aggregate platoon dashboard. It shows the Lieutenant and all squad
lanes, queues, attention items, approvals, and integration-ready work, and
routes actions to the owning control-plane or squad operation. Per-squad
dashboards are not separate operator surfaces.

## Open Design Questions

- What exact format should `platoonforge.conf` use?
- What exact CLI and state schema should the platoon control tool expose?
- How should the generated squad-root marker coexist with the existing
  `master` keyword for non-platoon packs?
- What internal API should the aggregate dashboard use to inspect and control
  squads without exposing separate squad dashboards?
- How should internal component architecture and dependency direction be
  represented and validated?
- How should interface ownership be represented across languages?
- What exact state transition should occur when the Lieutenant's pre-merge
  component test run fails?
- How should a failed post-merge contract, integration, or system test be
  recovered without losing the merged squad history?
- What final evidence proves the complete platoon objective has been met?
