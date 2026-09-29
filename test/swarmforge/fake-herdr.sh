#!/usr/bin/env sh
# Fake herdr for tests. State lives in $FAKE_HERDR_DIR:
#   agents/<name>   exists => that agent is alive; its content is what `agent read` prints
#   status/<name>   the agent's status for `agent get` (default idle)
#   calls.log       every invocation's arguments, one per line
#   prompts.log     "<name><TAB><text>" per `agent prompt`
#   closed.log      the workspace id of each `workspace close`
d="${FAKE_HERDR_DIR:?FAKE_HERDR_DIR is not set}"
mkdir -p "$d/agents"
printf '%s\n' "$*" >> "$d/calls.log"
missing() {
  printf '{"error":{"code":"agent_not_found","message":"agent %s not found"}}\n' "$1"
  exit 1
}
# panes and tabs are numbered by how many have been created so far
next_pane() {
  n=$(($(cat "$d/panes" 2>/dev/null || echo 0) + 1))
  echo "$n" > "$d/panes"
  echo "$n"
}
case "$1 $2" in
  "agent get")
    [ -f "$d/agents/$3" ] || missing "$3"
    status=$(cat "$d/status/$3" 2>/dev/null || echo idle)
    printf '{"result":{"type":"agent_info","agent":{"agent_status":"%s"}}}\n' "$status" ;;
  "agent read")
    [ -f "$d/agents/$3" ] || missing "$3"
    cat "$d/agents/$3" ;;
  "agent prompt")
    [ -f "$d/agents/$3" ] || missing "$3"
    printf '%s\t%s\n' "$3" "$4" >> "$d/prompts.log"
    printf '{"result":{"type":"ok"}}\n' ;;
  "agent start")
    # like the real herdr, refuse control characters in agent arguments
    nl='
'
    tab=$(printf '\t')
    case "$*" in
      *"$nl"* | *"$tab"*)
        printf '{"error":{"code":"invalid_agent_argument","message":"agent arguments cannot be encoded safely for the target shell"}}\n'
        exit 1 ;;
    esac
    : > "$d/agents/$3"
    printf '{"result":{"type":"agent_started"}}\n' ;;
  "workspace create")
    n=$(next_pane)
    printf '{"result":{"type":"workspace_created","root_pane":{"pane_id":"w1:p%s"},"tab":{"tab_id":"w1:t%s"},"workspace":{"workspace_id":"w1"}}}\n' "$n" "$n" ;;
  "tab create")
    n=$(next_pane)
    printf '{"result":{"type":"tab_created","root_pane":{"pane_id":"w1:p%s"},"tab":{"tab_id":"w1:t%s"}}}\n' "$n" "$n" ;;
  "tab rename" | "pane run" | "pane wait-output")
    printf '{"result":{"type":"ok"}}\n' ;;
  "workspace close")
    printf '%s\n' "$3" >> "$d/closed.log"
    printf '{"result":"ok"}\n' ;;
  "workspace list")
    printf '{"result":{"type":"workspace_list","workspaces":[]}}\n' ;;
  *)
    printf '{"error":{"code":"unsupported","message":"fake herdr: %s %s"}}\n' "$1" "$2"
    exit 1 ;;
esac
