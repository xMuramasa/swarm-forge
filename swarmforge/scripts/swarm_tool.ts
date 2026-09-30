#!/usr/bin/env bun
// Install and check the quality tools the agents use, as wrappers under .swarmforge/bin.
//   swarm_tool.sh require <tool>    fails with MISSING unless the wrapper exists
//   swarm_tool.sh ensure <tool>     writes the wrapper (cloning or resolving the tool if needed)

import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ExitError, fail, projectRoot as libProjectRoot } from "./handoff_lib.ts";

type Tool = {
  source?: string; bbTask?: string; needs?: string[];
  mvn?: string; main?: string; version?: string; paths?: string[]; extraDeps?: Record<string, string>; args?: string[];
  exec?: string;
};

export const catalog: Record<string, Tool> = {
  "gherkin-parser": { source: "github.com/unclebob/Acceptance-Pipeline-Specification", bbTask: "gherkin-parser" },
  "ir-dry-checker": { source: "github.com/unclebob/Acceptance-Pipeline-Specification", bbTask: "gherkin-ir-dry-checker" },
  "gherkin-mutator": { source: "github.com/unclebob/Acceptance-Pipeline-Specification", bbTask: "gherkin-mutator" },
  crap4clj: { source: "github.com/unclebob/crap4clj", bbTask: "crap4clj", needs: ["cloverage"] },
  dry4clj: { source: "github.com/unclebob/dry4clj", bbTask: "dry4clj" },
  "clj-mutate": { source: "github.com/unclebob/clj-mutate", bbTask: "clj-mutate", needs: ["cloverage"] },
  cloverage: {
    mvn: "cloverage/cloverage", main: "cloverage.coverage", paths: ["src", "spec", "test"],
    extraDeps: { "speclj/speclj": "3.13.0" }, args: ["-p", "src", "-s", "spec", "-s", "test", "-r", "speclj"],
  },
  speclj: { mvn: "speclj/speclj", main: "speclj.main", version: "3.13.0", paths: ["src", "spec", "test"], args: ["-c", "spec"] },
  "speclj-structure-check": { source: "github.com/unclebob/speclj-structure-check", bbTask: "check" },
  crap4go: { source: "github.com/unclebob/crap4go", bbTask: "crap4go" },
  dry4go: { source: "github.com/unclebob/dry4go", bbTask: "dry4go" },
  mutate4go: { source: "github.com/unclebob/mutate4go", bbTask: "mutate4go" },
  // Language-agnostic tools run on demand: jscpd finds duplicated code, lizard measures
  // complexity (crap.sh combines it with coverage).
  jscpd: { exec: "pnpm dlx jscpd" },
  lizard: { exec: "uvx lizard" },
  crap4java: { source: "github.com/unclebob/crap4java", bbTask: "crap4java" },
  dry4java: { source: "github.com/unclebob/dry4java", bbTask: "dry4java" },
  mutate4java: { source: "github.com/unclebob/mutate4java", bbTask: "mutate4java" },
};

export const usageText = `Usage:
  swarm_tool.sh require <tool>
  swarm_tool.sh ensure <tool>

Tools: ${Object.keys(catalog).sort().join(", ")}`;

const sq = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
const projectRoot = () => {
  try {
    return libProjectRoot();
  } catch (e) {
    if (e instanceof ExitError) fail(e.exit, e.message);
    throw e;
  }
};

const canonicalTool = (tool: string) => (tool ?? "").toLowerCase();

function toolSpec(tool: string): Tool {
  const spec = catalog[canonicalTool(tool)];
  if (!spec) fail(1, `Unknown tool: ${tool}\n\n${usageText}`);
  return spec;
}

const wrapperPath = (root: string, tool: string) => join(root, ".swarmforge", "bin", canonicalTool(tool));
const neededTools = (tool: string) => toolSpec(tool).needs ?? [];

const executable = (path: string) => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const missingTool = (root: string, tool: string) => [tool, ...neededTools(tool)].find((t) => !executable(wrapperPath(root, t)));

function requireTool(tool: string): never {
  toolSpec(tool);
  const root = projectRoot();
  const missing = missingTool(root, tool);
  if (missing) fail(1, `MISSING: ${missing}\nRun: swarm_tool.sh ensure ${missing}`);
  console.log(`OK: ${tool} ${wrapperPath(root, tool)}`);
  process.exit(0);
}

