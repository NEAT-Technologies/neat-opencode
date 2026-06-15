# @opencode-ai/pistis

AI remediation execution layer for [NEAT](https://github.com/anomalyco/neat).

NEAT Core tells Pistis where the error is and provides graph context.
Pistis decides what to do, plans the remediation, applies safety gates,
orchestrates OpenCode-style agents/subagents to implement the fix,
validates the result, and emits auditable artifacts.

This package is a bridge inside the OpenCode fork. The CLI entry point
is registered in `packages/opencode` as `opencode pistis run`.

## Phase 1 — Deterministic dry-run scaffold

Phase 1 implements:

- Incident schema normalization
- NEAT REST client (read-only)
- NEAT graph context builder
- Deterministic planner/classifier + plan generator
- Risk-gate preflight
- Policy gate (defers to NEAT policy responses)
- Dispatcher interface + `NoopDispatcher` (writes intended dispatch as artifact)
- Artifact store
- Final-report generator
- Thin CLI command `opencode pistis run`

Phase 1 does **not** modify repo files, run agents, edit code, or open PRs.

## Usage (Phase 1)

```
opencode pistis run \
  --incident ./examples/pistis/incident.json \
  --neat-url http://localhost:8080 \
  --project demo \
  --dry-run
```

Outputs:

```
.pistis/runs/<incident-id>/
  incident.json
  graph-context.json
  plan.md
  validation.json
  dispatch-request.json
  final-report.md
```

## Boundaries

- **NEAT Core** owns: detection, graph, provenance, incidents, policies,
  divergences, root-cause / blast-radius APIs.
- **Pistis** owns: intake, remediation planning, risk gating, artifacts,
  agent dispatching, validation, reporting, future PR creation.
- **OpenCode** owns: agent/session/tool execution substrate.

Pistis does **not** import NEAT Core directly. It treats NEAT as an
external read-only REST source of truth.
