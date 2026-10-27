// The output scrubber of host_exec. The bot's own secrets (the Telegram token and the DeepSeek key from the
// environment) are always replaced; a `secrets` function adds the values of saved provider sign-ins on top
// of them and is read for every command. An explicit array still replaces the default list.
//
// The tests drive createHostExecTools with a local alias that prints the values from its own command line.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import { createHostExecTools } from "./src/host.js";

const DEEPSEEK_VALUE = "sk-test-deepseek-7f3a9c1e5b2d4f6a8c0e";
const TELEGRAM_VALUE = "7100200300:AAH-test-telegram-token-Zq81xKd";
const PROVIDER_VALUE = "zai-test-provider-key-5c2e8a1d9b3f";

const TOUCHED = ["DEEPSEEK_API_KEY", "TELEGRAM_BOT_TOKEN"] as const;

let scratch = "";
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "dshbot-host-scrub-"));
  writeFileSync(
    join(scratch, "hosts.json"),
    JSON.stringify({ box: { local: true } }),
  );
  saved = {};
  for (const name of TOUCHED) saved[name] = process.env[name];
  process.env.DEEPSEEK_API_KEY = DEEPSEEK_VALUE;
  process.env.TELEGRAM_BOT_TOKEN = TELEGRAM_VALUE;
});

afterEach(() => {
  for (const name of TOUCHED) {
    const value = saved[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

async function printValues(
  secrets: Parameters<typeof createHostExecTools>[0]["secrets"],
): Promise<string> {
  const { tools } = createHostExecTools({
    home: scratch,
    secrets,
    timeoutMs: 20_000,
  });
  const tool = tools[0];
  if (tool === undefined) throw new Error("host_exec is not created");
  const command = `printf 'tg=%s\\nds=%s\\nprovider=%s\\nmarker=ok\\n' '${TELEGRAM_VALUE}' '${DEEPSEEK_VALUE}' '${PROVIDER_VALUE}'`;
  return String(
    await tool.execute(
      { host: "box", command },
      { signal: new AbortController().signal },
    ),
  );
}

test("test_h2_secrets_function_adds_provider_keys_to_the_telegram_token_and_the_deepseek_key", async () => {
  const output = await printValues(async () => [PROVIDER_VALUE]);

  expect(output).toContain("marker=ok");
  expect(output, "the token of the bot is scrubbed").not.toContain(
    TELEGRAM_VALUE,
  );
  expect(output, "the DeepSeek key is scrubbed").not.toContain(DEEPSEEK_VALUE);
  expect(output, "the provider key is scrubbed").not.toContain(PROVIDER_VALUE);
});

test("test_h2_secrets_function_without_values_still_hides_the_telegram_token_and_the_deepseek_key", async () => {
  const output = await printValues(() => []);

  expect(output).toContain("marker=ok");
  expect(output).not.toContain(TELEGRAM_VALUE);
  expect(output).not.toContain(DEEPSEEK_VALUE);
  // Nothing was given for the provider, so its value is not a secret of the bot.
  expect(output).toContain(PROVIDER_VALUE);
});

test("test_h2_secrets_function_is_read_for_every_command", async () => {
  let current: readonly string[] = [];
  const { tools } = createHostExecTools({
    home: scratch,
    secrets: () => current,
    timeoutMs: 20_000,
  });
  const tool = tools[0];
  if (tool === undefined) throw new Error("host_exec is not created");
  const run = async (): Promise<string> =>
    String(
      await tool.execute(
        { host: "box", command: `printf '%s|%s' '${PROVIDER_VALUE}' '${TELEGRAM_VALUE}'` },
        { signal: new AbortController().signal },
      ),
    );

  const before = await run();
  expect(before).toContain(PROVIDER_VALUE);
  expect(before).not.toContain(TELEGRAM_VALUE);

  current = [PROVIDER_VALUE];
  const after = await run();
  expect(after).not.toContain(PROVIDER_VALUE);
  expect(after).not.toContain(TELEGRAM_VALUE);
});
