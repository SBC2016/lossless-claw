/**
 * Yield to host compaction when the host delivers the current turn separately.
 *
 * Inside one long worker turn the host's history budget shrinks by every
 * pending message of the turn. Clamping history to that collapsing budget
 * hid the pressure from the host's overflow precheck and rewrote the prompt
 * prefix on every request. assemble() now keeps the history at a stable size
 * so the host sees the overflow and compacts the turn itself.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import { cleanupEngineTestState, createEngineWithDeps, makeMessage } from "./helpers.js";

afterEach(() => {
  delete process.env.LCM_ASSEMBLE_YIELD_TO_HOST;
  return cleanupEngineTestState();
});

const SESSION = "yield-to-host";
const HOST_BUDGET = 6_000;
/** Host budget on the first request of the turn (history fits). */
const TURN_START_BUDGET = 9_000;

function fixture() {
  const complete = vi.fn(async () => ({ content: [{ type: "text", text: "Summary." }] }));
  const readVisibleSessionTranscriptMessageEntries = vi.fn(async () => []);
  const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  const engine = createEngineWithDeps({
    contextThreshold: 0.65,
    // Everything is fresh tail: routine relief has nothing to summarize.
    freshTailCount: 64,
    leafChunkTokens: 6_000,
    summaryProvider: "anthropic",
    summaryModel: "synthetic-summary",
  }, { complete, log, readVisibleSessionTranscriptMessageEntries });
  return { engine, complete, log, readVisibleSessionTranscriptMessageEntries };
}

async function seed(engine: ReturnType<typeof fixture>["engine"]) {
  const messages: AgentMessage[] = [];
  for (let turn = 0; turn < 6; turn += 1) {
    messages.push(
      makeMessage({ role: "user", content: `Inspect observation ${turn}`, timestamp: turn * 2 + 1 }),
      makeMessage({ role: "assistant", content: `Observation ${turn}: ${"synthetic observation. ".repeat(400)}`, timestamp: turn * 2 + 2 }),
    );
  }
  for (const message of messages) await engine.ingest({ sessionId: SESSION, message });
  return messages;
}

/** First request of the turn: the host budget still has room. */
async function startTurn(engine: ReturnType<typeof fixture>["engine"], messages: AgentMessage[]) {
  await engine.assemble({
    sessionId: SESSION, messages, tokenBudget: TURN_START_BUDGET,
    prompt: "Next observation", availableTools: new Set(["inspect"]),
  });
}

const text = (calls: unknown[][]) => calls.flat().join("\n");
const userTurns = (messages: AgentMessage[]) => messages
  .filter(message => message.role === "user")
  .map(message => typeof message.content === "string" ? message.content : JSON.stringify(message.content))
  .filter(content => content.startsWith("Inspect observation"));

describe("assemble yields to host compaction", () => {
  it("keeps the full history instead of degrading when the host delivers the turn separately", async () => {
    const { engine, complete, log, readVisibleSessionTranscriptMessageEntries } = fixture();
    const messages = await seed(engine);
    await startTurn(engine, messages);
    log.info.mockClear(); log.warn.mockClear();
    const output = await engine.assemble({
      sessionId: SESSION, messages, tokenBudget: HOST_BUDGET,
      prompt: "Next observation", availableTools: new Set(["inspect"]),
    });
    expect(text(log.info.mock.calls)).toContain("assemble: yield to host compaction");
    expect(text(log.warn.mock.calls)).not.toMatch(/degraded live fallback|serialized budget clamp/);
    // Every turn survives, so the host's overflow precheck sees the real size.
    expect(userTurns(output.messages)).toHaveLength(6);
    expect(output.estimatedTokens).toBeGreaterThan(HOST_BUDGET);
    // The in-assemble forced recovery is not used in this mode.
    expect(text(log.info.mock.calls)).not.toContain("in-turn forced recovery");
    expect(readVisibleSessionTranscriptMessageEntries).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("returns the same prefix on the next request while the host budget keeps shrinking", async () => {
    const { engine, log } = fixture();
    const messages = await seed(engine);
    const args = { sessionId: SESSION, messages, prompt: "Next observation", availableTools: new Set(["inspect"]) };
    await startTurn(engine, messages);
    log.warn.mockClear();
    const first = await engine.assemble({ ...args, tokenBudget: HOST_BUDGET });
    const second = await engine.assemble({ ...args, tokenBudget: HOST_BUDGET - 2_500 });
    const third = await engine.assemble({ ...args, tokenBudget: 1 });
    expect(JSON.stringify(second.messages)).toBe(JSON.stringify(first.messages));
    expect(JSON.stringify(third.messages)).toBe(JSON.stringify(first.messages));
    expect(text(log.warn.mock.calls)).not.toContain("degraded live fallback");
  });

  it("degrades as before when disabled", async () => {
    process.env.LCM_ASSEMBLE_YIELD_TO_HOST = "false";
    const { engine, log } = fixture();
    const messages = await seed(engine);
    await startTurn(engine, messages);
    const output = await engine.assemble({
      sessionId: SESSION, messages, tokenBudget: HOST_BUDGET,
      prompt: "Next observation", availableTools: new Set(["inspect"]),
    });
    expect(text(log.info.mock.calls)).not.toContain("yield to host compaction");
    // History is trimmed to the shrinking budget again (clamp or degrade).
    expect(text(log.warn.mock.calls)).toMatch(/degraded live fallback|serialized budget clamp/);
    expect(userTurns(output.messages).length).toBeLessThan(6);
  });

  it("does not yield on a large single change of limits (not a same-turn shrink)", async () => {
    const { engine, log } = fixture();
    const messages = await seed(engine);
    await engine.assemble({
      sessionId: SESSION, messages, tokenBudget: 100_000,
      prompt: "Next observation", availableTools: new Set(["inspect"]),
    });
    await engine.assemble({
      sessionId: SESSION, messages, tokenBudget: HOST_BUDGET,
      prompt: "Next observation", availableTools: new Set(["inspect"]),
    });
    expect(text(log.info.mock.calls)).not.toContain("yield to host compaction");
  });

  it("ends the yield episode when the host budget grows again", async () => {
    const { engine, log } = fixture();
    const messages = await seed(engine);
    const args = { sessionId: SESSION, messages, prompt: "Next observation", availableTools: new Set(["inspect"]) };
    await startTurn(engine, messages);
    await engine.assemble({ ...args, tokenBudget: HOST_BUDGET });
    expect(text(log.info.mock.calls)).toContain("yield to host compaction");
    log.info.mockClear();
    // Host compacted and the next turn starts with room again, then a large drop.
    await engine.assemble({ ...args, tokenBudget: 100_000 });
    await engine.assemble({ ...args, tokenBudget: HOST_BUDGET });
    expect(text(log.info.mock.calls)).not.toContain("yield to host compaction");
  });

  it("does not yield when the host delivers the whole transcript as history", async () => {
    const { engine, log } = fixture();
    const messages = await seed(engine);
    await engine.assemble({ sessionId: SESSION, messages, tokenBudget: TURN_START_BUDGET });
    await engine.assemble({ sessionId: SESSION, messages, tokenBudget: HOST_BUDGET });
    expect(text(log.info.mock.calls)).not.toContain("yield to host compaction");
  });
});
