// Streaming mask of a background job's output. Every pump masks its own stream: it keeps back at most the
// longest value of the job minus one byte, sends a byte on only when it is decided whether some occurrence
// covers it, and replaces a run of covered bytes (also a chain of overlapping occurrences of any length, spread
// over many polls) with one mask label. The tests drive real collectors, two pumps and one ring and read every
// surface of the job: pages at many offsets and limits, and the tail (the completion notice is a tail as well).
// A value is the job's own captured one, so a secret deleted or replaced in the vault while the process lives
// is still hidden. The label itself is not fixed here: only what must not be visible, and what must be.

import { OutputCollector } from "@deepseek-ai/dsh-subprocess-local/output";
import { expect, test } from "vitest";

import { JobOutput, OutputPump } from "./src/index.js";

const KEY = "ABCDEFGHABCD";
const REPLACEMENT = "ZYXWVUTSRQPO";
const CAP = 4 * 1024 * 1024;
const MIB = 1024 * 1024;

type StreamName = "stdout" | "stderr";
type Entry = { name: string; value: string };

function harness(captured?: readonly Entry[]) {
  const collectors = {
    stdout: new OutputCollector(CAP, "stdout", undefined),
    stderr: new OutputCollector(CAP, "stderr", undefined),
  };
  const output =
    captured === undefined
      ? new JobOutput(CAP)
      : new JobOutput(CAP, () => captured);
  const pumps = [
    new OutputPump(collectors.stdout, output),
    new OutputPump(collectors.stderr, output),
  ];
  return {
    output,
    push(stream: StreamName, data: string | Buffer): void {
      collectors[stream].push(
        typeof data === "string" ? Buffer.from(data, "utf8") : data,
      );
    },
    poll(): void {
      for (const pump of pumps) pump.poll();
    },
    finish(): void {
      for (const pump of pumps) pump.finish();
    },
  };
}

const other = (stream: StreamName): StreamName =>
  stream === "stdout" ? "stderr" : "stdout";

/** The longest piece of `value`, of at least four characters, that `text` shows, or undefined. */
function visiblePiece(text: string, value: string): string | undefined {
  for (let size = value.length; size >= 4; size -= 1) {
    for (let at = 0; at + size <= value.length; at += 1) {
      const piece = value.slice(at, at + size);
      if (text.includes(piece)) return piece;
    }
  }
  return undefined;
}

/** Every page of the ring from `from`, walked with `limit` characters at a time. */
function readAll(output: JobOutput, from: number, limit: number): string {
  let offset = from;
  let text = "";
  let pages = 0;
  while (offset < output.total) {
    const page = output.read(offset, limit);
    expect(page.next, `the page at ${offset} moves forward`).toBeGreaterThan(
      offset,
    );
    text += page.text;
    offset = page.next;
    pages += 1;
    expect(pages, "the reading ends").toBeLessThan(100_000);
  }
  return text;
}

/** What a reader of the job gets: the tail and pages with many offsets and limits. */
function surfaces(output: JobOutput): string[] {
  const from = output.earliest;
  const texts = [
    output.tail(12_000),
    output.tail(30),
    output.tail(7),
    output.tail(1_000_000),
  ];
  const offsets = [
    0,
    from,
    from + 1,
    from + 8,
    1_048_572,
    1_048_568,
    output.total - 64,
    output.total - 13,
    output.total - 1,
  ];
  for (const offset of offsets) {
    for (const limit of [1, 4, 9, 40, 400])
      texts.push(output.read(Math.max(0, offset), limit).text);
  }
  texts.push(readAll(output, from, 200_000));
  if (output.total - from <= 4096) {
    for (const limit of [1, 3, 7, 400])
      texts.push(readAll(output, from, limit));
  }
  return texts;
}

function expectNoPiece(
  output: JobOutput,
  values: readonly string[],
  step: string,
): void {
  for (const text of surfaces(output)) {
    for (const value of values) {
      expect(
        visiblePiece(text, value),
        `${step}: a piece of the secret is visible in:\n${text.slice(-300)}`,
      ).toBeUndefined();
    }
  }
}

/** The vault when the job starts, and the state it is in later: the job keeps its own copy of the start. */
const VARIANTS: Record<string, { captured: Entry[]; values: string[] }> = {
  current: { captured: [{ name: "KEY", value: KEY }], values: [KEY] },
  deleted: { captured: [{ name: "KEY", value: KEY }], values: [KEY] },
  replaced: {
    captured: [
      { name: "KEY", value: KEY },
      { name: "KEY", value: REPLACEMENT },
    ],
    values: [KEY, REPLACEMENT],
  },
};

