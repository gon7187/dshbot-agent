// The wake-up sees the state of its own memory, not only the events since the previous wake-up: after the summary of
// events the prompt carries the block «Самочувствие:» (lines about deviations only: a stale or thin identity.md, an
// empty or nearly full scratchpad, the wake-up spending of the last 24 hours), and the prompt holds a short stable
// list of signs of drift that the bot checks itself against.
//
// Same harness as wake-summary-daemon.test.ts / wake-clock.test.ts (test-support/wake-harness.ts): the daemon runs
// as a child process against a fake model and a fake Telegram, on a fake clock. The first wake-up jumps the clock
// by about 250 minutes, so an identity.md that is N hours old on the real clock is N + ~4 hours old for the daemon.
// The wording of the lines is read by meaning where the criteria leave room; the quoted phrases are the ones the
// criteria name.

import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { expect, test } from "vitest";

import { createWakeUsageStore } from "../consciousness/src/index.js";
import { openStore } from "../store/src/index.js";
import {
  TEST_TIMEOUT_MS,
  expectWakeWithin,
  flatten,
  hasToolResult,
  messagesOf,
  modelRequests,
  startOwnerDaemon,
  stopDaemon,
  untilAttempt,
  wakeFinished,
  world,
} from "./test-support/wake-harness.js";
import type { Daemon, DsEvent } from "./test-support/wake-harness.js";

const HOUR_MS = 3_600_000;
const WELLBEING_RE = /^Самочувствие:/m;
const SUMMARY_HEADER = "Что изменилось с прошлого пробуждения:";
const NOTHING_HAPPENED = "С прошлого пробуждения ничего не произошло.";
// The occasions and the mood are allowed to change from one wake-up to the
// next (silence grows, a card is rejected, the bot rewrites its mood).
const OCCASIONS_HEADER = "Поводы с прошлого пробуждения:";
const MOOD_RE = /^Настроение:/m;
const SCRATCHPAD_LIMIT = 3_000;

/** ASCII on purpose: characters, UTF-16 units and bytes all give the same length. */
function ascii(length: number): string {
  return "abcdefghij".repeat(Math.ceil(length / 10)).slice(0, length);
}

const LONG_IDENTITY = `Я бот-помощник владельца. ${ascii(300)}`;
const THIN_IDENTITY = ascii(80);

function dbPath(): string {
  return join(world.dshbotHome, "state.db");
}

function seedIdentity(text: string, ageHours: number): void {
  mkdirSync(join(world.dshbotHome, "memory"), { recursive: true });
  const file = join(world.dshbotHome, "memory", "identity.md");
  writeFileSync(file, text);
  const seconds = (Date.now() - ageHours * HOUR_MS) / 1000;
  utimesSync(file, seconds, seconds);
}

function seedScratchpad(text: string): void {
  writeFileSync(join(world.dshbotHome, "scratchpad.md"), text);
}

interface WakeRow {
  agoHours: number;
  inputTokens: number;
  outputTokens: number;
}

/** Rows of the wake-up ledger, one row (one model call) per wake-up, stamped on the real clock. */
function seedWakeLedger(rows: WakeRow[]): void {
  const store = openStore(dbPath());
  try {
    const ledger = createWakeUsageStore(store);
    for (const row of rows) {
      ledger.record(
        [
          {
            inputTokens: row.inputTokens,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: row.outputTokens,
          },
        ],
        { at: Date.now() - row.agoHours * HOUR_MS },
      );
    }
  } finally {
    store.close();
  }
}

function insertRun(jobId: string, output: string): void {
  const db = new DatabaseSync(dbPath());
  try {
    db.prepare(
      "INSERT INTO schedule_runs (job_id, started_at, duration_ms, status, output) VALUES (?, ?, ?, ?, ?)",
    ).run(jobId, Date.now(), 120, "error", output);
  } finally {
    db.close();
  }
}

/** The text of the wake-up prompt of the attempt number `n` (0-based): the last user message of its first request. */
function wakePromptOf(n: number): string {
  const first = modelRequests("wake").filter(
    (event: DsEvent) => event.step === 0,
  )[n];
  expect(first, `wake-up number ${n + 1} reached the model`).toBeDefined();
  const users = messagesOf((first as DsEvent).body).filter(
    (m) => m.role === "user" && !hasToolResult(m),
  );
  return flatten(users[users.length - 1]?.content);
}

