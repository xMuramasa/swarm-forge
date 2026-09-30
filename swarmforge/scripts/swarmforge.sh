#!/usr/bin/env zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Operator commands run in swarmctl; everything else starts (or stops) the swarm.
case "${1:-}" in
  status|task|approve|reject|help)
    exec bun "$SCRIPT_DIR/swarmctl.ts" "$@"
    ;;
esac

exec bun "$SCRIPT_DIR/swarmforge.ts" "$@"