test("test_h3_overlapping_chain_cut_by_the_other_stream_leaves_no_piece_for_current_deleted_and_replaced", () => {
  // the counterexample of the review: ABCDEFGH x 131072 and ABCD, the other stream writes, EFGHABCD and a newline
  for (const label of Object.keys(VARIANTS)) {
    for (const holder of ["stdout", "stderr"] as const) {
      const { captured, values } = VARIANTS[label] as {
        captured: Entry[];
        values: string[];
      };
      const step = `${label}, ${holder}`;
      const run = harness(captured);
      run.push(holder, `start-${"ABCDEFGH".repeat(131_072)}ABCD`);
      run.poll();
      expectNoPiece(run.output, values, `${step}, the chain arrived`);
      run.push(other(holder), "progress\n");
      run.poll();
      expectNoPiece(run.output, values, `${step}, the other stream wrote`);
      run.push(holder, "EFGHABCD\n");
      run.poll();
      expectNoPiece(
        run.output,
        values,
        `${step}, the rest of the chain arrived`,
      );
      if (label === "replaced") {
        run.push(holder, REPLACEMENT.slice(0, 5));
        run.poll();
        run.push(other(holder), "second\n");
        run.poll();
        run.push(holder, `${REPLACEMENT.slice(5)}\n`);
        run.poll();
      }
      run.push(holder, "end-of-chain\n");
      run.finish();
      expectNoPiece(run.output, values, `${step}, the job finished`);
      const everything = readAll(run.output, run.output.earliest, 200_000);
      expect(everything, step).toContain("start-");
      expect(everything, step).toContain("progress\n");
      expect(everything, step).toContain("end-of-chain\n");
      if (label === "replaced") expect(everything, step).toContain("second\n");
      expect(
        run.output.tail(12_000),
        `${step}: the output after the chain is not eaten`,
      ).toContain("end-of-chain\n");
    }
  }
}, 240_000);

test("test_h3_chain_longer_than_one_mebibyte_over_many_polls_leaves_no_piece", () => {
  for (const holder of ["stdout", "stderr"] as const) {
    const run = harness([{ name: "KEY", value: KEY }]);
    const block = "ABCDEFGH".repeat(8192);
    const blocks = 32;
    run.push(holder, "start-");
    run.poll();
    for (let index = 0; index < blocks; index += 1) {
      run.push(holder, block);
      run.poll();
      run.push(other(holder), `p${index}\n`);
      run.poll();
      if (index % 8 === 7)
        expectNoPiece(run.output, [KEY], `${holder}, block ${index}`);
    }
    expect(
      blocks * block.length,
      "the chain is longer than one mebibyte",
    ).toBeGreaterThan(MIB);
    run.push(holder, "ABCD");
    run.poll();
    run.push(other(holder), "last-progress\n");
    run.poll();
    expectNoPiece(
      run.output,
      [KEY],
      `${holder}, the chain ends with the beginning of the value`,
    );
    run.push(holder, "EFGHABCD\nend-of-chain\n");
    run.poll();
    run.finish();
    expectNoPiece(run.output, [KEY], `${holder}, the job finished`);
    const everything = readAll(run.output, run.output.earliest, 200_000);
    expect(everything, holder).toContain("start-");
    expect(everything, holder).toContain("end-of-chain\n");
    expect(everything, holder).toContain("last-progress\n");
    for (let index = 0; index < blocks; index += 1)
      expect(everything, `${holder}: line p${index}`).toContain(`p${index}\n`);
  }
}, 240_000);

test("test_h3_a_chain_of_covered_bytes_becomes_one_mask_label", () => {
  for (const holder of ["stdout", "stderr"] as const) {
    const run = harness([{ name: "KEY", value: KEY }]);
    run.push(holder, "a-");
    run.poll();
    for (let index = 0; index < 24; index += 1) {
      run.push(holder, "ABCDEFGH".repeat(8192));
      run.poll();
    }
    run.push(holder, "ABCDEFGHABCD-b\n");
    run.poll();
    run.finish();
    const text = readAll(run.output, run.output.earliest, 200_000);
    expect(
      text.startsWith("a-"),
      `${holder}: the bytes before the chain are as they were`,
    ).toBe(true);
    expect(
      text.endsWith("-b\n"),
      `${holder}: the bytes after the chain are as they were`,
    ).toBe(true);
    const label = text.slice(2, text.length - 3);
    expect(
      label.length,
      `${holder}: the chain of over 1.5 MiB has a mask`,
    ).toBeGreaterThan(0);
    expect(
      label.length,
      `${holder}: the chain is one label, not one filler per byte`,
    ).toBeLessThan(256);
    expect(visiblePiece(text, KEY), holder).toBeUndefined();
    expect(
      run.output.total,
      `${holder}: the ring holds the label, not the chain`,
    ).toBeLessThan(4096);
  }
});

