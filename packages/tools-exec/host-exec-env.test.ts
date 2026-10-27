// The environment of a host_exec child. The command of a local alias and the ssh client are started by
// the daemon, which holds the model key and the bot token in its own environment; a command such as
// `echo $DEEPSEEK_API_KEY | base64` would carry the key past the output scrubber. The child therefore gets
// the same cleaned environment as the exec sandbox (an allowlist: PATH, HOME, LANG and the like stay),
// and a host that starts with a dash is refused when hosts.json is read, so it cannot become an ssh option.
//
// The tests drive createHostExecTools directly. The ssh client is a fake `ssh` script first on PATH that
// prints its environment, so nothing leaves the machine. `secrets: []` switches the output scrubber off,
// so only the environment of the child decides what is visible.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import { createHostExecTools, readHosts } from "./src/host.js";

const DEEPSEEK_VALUE = "sk-test-deepseek-7f3a9c1e5b2d4f6a8c0e";
const TELEGRAM_VALUE = "7100200300:AAH-test-telegram-token-Zq81xKd";
const OTHER_SECRET_VALUE = "ghp_test_other_secret_value_4d9e1b7a";
const AUTH_SOCK_VALUE = "/tmp/test-ssh-agent-sock-4821/agent.1";

const TOUCHED = [
  "DEEPSEEK_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "GITHUB_TOKEN",
  "SSH_AUTH_SOCK",
  "PATH",
] as const;

let scratch = "";
let fakeBin = "";
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "dshbot-host-env-"));
  fakeBin = join(scratch, "bin");
  mkdirSync(fakeBin);
  const ssh = join(fakeBin, "ssh");
  // Marks every start, then prints the environment the client was started with.
  writeFileSync(
    ssh,
    `#!/bin/sh\necho started >> "${join(scratch, "ssh-started")}"\n/usr/bin/env\n`,
  );
  chmodSync(ssh, 0o755);

  saved = {};
  for (const name of TOUCHED) saved[name] = process.env[name];
  process.env.DEEPSEEK_API_KEY = DEEPSEEK_VALUE;
  process.env.TELEGRAM_BOT_TOKEN = TELEGRAM_VALUE;
  process.env.GITHUB_TOKEN = OTHER_SECRET_VALUE;
  process.env.SSH_AUTH_SOCK = AUTH_SOCK_VALUE;
  process.env.PATH = [
    fakeBin,
    saved.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  ].join(delimiter);
});

