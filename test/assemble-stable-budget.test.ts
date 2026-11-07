/**
 * Cache stability of live-fallback assembly inside one long turn.
 *
 * The host passes a smaller tokenBudget on every request of a growing turn.
 * Assembling to each exact budget moved the live-clamp boundary on every
 * request, changing the prompt prefix and forcing prefix-caching providers to
 * re-read the whole prompt. assemble() must keep the boundary steady while the
 * budget only drifts down.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeLcmConnection, createLcmDatabaseConnection } from "../src/db/connection.js";
import type { LcmContextEngine } from "../src/engine.js";
import { estimateSerializedMessagesTokens } from "../src/estimate-tokens.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import { createTestConfig, createTestDeps, TestLcmContextEngine } from "./helpers.js";

const tempDirs: string[] = [];
const dbs: ReturnType<typeof createLcmDatabaseConnection>[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) {
    try {
      closeLcmConnection(db);
    } catch {
      // best-effort cleanup
    }
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createEngine(): LcmContextEngine {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-stable-budget-"));
  tempDirs.push(tempDir);
  const config = createTestConfig(join(tempDir, "lcm.db"), { freshTailCount: 4 });
  const db = createLcmDatabaseConnection(config.databasePath);
  dbs.push(db);
  return new TestLcmContextEngine(createTestDeps(config), db);
}

function message(index: number, chars: number): AgentMessage {
  return {
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message ${index}: ${"word ".repeat(Math.ceil(chars / 5))}`,
    timestamp: 1_781_035_270_000 + index,
  } as unknown as AgentMessage;
}

function signature(messages: AgentMessage[]): string {
  return messages.map((m) => String((m as { content?: unknown }).content).slice(0, 14)).join("|");
}

async function seed(engine: LcmContextEngine, sessionId: string, sessionKey: string): Promise<void> {
  // A couple of persisted messages so the conversation exists while stored
  // coverage trails the live transcript (the live-fallback path).
  await engine.ingest({ sessionId, sessionKey, message: message(0, 40) });
  await engine.ingest({ sessionId, sessionKey, message: message(1, 40) });
}

describe("assemble cache stability under a shrinking budget", () => {
  it("does not move the output boundary on every small budget drop", async () => {
    const engine = createEngine();
    const sessionId = "stable-budget-session";
    const sessionKey = "agent:main:telegram:group:test:topic:1";
    await seed(engine, sessionId, sessionKey);
    const live = Array.from({ length: 60 }, (_, i) => message(i, 800));
    const total = estimateSerializedMessagesTokens(live);
    const budgets = [0.5, 0.47, 0.44, 0.41, 0.38, 0.35, 0.32, 0.29].map((r) => Math.floor(total * r));

    const signatures: string[] = [];
    for (const tokenBudget of budgets) {
      const result = await engine.assemble({ sessionId, sessionKey, messages: live, tokenBudget });
      expect(estimateSerializedMessagesTokens(result.messages)).toBeLessThanOrEqual(tokenBudget);
      signatures.push(signature(result.messages));
    }

    let changes = 0;
    for (let i = 1; i < signatures.length; i += 1) {
      if (signatures[i] !== signatures[i - 1]) changes += 1;
    }
    // Assembling to every exact budget moves the boundary on (nearly) every drop.
    expect(changes).toBeLessThanOrEqual(3);
  });

  it("returns to the full budget when the host budget grows again", async () => {
    const engine = createEngine();
    const sessionId = "stable-budget-reset";
    const sessionKey = "agent:main:telegram:group:test:topic:2";
    await seed(engine, sessionId, sessionKey);
    const live = Array.from({ length: 60 }, (_, i) => message(i, 800));
    const total = estimateSerializedMessagesTokens(live);

    const small = await engine.assemble({ sessionId, sessionKey, messages: live, tokenBudget: Math.floor(total * 0.4) });
    const smaller = await engine.assemble({ sessionId, sessionKey, messages: live, tokenBudget: Math.floor(total * 0.36) });
    const full = await engine.assemble({ sessionId, sessionKey, messages: live, tokenBudget: Math.floor(total * 0.5) });
    expect(smaller.messages.length).toBeLessThanOrEqual(small.messages.length);
    expect(full.messages.length).toBeGreaterThan(smaller.messages.length);
  });
});