test("test_h3_the_pump_holds_back_no_more_than_the_longest_value_minus_one_byte", () => {
  const longest = KEY.length;
  const run = harness([{ name: "KEY", value: KEY }]);
  // a plain text with the beginning of the value at its end: only that beginning waits
  run.push("stdout", "plain text ABCDEFGHABC");
  run.poll();
  expect(
    run.output.total,
    "at most the length of the value minus one byte is held",
  ).toBeGreaterThanOrEqual("plain text ABCDEFGHABC".length - (longest - 1));
  expect(run.output.tail(12_000)).toContain("plain text");
  // after a chain of any length that ends, only the tail of the new bytes waits
  const chain = harness([{ name: "KEY", value: KEY }]);
  chain.push("stdout", `${"ABCDEFGH".repeat(262_144)}ABCD`);
  chain.poll();
  chain.push("stderr", "progress\n");
  chain.poll();
  chain.push("stdout", `EFGHABCD${"z".repeat(100)}`);
  chain.poll();
  expectNoPiece(chain.output, [KEY], "the chain of 2 MiB ended");
  expect(
    chain.output.tail(12_000),
    "the bytes after the chain are not held back",
  ).toMatch(new RegExp(`z{${100 - (longest - 1)}}$`));
  expect(chain.output.tail(12_000)).toContain("progress\n");
  chain.finish();
  expect(chain.output.tail(12_000).endsWith("z".repeat(100))).toBe(true);
}, 240_000);

test("test_h3_finish_releases_the_rest_with_the_same_check", () => {
  for (const holder of ["stdout", "stderr"] as const) {
    const run = harness([{ name: "KEY", value: KEY }]);
    run.push(holder, `x=${KEY}`);
    run.finish();
    expectNoPiece(
      run.output,
      [KEY],
      `${holder}, the value is the last bytes of the stream`,
    );
    expect(run.output.tail(12_000), holder).toContain("x=");
    const chain = harness([{ name: "KEY", value: KEY }]);
    chain.push(holder, `${"ABCDEFGH".repeat(1000)}ABCDEFGHABCD`);
    chain.finish();
    expectNoPiece(
      chain.output,
      [KEY],
      `${holder}, a chain is the last bytes of the stream`,
    );
  }
});

test("test_h3_output_without_a_secret_passes_byte_for_byte", () => {
  const text = [
    "plain line\n",
    "ABCD alone, EFGH alone, ABCDEFGHABC and then X\n",
    "ZYXWVUTSRQP is not the whole value\n",
    "Привет, мир! 🙂 ключ не здесь\n",
    `${"ABCDEFGH-".repeat(5)}ABC\n`,
    "tail without a secret\n",
  ].join("");
  const bytes = Buffer.from(text, "utf8");
  const sources: Array<{ label: string; captured?: Entry[] }> = [
    { label: "no secrets at all" },
    {
      label: "a vault with no secret in the output",
      captured: [
        { name: "KEY", value: KEY },
        { name: "OTHER", value: REPLACEMENT },
      ],
    },
  ];
  for (const { label, captured } of sources) {
    for (const stream of ["stdout", "stderr"] as const) {
      for (const size of [1, 5, bytes.length]) {
        const run = harness(captured);
        for (let at = 0; at < bytes.length; at += size) {
          run.push(stream, bytes.subarray(at, at + size));
          run.poll();
        }
        run.finish();
        const step = `${label}, ${stream}, pieces of ${size}`;
        expect(run.output.total, step).toBe(bytes.length);
        expect(readAll(run.output, 0, 7), step).toBe(text);
        expect(readAll(run.output, 0, 200_000), step).toBe(text);
        expect(run.output.tail(1_000_000), step).toBe(text);
        expect(run.output.read(0, 1_000_000).text, step).toBe(text);
      }
    }
  }
});

test("test_h3_pump_without_secrets_sends_bytes_at_once", () => {
  const run = harness();
  run.push("stdout", "one\n");
  run.poll();
  expect(run.output.total).toBe(4);
  run.push("stderr", "two\n");
  run.poll();
  expect(run.output.total).toBe(8);
  expect(run.output.tail(100)).toBe("one\ntwo\n");
});

test("test_h3_text_between_occurrences_stays_as_it_was", () => {
  for (const holder of ["stdout", "stderr"] as const) {
    const run = harness([{ name: "KEY", value: KEY }]);
    run.push(holder, `one ${KEY} two ${KEY}${KEY} three ${KEY}\n`);
    run.poll();
    run.finish();
    const text = readAll(run.output, run.output.earliest, 200_000);
    expect(visiblePiece(text, KEY), holder).toBeUndefined();
    expect(text, holder).toMatch(/^one .+ two .+ three .+\n$/s);
    expect(text.startsWith("one "), holder).toBe(true);
    expect(text, holder).toContain(" two ");
    expect(text, holder).toContain(" three ");
  }
});