/** Starts the daemon, lets the first wake-up happen and returns its prompt. */
async function firstWake(): Promise<{ d: Daemon; prompt: string }> {
  const d = await startOwnerDaemon({
    env: { DSHBOT_WAKE_JITTER: "0", DSHBOT_FREE_WAKE_CHANCE: "0" },
  });
  await untilAttempt(d, 0);
  await wakeFinished(d, 1);
  return { d, prompt: wakePromptOf(0) };
}

/** Everything from the line «Самочувствие:» on. */
function wellbeingTail(prompt: string): string {
  const at = prompt.search(WELLBEING_RE);
  expect(
    at,
    `the wake-up prompt has the block «Самочувствие:»\n${prompt}`,
  ).toBeGreaterThanOrEqual(0);
  return prompt.slice(at);
}

/** The block itself: up to the first blank line or the memory snapshot. */
function wellbeingBlock(prompt: string): string {
  const rest = wellbeingTail(prompt);
  const ends = [rest.indexOf("\n\n"), rest.indexOf("<context>")].filter(
    (at) => at >= 0,
  );
  return (
    ends.length === 0 ? rest : rest.slice(0, Math.min(...ends))
  ).trimEnd();
}

function lineWith(text: string, phrase: string | RegExp): string | undefined {
  return text
    .split("\n")
    .find((line) =>
      typeof phrase === "string" ? line.includes(phrase) : phrase.test(line),
    );
}

const DEVIATION_WORDS = [
  "не обновлялся",
  "тонкий",
  "блокнот пуст",
  "блокнот почти полон",
  "пробуждений за 24",
];

// --- [c1] a stale identity.md -------------------------------------------------------------------------------

test(
  "test_c1_identity_not_changed_for_100_hours_is_named_in_the_wellbeing_block",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    seedIdentity(LONG_IDENTITY, 100);
    seedScratchpad(ascii(120));
    const { prompt } = await firstWake();
    const tail = wellbeingTail(prompt);
    const hit = /identity не обновлялся (\d+) ч/.exec(tail);
    expect(hit, `the block names the age of identity\n${tail}`).not.toBeNull();
    const hours = Number((hit as RegExpExecArray)[1]);
    expect(
      hours,
      "the age is counted in hours of the daemon clock",
    ).toBeGreaterThanOrEqual(100);
    expect(hours).toBeLessThanOrEqual(106);
    expect(tail, "a long identity is not thin").not.toContain("тонкий");
  },
);

test(
  "test_c1_identity_changed_10_hours_ago_has_no_stale_line",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    seedIdentity(LONG_IDENTITY, 10);
    seedScratchpad(ascii(120));
    const { prompt } = await firstWake();
    expect(prompt, "the block is there").toMatch(WELLBEING_RE);
    expect(prompt, "a fresh identity is not reported as stale").not.toContain(
      "identity не обновлялся",
    );
  },
);

// --- [c2] a thin identity.md --------------------------------------------------------------------------------

test(
  "test_c2_identity_shorter_than_200_characters_is_thin",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    seedIdentity(THIN_IDENTITY, 1);
    seedScratchpad(ascii(120));
    const { prompt } = await firstWake();
    const tail = wellbeingTail(prompt);
    const line = lineWith(tail, "тонкий");
    expect(line, `a line says the identity is thin\n${tail}`).toBeDefined();
    expect(line, "the line carries the number of characters").toMatch(/\b80\b/);
    expect(tail, "a fresh identity is not stale").not.toContain(
      "identity не обновлялся",
    );
  },
);

// --- [c3] the scratchpad ------------------------------------------------------------------------------------

test(
  "test_c3_a_missing_scratchpad_is_empty",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    seedIdentity(LONG_IDENTITY, 1);
    const { prompt } = await firstWake();
    expect(
      wellbeingTail(prompt),
      "a missing scratchpad.md is reported as empty",
    ).toContain("блокнот пуст");
    expect(prompt).not.toContain("блокнот почти полон");
  },
);

test(
  "test_c3_a_scratchpad_shorter_than_50_characters_is_empty",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    seedIdentity(LONG_IDENTITY, 1);
    seedScratchpad(ascii(20));
    const { prompt } = await firstWake();
    expect(
      wellbeingTail(prompt),
      "a 20 character scratchpad is reported as empty",
    ).toContain("блокнот пуст");
  },
);

