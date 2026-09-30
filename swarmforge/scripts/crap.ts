#!/usr/bin/env bun
// CRAP score for any language `lizard` understands, from an lcov coverage report.
//   crap.sh --lcov coverage/lcov.info [--threshold 10] <source file or dir> ...
// CRAP = ccn^2 * (1 - coverage)^3 + ccn, per function. Prints the functions over the
// threshold, worst first, and exits 1 when there are any.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

export const defaultThreshold = 10;

export type Fn = { file: string; name: string; ccn: number; start: number; end: number };
export type Scored = Fn & { coverage: number; crap: number };

export const normalize = (path: string) => resolve(path);

/** Rows of a CSV text (RFC 4180 quoting, which is what lizard prints). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

/** lizard --csv rows. Columns: nloc ccn token param length location file name long-name start end. */
export function parseLizardCsv(text: string): Fn[] {
  return parseCsv(text)
    .filter((r) => /^\d+$/.test(r[1] ?? "") && r[6])
    .map((r) => ({ file: normalize(r[6]), name: r[7], ccn: Number(r[1]), start: Number(r[9]), end: Number(r[10]) }));
}

/** lcov text -> {absolute file -> {line -> hits}}, from the SF and DA records. */
export function parseLcov(text: string): Map<string, Map<number, number>> {
  const coverage = new Map<string, Map<number, number>>();
  let current: Map<number, number> | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      const file = normalize(line.slice(3));
      current = coverage.get(file) ?? new Map();
      coverage.set(file, current);
    } else if (current && line.startsWith("DA:")) {
      const [n, hits] = line.slice(3).split(",");
      current.set(Number(n), Number(hits));
    }
  }
  return coverage;
}

/** Share of the function's executable lines that ran. A file missing from the report was never
 *  loaded, so 0. A function with no executable lines (types, declarations) counts as covered. */
export function functionCoverage(coverage: Map<string, Map<number, number>>, fn: Pick<Fn, "file" | "start" | "end">): number {
  const hits = coverage.get(fn.file);
  if (!hits) return 0;
  const inRange = [...hits].filter(([n]) => n >= fn.start && n <= fn.end);
  return inRange.length === 0 ? 1 : inRange.filter(([, h]) => h > 0).length / inRange.length;
}

export const crapScore = (ccn: number, coverage: number) => ccn * ccn * (1 - coverage) ** 3 + ccn;

/** Every function with its coverage and CRAP, worst first. */
export function evaluate(functions: Fn[], coverage: Map<string, Map<number, number>>): Scored[] {
  return functions
    .map((fn) => {
      const cov = functionCoverage(coverage, fn);
      return { ...fn, coverage: cov, crap: crapScore(fn.ccn, cov) };
    })
    .sort((a, b) => b.crap - a.crap);
}

function lizardCommand(): string[] {
  return spawnSync("sh", ["-c", "command -v lizard >/dev/null 2>&1"]).status === 0 ? ["lizard"] : ["uvx", "lizard"];
}

function runLizard(paths: string[]): string {
  const [cmd, ...rest] = lizardCommand();
  const r = spawnSync(cmd, [...rest, "--csv", ...paths], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    process.stderr.write(`lizard failed: ${r.stderr || r.error}\n`);
    process.exit(2);
  }
  return r.stdout;
}

export function parseArgs(args: string[]): { lcov?: string; threshold: number; paths: string[] } {
  const opts: { lcov?: string; threshold: number; paths: string[] } = { threshold: defaultThreshold, paths: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--lcov") opts.lcov = args[++i];
    else if (args[i] === "--threshold") opts.threshold = Number(args[++i]);
    else opts.paths.push(args[i]);
  }
  return opts;
}

const reportLine = (f: Scored) =>
  `CRAP ${f.crap.toFixed(1).padStart(6)}  CCN ${String(f.ccn).padStart(3)}  COV ${String(Math.floor(f.coverage * 100)).padStart(3)}%  ${relative(process.cwd(), f.file)}:${f.start} ${f.name}`;

export function main(args: string[]): number {
  const { lcov, threshold, paths } = parseArgs(args);
  if (!lcov || !paths.length) {
    process.stderr.write("Usage: crap.sh --lcov <lcov file> [--threshold 10] <source file or dir> ...\n");
    return 2;
  }
  if (!existsSync(lcov) || !statSync(lcov).isFile()) {
    process.stderr.write(`No coverage report at ${lcov} - run the tests with lcov coverage first.\n`);
    return 2;
  }
  const scored = evaluate(parseLizardCsv(runLizard(paths)), parseLcov(readFileSync(lcov, "utf8")));
  const over = scored.filter((f) => f.crap > threshold);
  console.log(`${scored.length} functions, ${over.length} over CRAP ${threshold}`);
  for (const f of over) console.log(reportLine(f));
  return over.length ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
