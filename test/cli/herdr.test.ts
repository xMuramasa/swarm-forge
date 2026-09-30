import { describe, expect, test } from "bun:test";
import { agentName, clean, gridPlan, oneLine, sq } from "../../swarmforge/scripts/herdr.ts";

describe("agent names", () => {
  test("are sf-<project>-<role>, lowercased, and valid for herdr", () => {
    expect(agentName("/x/My Project", "QA")).toBe("sf-my-project-qa");
    const long = agentName("/x/a-very-long-project-directory-name", "specifier");
    expect(long.length).toBeLessThanOrEqual(32);
    expect(long).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  });

  test("a role name too long for the limit is refused", () => {
    expect(() => agentName("/x/p", "r".repeat(40))).toThrow();
  });

  test("clean lowercases and replaces anything else with dashes", () => {
    expect(clean("Mi Proyecto_v2!")).toBe("mi-proyecto_v2");
  });
});

describe("grid plan", () => {
  test("tiles roles in two rows, filling the top row first", () => {
    expect(gridPlan(1)).toEqual([]);
    expect(gridPlan(2)).toEqual([[0, "right", 0.5]]);
    expect(gridPlan(3)).toEqual([[0, "right", 0.5], [0, "down", 0.5]]);
    expect(gridPlan(4)).toEqual([[0, "right", 0.5], [0, "down", 0.5], [1, "down", 0.5]]);
  });

  test("three columns keep 1/3 then 1/2 of what remains, so the widths are equal", () => {
    expect(gridPlan(6)).toEqual([[0, "right", 1 / 3], [1, "right", 0.5], [0, "down", 0.5], [1, "down", 0.5], [2, "down", 0.5]]);
  });
});

describe("text for herdr", () => {
  test("multi-line text becomes one line", () => {
    expect(oneLine("first\nsecond\n\nthird")).toBe("first second third");
    expect(oneLine("a\tb")).toBe("a b");
    expect(oneLine("plain text")).toBe("plain text");
  });

  test("single quotes are escaped for the shell", () => {
    expect(sq("it's")).toBe(`'it'"'"'s'`);
  });
});