test(
  "test_c3_a_scratchpad_over_80_percent_of_the_limit_is_nearly_full",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    seedIdentity(LONG_IDENTITY, 1);
    seedScratchpad(ascii(2_600));
    const { prompt } = await firstWake();
    const tail = wellbeingTail(prompt);
    const line = lineWith(tail, "блокнот почти полон");
    expect(
      line,
      `a line says the scratchpad is nearly full\n${tail}`,
    ).toBeDefined();
    expect(line, "the line carries the current length").toContain("2600");
    expect(line, "the line carries the limit").toContain(
      String(SCRATCHPAD_LIMIT),
    );
    expect(line, "the line sends stable facts to knowledge").toContain(
      "knowledge",
    );
    expect(line, "the line sends results to journal").toContain("journal");
    expect(prompt, "a full scratchpad is not an empty one").not.toContain(
      "блокнот пуст",
    );
  },
);

// --- [c4] the wake-up spending of 24 hours ------------------------------------------------------------------

test(
  "test_c4_wake_ups_of_the_last_24_hours_are_counted_with_their_tokens",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    seedIdentity(LONG_IDENTITY, 1);
    seedScratchpad(ascii(120));
    seedWakeLedger([
      { agoHours: 5, inputTokens: 1_000, outputTokens: 234 },
      { agoHours: 3, inputTokens: 2_000, outputTokens: 566 },
      // older than 24 hours even after the jump of the daemon clock: not counted
      { agoHours: 30, inputTokens: 4_000, outputTokens: 1_000 },
    ]);
    const { prompt } = await firstWake();
    const tail = wellbeingTail(prompt);
    const line = lineWith(tail, "пробуждений за 24 ч");
    expect(
      line,
      `a line accounts for the wake-ups of the day\n${tail}`,
    ).toBeDefined();
    const count = /пробуждений за 24 ч:\s*(\d+)/.exec(line as string);
    expect(
      count?.[1],
      "two wake-ups fall into the window, the old one does not",
    ).toBe("2");
    const tokens = /токенов:\s*(\d[\d\s.,]*)/.exec(line as string);
    expect(tokens, "the line carries the tokens").not.toBeNull();
    expect(
      (tokens as RegExpExecArray)[1]?.replace(/\D/g, ""),
      "tokens of the two wake-ups in the window",
    ).toBe("3800");
  },
);

// --- [c5] nothing to report ---------------------------------------------------------------------------------

test(
  "test_c5_without_deviations_the_block_is_the_single_line_in_norm",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    seedIdentity(LONG_IDENTITY, 1);
    seedScratchpad(ascii(300));
    const { prompt } = await firstWake();
    const tail = wellbeingTail(prompt);
    expect(
      tail.split("\n")[0]?.trim(),
      "the block is one line «Самочувствие: в норме»",
    ).toBe("Самочувствие: в норме");
    for (const word of DEVIATION_WORDS)
      expect(prompt, `no deviation line «${word}»`).not.toContain(word);
  },
);

// --- [c6] size and place of the block -----------------------------------------------------------------------

test(
  "test_c6_the_block_is_at_most_600_characters_and_follows_the_summary_of_events",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    // every deviation at once: the longest honest block
    seedIdentity(THIN_IDENTITY, 100);
    seedScratchpad(ascii(2_600));
    seedWakeLedger([
      { agoHours: 5, inputTokens: 1_000, outputTokens: 234 },
      { agoHours: 3, inputTokens: 2_000, outputTokens: 566 },
    ]);
    const d = await startOwnerDaemon({
    env: { DSHBOT_WAKE_JITTER: "0", DSHBOT_FREE_WAKE_CHANCE: "0" },
  });
    insertRun("c6-job", "сбой проверки");
    await untilAttempt(d, 0);
    await wakeFinished(d, 1);
    const prompt = wakePromptOf(0);

    const block = wellbeingBlock(prompt);
    expect(
      block.length,
      `the block is at most 600 characters\n${block}`,
    ).toBeLessThanOrEqual(600);
    for (const word of [
      "не обновлялся",
      "тонкий",
      "блокнот почти полон",
      "пробуждений за 24",
    ]) {
      expect(block, `the block names «${word}»`).toContain(word);
    }

    const summaryAt = prompt.indexOf(SUMMARY_HEADER);
    expect(
      summaryAt,
      `the summary of events is in the prompt\n${prompt}`,
    ).toBeGreaterThanOrEqual(0);
    expect(
      prompt.search(WELLBEING_RE),
      "the block stands after the summary of events",
    ).toBeGreaterThan(summaryAt);
  },
);

