import { describe, expect, it } from "vitest";
import {
  resolveStableAssemblyBudget,
  type StableBudgetState,
} from "../src/stable-assembly-budget.js";

function run(hostBudgets: number[]): number[] {
  let state: StableBudgetState | undefined;
  return hostBudgets.map((hostBudget) => {
    const r = resolveStableAssemblyBudget({ hostBudget, previous: state });
    state = r.state;
    return r.budget;
  });
}

function changes(values: number[]): number {
  let n = 0;
  for (let i = 1; i < values.length; i += 1) if (values[i] !== values[i - 1]) n += 1;
  return n;
}

// Host budgets observed in one 35-minute single-turn run (budget shrinks every request).
const OBSERVED = [
  54577, 40000, 38108, 31566, 30090, 26096, 24765, 16621, 15696, 13125, 11886, 8320, 7030, 5665,
  5365, 3102, 2140, 1383, 826, 1,
];

describe("resolveStableAssemblyBudget", () => {
  it("uses the host budget on the first call", () => {
    expect(run([54577])).toEqual([54577]);
  });

  it("keeps the same budget while the host budget drifts down but the previous one still fits", () => {
    // first call 40000; host falls to 39388 (still >= effective? no: effective 40000 > 39388) -> step down once
    const out = run([40000, 39388, 37382, 36000, 35000]);
    expect(out[0]).toBe(40000);
    expect(out[1]).toBe(Math.floor(39388 * 0.6));
    expect(out.slice(1)).toEqual([out[1], out[1], out[1], out[1]]);
  });

  it("steps down with headroom and then holds until the host budget falls below it", () => {
    const out = run([20000, 10000, 9000, 8000, 7000, 5000]);
    expect(out).toEqual([20000, 6000, 6000, 6000, 6000, 3000]);
  });

  it("never exceeds the host budget", () => {
    const out = run(OBSERVED);
    out.forEach((b, i) => expect(b).toBeLessThanOrEqual(OBSERVED[i]!));
  });

  it("changes the assembly boundary far less often than assembling to every host budget", () => {
    const out = run(OBSERVED);
    expect(changes(OBSERVED)).toBe(19);
    expect(changes(out)).toBeLessThanOrEqual(9);
  });

  it("resets to the full budget when the host budget grows (new turn or after a compaction)", () => {
    expect(run([20000, 12000, 54577])).toEqual([20000, 7200, 54577]);
  });

  it("follows a large single drop exactly (a real change of limits, not drift)", () => {
    expect(run([10000, 300])).toEqual([10000, 300]);
    expect(run([61920, 20000])).toEqual([61920, 20000]);
  });

  it("keeps a floor of 1", () => {
    expect(run([1, 1, 1])).toEqual([1, 1, 1]);
    expect(run([2, 1])).toEqual([2, 1]);
  });
});
