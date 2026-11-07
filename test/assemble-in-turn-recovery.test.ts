/**
 * In-assemble forced recovery inside one long tool-heavy turn.
 *
 * Routine pressure relief protects everything after the newest user, so a
 * long single worker turn found nothing to summarize and degraded to a raw
 * live clamp that shrank on every request. assemble() now runs the
 * authoritative forced-recovery path once per pressure episode before
 * degrading, summarizing completed tool groups of the current turn.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupEngineTestState, createEngineWithDeps, seedStoredMessage } from "./helpers.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import type { VisibleSessionTranscriptMessageEntry } from "../src/types.js";
import { estimateSerializedMessagesTokens } from "../src/estimate-tokens.js";
import { attachTranscriptEntryMeta } from "../src/transcript.js";

afterEach(() => {
  delete process.env.LCM_ASSEMBLE_FORCED_RECOVERY;
  return cleanupEngineTestState();
});

const sessionId = "in-turn-recovery";
const sessionKey = "agent:coder:subagent:in-turn";
const sessionTarget = { sessionId, sessionKey, agentId: "coder", storePath: "/tmp/host.sqlite", threadId: "child" };
const runtimeSettings = { schemaVersion: 1, executionHost: { id: "openclaw-embedded", label: "OpenClaw" } } as const;
const config = {
  freshTailCount: 4,
  freshTailMaxTokens: 2500,
  leafChunkTokens: 3000,
  bootstrapMaxTokens: 1000,
  maxAssemblyTokenBudget: 8000,
  contextThreshold: 0.7,
  largeFileTokenThreshold: 1000000,
};

function transcript(pairs = 12): VisibleSessionTranscriptMessageEntry[] {
  const messages: AgentMessage[] = [{ role: "user", content: "Inspect the files and report their findings." }];
  for (let index = 0; index < pairs; index++) {
    messages.push({
      role: "assistant",
      content: [{ type: "toolCall", id: `call_${index}`, name: "read", arguments: { path: `file-${index}` } }],
    } as AgentMessage);
    messages.push({
      role: "toolResult",
      toolCallId: `call_${index}`,
      toolName: "read",
      content: [{ type: "text", text: `FILE_${index} ${"evidence ".repeat(500)}` }],
    } as AgentMessage);
  }
  return messages.map((message, index) => ({
    entryId: `entry-${index}`,
    parentId: index ? `entry-${index - 1}` : null,
    seq: index + 1,
    role: message.role,
    message,
    createdAt: new Date(1789730000000 + index).toISOString(),
  }));
}

async function setup() {
  const entries = transcript();
  const complete = vi.fn(async () => ({
    content: [{ type: "text", text: "Completed file reads found deployment evidence; see linked raw messages." }],
  }));
  const info = vi.fn();
  const warn = vi.fn();
  const engine = createEngineWithDeps(config, {
    complete,
    readVisibleSessionTranscriptMessageEntries: vi.fn(async () => entries),
    log: { info, debug: vi.fn(), warn, error: warn },
  });
  await seedStoredMessage(engine, {
    sessionId,
    sessionKey,
    message: attachTranscriptEntryMeta(entries[0]!.message, {
      entryId: entries[0]!.entryId,
      parentId: null,
      timestamp: entries[0]!.createdAt ?? null,
    }),
  });
  const live = entries.map((entry) => entry.message);
  return { engine, complete, info, warn, live };
}

function logged(fn: ReturnType<typeof vi.fn>, text: string): boolean {
  return fn.mock.calls.some((call) => String(call[0]).includes(text));
}

describe("in-assemble forced recovery", () => {
  it("summarizes completed tool groups of the current turn instead of degrading", async () => {
    const { engine, complete, info, warn, live } = await setup();
    // Same budget as the upstream overflow-recovery test (live turn ~33k).
    const tokenBudget = 8000;
    expect(estimateSerializedMessagesTokens(live)).toBeGreaterThan(tokenBudget);

    const result = await engine.assemble({
      sessionId, sessionKey, messages: live, tokenBudget, runtimeSettings,
      runtimeContext: { sessionTarget },
    });

    expect(complete).toHaveBeenCalled();
    expect(logged(info, "in-turn forced recovery")).toBe(true);
    expect(logged(info, "compacted=true")).toBe(true);
    expect(logged(warn, "degraded live fallback")).toBe(false);
    expect(logged(warn, "bounded live fallback")).toBe(false);
    // The reassembled prompt carries a summary of the earlier tool groups.
    expect(result.messages.some((m) => JSON.stringify(m.content).includes("<summary"))).toBe(true);
    expect(estimateSerializedMessagesTokens(result.messages)).toBeLessThanOrEqual(tokenBudget);
    const rendered = result.messages.map((m) => JSON.stringify(m.content));
    // The initiating user survives and the newest tool result stays raw.
    expect(rendered.some((c) => c.includes("Inspect the files"))).toBe(true);
    expect(rendered.some((c) => c.includes("FILE_11"))).toBe(true);
  });

  it("tries only once per pressure episode while the host budget keeps shrinking", async () => {
    const { engine, info, live } = await setup();
    for (const tokenBudget of [6000, 5500, 5000]) {
      await engine.assemble({
        sessionId, sessionKey, messages: live, tokenBudget, runtimeSettings,
        runtimeContext: { sessionTarget },
      });
    }
    const attempts = info.mock.calls.filter((call) => String(call[0]).includes("in-turn forced recovery")).length;
    expect(attempts).toBe(1);
  });

  it("degrades as before when disabled", async () => {
    process.env.LCM_ASSEMBLE_FORCED_RECOVERY = "false";
    const { engine, complete, info, live } = await setup();
    await engine.assemble({
      sessionId, sessionKey, messages: live, tokenBudget: 6000, runtimeSettings,
      runtimeContext: { sessionTarget },
    });
    expect(logged(info, "in-turn forced recovery")).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });

  it("does nothing without a resolvable host transcript target", async () => {
    const { engine, info, live } = await setup();
    await engine.assemble({ sessionId, sessionKey: undefined, messages: live, tokenBudget: 6000, runtimeSettings });
    expect(logged(info, "in-turn forced recovery")).toBe(false);
  });
});
