#!/usr/bin/env zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Operator commands run in bun; everything else starts the swarm.
case "${1:-}" in
  status|task|approve|reject|help)
    exec bun "$SCRIPT_DIR/swarmctl.ts" "$@"
    ;;
esac

exec bb "$SCRIPT_DIR/swarmforge.bb" "$@"