afterEach(() => {
  for (const name of TOUCHED) {
    const value = saved[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

function writeHosts(hosts: Record<string, unknown>): void {
  writeFileSync(join(scratch, "hosts.json"), JSON.stringify(hosts));
}

async function run(host: string, command: string): Promise<string> {
  const { tools } = createHostExecTools({
    home: scratch,
    secrets: [],
    timeoutMs: 20_000,
  });
  const tool = tools[0];
  if (tool === undefined) throw new Error("host_exec is not created");
  return String(
    await tool.execute(
      { host, command },
      { signal: new AbortController().signal },
    ),
  );
}

/** Every encoding of a value a command could print to slip it past a plain-text scrubber. */
function encodings(value: string): string[] {
  const bytes = Buffer.from(value, "utf8");
  return [
    value,
    bytes.toString("base64"),
    bytes.toString("hex"),
    encodeURIComponent(value),
    [...value].reverse().join(""),
  ];
}

function expectNoSecrets(output: string): void {
  for (const value of [DEEPSEEK_VALUE, TELEGRAM_VALUE, OTHER_SECRET_VALUE]) {
    for (const form of encodings(value)) expect(output).not.toContain(form);
  }
  // The values of the key and of the token are the point; the first halves are checked too, in case the
  // implementation shortens them.
  expect(output).not.toContain(DEEPSEEK_VALUE.slice(0, 16));
  expect(output).not.toContain(TELEGRAM_VALUE.slice(0, 16));
}

test("test_h1_local_alias_environment_has_no_model_key_bot_token_or_other_secrets_in_any_form", async () => {
  writeHosts({ box: { local: true } });

  const listing = await run("box", "env");
  expectNoSecrets(listing);
  expect(listing).not.toContain("DEEPSEEK_API_KEY=");
  expect(listing).not.toContain("TELEGRAM_BOT_TOKEN=");
  expect(listing).not.toContain("GITHUB_TOKEN=");

  // The exfiltration forms of the finding: the value is encoded or read by name before it is printed.
  const encoded = await run(
    "box",
    'printf %s "$DEEPSEEK_API_KEY" | base64; echo; printf %s "$TELEGRAM_BOT_TOKEN" | base64',
  );
  expectNoSecrets(encoded);
  const length = await run(
    "box",
    'printf "[%s][%s]" "${DEEPSEEK_API_KEY-unset}" "${TELEGRAM_BOT_TOKEN-unset}"',
  );
  expect(length).toContain("[unset][unset]");
});

test("test_h1_local_alias_keeps_the_ordinary_environment_of_a_command", async () => {
  writeHosts({ box: { local: true } });

  const output = await run(
    "box",
    'printf "home=%s\\npath=%s\\nsock=%s\\n" "$HOME" "$PATH" "$SSH_AUTH_SOCK"; command -v ssh',
  );

  expect(output).toContain(`home=${saved.HOME ?? process.env.HOME}`);
  expect(output).toMatch(/^path=.+$/m);
  expect(output).toContain(`sock=${AUTH_SOCK_VALUE}`);
  expect(output).toContain(join(fakeBin, "ssh"));
});

test("test_h1_ssh_client_environment_has_no_model_key_bot_token_or_other_secrets_in_any_form", async () => {
  writeHosts({ prod: { user: "deploy", host: "192.0.2.10", port: 2222 } });

  const output = await run("prod", "uptime");

  expect(existsSync(join(scratch, "ssh-started"))).toBe(true);
  expectNoSecrets(output);
  expect(output).not.toContain("DEEPSEEK_API_KEY=");
  expect(output).not.toContain("TELEGRAM_BOT_TOKEN=");
  expect(output).not.toContain("GITHUB_TOKEN=");
  // The key agent of the owner and the home with the keys are what ssh needs.
  expect(output).toContain(`SSH_AUTH_SOCK=${AUTH_SOCK_VALUE}`);
  expect(output).toMatch(/^HOME=.+$/m);
  expect(output).toMatch(/^PATH=.+$/m);
});

test("test_h1_host_starting_with_a_dash_is_rejected_when_hosts_json_is_loaded", async () => {
  for (const host of [
    "-oProxyCommand=touch /tmp/dshbot-owned",
    "-J",
    "-p",
    " -oProxyCommand=id",
  ]) {
    writeHosts({ prod: { user: "deploy", host, port: 22 } });
    expect(() => readHosts(scratch), host).toThrow();
  }

  // One bad entry spoils the load, even next to a good one; a good file still loads.
  writeHosts({
    good: { user: "deploy", host: "192.0.2.10" },
    bad: { user: "deploy", host: "-oProxyCommand=id" },
  });
  expect(() => readHosts(scratch)).toThrow();
  writeHosts({
    good: { user: "deploy", host: "srv-1.example.test", port: 2222 },
    box: { local: true },
  });
  expect([...readHosts(scratch).keys()].sort()).toEqual(["box", "good"]);
});

test("test_h1_host_starting_with_a_dash_never_starts_ssh", async () => {
  writeHosts({
    evil: {
      user: "deploy",
      host: "-oProxyCommand=touch /tmp/dshbot-owned",
      port: 22,
    },
  });

  await expect(run("evil", "uptime")).rejects.toThrow();

  expect(existsSync(join(scratch, "ssh-started"))).toBe(false);
});
