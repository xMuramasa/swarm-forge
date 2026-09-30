import { describe, expect, test } from "bun:test";
import {
  crapScore, evaluate, functionCoverage, normalize, parseArgs, parseCsv, parseLcov, parseLizardCsv,
} from "../../swarmforge/scripts/crap.ts";

const lizardCsv =
  '13,5,60,1,14,"classify@1-14@src/c.ts","src/c.ts","classify","classify ( n )",1,14\n' +
  '3,1,18,2,3,"add@14-16@src/c.ts","src/c.ts","add","add ( a , b )",14,16\n';

describe("csv", () => {
  test("quoted fields may contain commas and doubled quotes", () => {
    expect(parseCsv('a,"b,c","d ""q"""\n1,2,3\n')).toEqual([["a", "b,c", 'd "q"'], ["1", "2", "3"]]);
  });

  test("lizard rows become functions with an absolute file", () => {
    const [classify] = parseLizardCsv(lizardCsv);
    expect(classify).toEqual({ file: normalize("src/c.ts"), name: "classify", ccn: 5, start: 1, end: 14 });
  });
});

describe("crap", () => {
  test("scores each function from lizard and lcov: half covered vs fully covered", () => {
    const coverage = parseLcov("TN:\nSF:src/c.ts\nDA:2,2\nDA:3,1\nDA:6,0\nDA:7,0\nDA:15,1\nend_of_record\n");
    const [worst, best] = evaluate(parseLizardCsv(lizardCsv), coverage);
    expect(worst.name).toBe("classify");
    expect(worst.crap).toBeCloseTo(8.125, 9);
    expect(best.name).toBe("add");
    expect(best.crap).toBe(1);
  });

  test("an unloaded file is uncovered and a function with no executable lines is covered", () => {
    const fn = { file: normalize("src/c.ts"), start: 1, end: 5, ccn: 3 };
    expect(functionCoverage(new Map(), fn)).toBe(0);
    expect(crapScore(3, 0)).toBe(12);
    expect(functionCoverage(new Map([[fn.file, new Map([[50, 1]])]]), fn)).toBe(1);
  });

  test("options and paths are parsed", () => {
    expect(parseArgs(["--lcov", "c.lcov", "--threshold", "5", "src", "lib"])).toEqual({ lcov: "c.lcov", threshold: 5, paths: ["src", "lib"] });
    expect(parseArgs(["src"]).threshold).toBe(10);
  });
});
