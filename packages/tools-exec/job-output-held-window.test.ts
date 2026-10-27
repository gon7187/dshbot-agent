// The held window of a pump outlives every poll. A short poll that completes no occurrence (one byte "E" of
// a value whose beginning already waits) must keep the held bytes and what is known about their coverage;
// otherwise the rest of an overlapping value goes out open once the other stream wrote in between. The tests
// drive real collectors, two pumps and one ring, as a background job does.

import { OutputCollector } from "@deepseek-ai/dsh-subprocess-local/output";
import { expect, test } from "vitest";

import { JobOutput, OutputPump } from "./src/index.js";

const KEY = "ABCDEFGHABCD";
const REPLACEMENT = "ZYXWVUTSRQPO";
const CAP = 4 * 1024 * 1024;

type StreamName = "stdout" | "stderr";
type Entry = { name: string; value: string };

function harness(captured: readonly Entry[]) {
  const collectors = {
    stdout: new OutputCollector(CAP, "stdout", undefined),
    stderr: new OutputCollector(CAP, "stderr", undefined),
  };
  const output = new JobOutput(CAP, () => captured);
  const pumps = [
    new OutputPump(collectors.stdout, output),
    new OutputPump(collectors.stderr, output),
  ];
  return {
    output,
    write(stream: StreamName, data: string): void {
      collectors[stream].push(Buffer.from(data, "utf8"));
      for (const pump of pumps) pump.poll();
    },
    finish(): void {
      for (const pump of pumps) pump.finish();
    },
  };
}

const other = (stream: StreamName): StreamName =>
  stream === "stdout" ? "stderr" : "stdout";

function visiblePiece(text: string, value: string): string | undefined {
  for (let size = value.length; size >= 4; size -= 1) {
    for (let at = 0; at + size <= value.length; at += 1) {
      const piece = value.slice(at, at + size);
      if (text.includes(piece)) return piece;
    }
  }
  return undefined;
}

function readAll(output: JobOutput, limit: number): string {
  let offset = output.earliest;
  let text = "";
  while (offset < output.total) {
    const page = output.read(offset, limit);
    expect(page.next).toBeGreaterThan(offset);
    text += page.text;
    offset = page.next;
  }
  return text;
}

function surfaces(output: JobOutput): string[] {
  const texts = [output.tail(12_000), output.tail(30), output.tail(7)];
  const offsets = [0, 4, 8, 12, 16, 20, 24, 1_048_572, output.total - 13, output.total - 4];
  for (const offset of offsets)
    for (const limit of [1, 4, 9, 40, 400])
      texts.push(output.read(Math.max(0, offset), limit).text);
  for (const limit of [1, 3, 7, 200_000]) texts.push(readAll(output, limit));
  return texts;
}

function expectNoPiece(output: JobOutput, values: readonly string[], step: string): void {
  for (const text of surfaces(output))
    for (const value of values)
      expect(visiblePiece(text, value), `${step}:\n${text.slice(-200)}`).toBeUndefined();
}

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

const SCENARIOS: Record<string, string> = {
  short: KEY,
  overflow: `${"ABCDEFGH".repeat(131_072)}ABCD`,
};

test("test_c10_a_one_byte_poll_keeps_the_held_window_of_an_overlapping_value", () => {
  for (const [scenario, head] of Object.entries(SCENARIOS)) {
    for (const [label, { captured, values }] of Object.entries(VARIANTS)) {
      for (const holder of ["stdout", "stderr"] as const) {
        const step = `${scenario}, ${label}, ${holder}`;
        const run = harness(captured);
        run.write(holder, head);
        run.write(holder, "E");
        expectNoPiece(run.output, values, `${step}, after E`);
        run.write(other(holder), "progress\n");
        expectNoPiece(run.output, values, `${step}, the other stream wrote`);
        run.write(holder, "FGHABCD\n");
        expectNoPiece(run.output, values, `${step}, the rest arrived`);
        if (label === "replaced") {
          run.write(holder, REPLACEMENT.slice(0, 4));
          run.write(holder, REPLACEMENT.slice(4, 5));
          run.write(other(holder), "second\n");
          run.write(holder, `${REPLACEMENT.slice(5)}\n`);
        }
        run.write(holder, "done\n");
        run.finish();
        expectNoPiece(run.output, values, `${step}, the job finished`);
        const everything = readAll(run.output, 200_000);
        expect(everything, step).toContain("progress\n");
        expect(everything, step).toContain("done\n");
        expect(everything, step).toContain("*");
        if (label === "replaced") expect(everything, step).toContain("second\n");
      }
    }
  }
}, 240_000);

test("test_c10_byte_by_byte_polls_with_the_other_stream_in_between_leave_no_piece", () => {
  for (const [label, { captured, values }] of Object.entries(VARIANTS)) {
    for (const holder of ["stdout", "stderr"] as const) {
      const step = `${label}, ${holder}`;
      const run = harness(captured);
      const text = `x ${KEY}EFGHABCD ${values.at(-1)} y\n`;
      for (const char of text) {
        run.write(holder, char);
        run.write(other(holder), ".");
        expectNoPiece(run.output, values, `${step}, after ${JSON.stringify(char)}`);
      }
      run.finish();
      expectNoPiece(run.output, values, `${step}, the job finished`);
      const everything = readAll(run.output, 200_000);
      expect(everything.replace(/\./g, ""), step).toMatch(/^x \*+ \*+ y\n$/);
    }
  }
});