const sourceDir = (root: string, source: string) =>
  process.env.SWARMFORGE_TOOL_SRC || join(root, ".swarmforge", "tools", source.split("/").at(-1)!);

function ensureSource(root: string, source: string): string {
  const dir = sourceDir(root, source);
  if (!existsSync(join(dir, "bb.edn"))) {
    if (process.env.SWARMFORGE_TOOL_SRC) fail(1, `SWARMFORGE_TOOL_SRC is missing bb.edn: ${dir}`);
    mkdirSync(dirname(dir), { recursive: true });
    const url = `https://${source}.git`;
    const r = spawnSync("git", ["clone", "--depth", "1", url, dir], { encoding: "utf8" });
    if (r.status !== 0) fail(1, `Failed to clone ${url}\n${r.stderr}${r.stdout}`);
  }
  return dir;
}

// The wrappers pin the worker counts and the differential mode the constitution requires.
const mutateRewrite = `args=()
scan=
while [ $# -gt 0 ]; do
  case "$1" in
    --mutate-all) shift ;;
    --scan|--update-manifest) scan=1; args+=("$1"); shift ;;
    --max-workers) shift; [ $# -gt 0 ] && shift ;;
    *) args+=("$1"); shift ;;
  esac
done
if [ -z "$scan" ]; then args+=(--max-workers 4); fi
set -- "\${args[@]}"
`;

const gherkinRewrite = `args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --level)
      if [ "\${2:-}" = full ]; then args+=(--level hard); else args+=("$1" "$2"); fi
      shift; [ $# -gt 0 ] && shift ;;
    --workers) shift; [ $# -gt 0 ] && shift ;;
    *) args+=("$1"); shift ;;
  esac
done
args+=(--workers 4)
set -- "\${args[@]}"
`;

const rewriteBash = (tool: string) =>
  ["clj-mutate", "mutate4go", "mutate4java"].includes(tool) ? mutateRewrite : tool === "gherkin-mutator" ? gherkinRewrite : "";

function writeWrapper(path: string, body: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/usr/bin/env bash\n${body}`);
  chmodSync(path, 0o755);
  return path;
}

const edn = (s: string) => JSON.stringify(s);
const coordDep = (coord: string, version: string) => `${coord} {:mvn/version ${edn(version)}}`;

function mvnWrapper(root: string, tool: string, spec: Tool): string {
  const deps = [coordDep(spec.mvn!, spec.version ?? "RELEASE"), ...Object.entries(spec.extraDeps ?? {}).map(([c, v]) => coordDep(c, v))].join(" ");
  const depsEdn = `{:paths [${(spec.paths ?? []).map(edn).join(" ")}] :deps {${deps}}}`;
  const args = (spec.args ?? []).join(" ");
  return writeWrapper(wrapperPath(root, tool), `${rewriteBash(tool)}exec clojure -Sdeps ${sq(depsEdn)} -M -m ${spec.main}${args ? ` ${args}` : ""} "$@"\n`);
}

function installOne(tool: string): void {
  const spec = toolSpec(tool);
  const root = projectRoot();
  const name = canonicalTool(tool);
  let target: string;
  if (spec.exec) {
    target = writeWrapper(wrapperPath(root, name), `exec ${spec.exec} "$@"\n`);
  } else if (spec.bbTask) {
    const config = join(ensureSource(root, spec.source!), "bb.edn");
    target = writeWrapper(wrapperPath(root, name), `${rewriteBash(name)}exec bb --config ${sq(config)} ${spec.bbTask} "$@"\n`);
  } else {
    target = mvnWrapper(root, name, spec);
  }
  console.log(`INSTALLED: ${name} ${target}`);
}

function ensureTool(tool: string): void {
  toolSpec(tool);
  for (const dep of neededTools(tool)) ensureTool(dep);
  installOne(tool);
}

export function main(args: string[]): void {
  if (args.includes("--help") || args.includes("-h")) {
    process.stderr.write(`${usageText}\n`);
    process.exit(0);
  }
  if (args.length !== 2) {
    process.stderr.write(`${usageText}\n`);
    process.exit(1);
  }
  const [command, tool] = args;
  if (command === "require") requireTool(tool);
  else if (command === "ensure") ensureTool(tool);
  else {
    process.stderr.write(`${usageText}\n`);
    process.exit(1);
  }
}

if (import.meta.main) main(process.argv.slice(2));