test(
  "test_c6_the_block_follows_the_summary_of_owner_messages",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    seedIdentity(LONG_IDENTITY, 1);
    seedScratchpad(ascii(120));
    const { prompt } = await firstWake();
    // the two pairing messages of the owner are the events of the summary
    const summaryAt = prompt.indexOf(SUMMARY_HEADER);
    expect(
      summaryAt,
      `the summary of events is in the prompt\n${prompt}`,
    ).toBeGreaterThanOrEqual(0);
    expect(
      prompt.search(WELLBEING_RE),
      "the block stands after the summary",
    ).toBeGreaterThan(summaryAt);
  },
);

// --- [c7] the drift detector --------------------------------------------------------------------------------

const DRIFT_SIGNS: Array<[string, RegExp]> = [
  ["task queue mode", /очеред\S*\s+задач/i],
  ["report mode", /режим\S*\s+отч[её]т/i],
  ["permission mode", /режим\S*\s+разрешени/i],
  ["amnesia", /амнези/i],
  ["identity as a changelog", /журнал\S*\s+изменени/i],
  ["tool atrophy", /атрофи/i],
];

/** The prompt without what is allowed to change from one wake-up to the next. */
function stableText(prompt: string): string {
  let text = prompt.replace(/<context>[\s\S]*?<\/context>/g, "");
  const cut = (from: number): void => {
    if (from < 0) return;
    const end = text.indexOf("\n\n", from);
    text = text.slice(0, from) + (end < 0 ? "" : text.slice(end));
  };
  cut(text.indexOf(SUMMARY_HEADER));
  cut(text.indexOf(NOTHING_HAPPENED));
  cut(text.indexOf(OCCASIONS_HEADER));
  cut(text.search(MOOD_RE));
  cut(text.search(WELLBEING_RE));
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

test(
  "test_c7_the_wake_prompt_lists_drift_signs_and_is_the_same_in_two_wake_ups",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    seedIdentity(LONG_IDENTITY, 1);
    const { d, prompt: first } = await firstWake();
    for (const [name, re] of DRIFT_SIGNS)
      expect(first, `the prompt names the drift sign: ${name}`).toMatch(re);

    await expectWakeWithin(d, 1, 70, "the second wake-up");
    await wakeFinished(d, 2);
    const second = wakePromptOf(1);
    for (const [name, re] of DRIFT_SIGNS)
      expect(second, `the second prompt names the drift sign: ${name}`).toMatch(
        re,
      );

    const stableFirst = stableText(first);
    expect(
      stableFirst.length,
      "something remains after the variable blocks are cut",
    ).toBeGreaterThan(200);
    expect(
      stableText(second),
      "the prompt is the same in two wake-ups in a row apart from the variable blocks",
    ).toBe(stableFirst);
    await stopDaemon(d);
  },
);

// --- [c8] the memory snapshot rides in the first turn of the session only ----------------------------------

test(
  "test_c8_a_wake_up_that_opens_the_session_carries_the_memory_snapshot_once",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const fact = "Окружение: бот живёт на ноутбуке SNAPWAKEFACT";
    mkdirSync(join(world.dshbotHome, "memory"), { recursive: true });
    writeFileSync(join(world.dshbotHome, "memory", "MEMORY.md"), fact);
    seedIdentity(LONG_IDENTITY, 1);

    const { d, prompt: first } = await firstWake();
    expect(
      first,
      "the first wake-up of the session carries the context block",
    ).toContain("<context>");
    expect(
      first,
      "MEMORY.md is in the snapshot of the first wake-up",
    ).toContain("SNAPWAKEFACT");

    await expectWakeWithin(d, 1, 70, "the second wake-up");
    await wakeFinished(d, 2);
    const second = wakePromptOf(1);
    expect(
      second,
      "the second wake-up in a row is a real wake-up prompt",
    ).toMatch(/ПРОБУЖДЕНИЕ/);
    expect(
      second,
      "the snapshot is not repeated in the next wake-up",
    ).not.toContain("SNAPWAKEFACT");
    expect(second, "the context block is not repeated").not.toContain(
      "<context>",
    );
    await stopDaemon(d);
  },
);
