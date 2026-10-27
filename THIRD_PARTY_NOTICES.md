# Third-party notices

DSHBOT borrows prompt wording and behavioural rules from four MIT-licensed
projects and runs on DeepSeek Harness, which is also MIT-licensed. The texts
below are the required copyright notices; the MIT licence that covers the
borrowed material follows them. A separate section lists the transitive
dependencies that are distributed under copyleft licences.

## DeepSeek Harness

Copyright (c) DeepSeek AI

Source: DeepSeek Harness (`@deepseek-ai/dsh-*`, `@deepseek-ai/cordis`). Licence:
MIT. DSHBOT uses the harness as its agent runtime: the agent loop, sessions,
DeepSeek provider, tool seam, sandbox and subagents are loaded from the pinned
`@deepseek-ai/dsh-*` packages.

## OpenClaw

Copyright (c) OpenClaw Foundation

Source: OpenClaw (`openclaw`). Borrowed material: execution discipline,
tool-loop guard texts, external-content framing and the automation procedure
that were adapted for `persona/rules.md` and the runner insertions.

## Nous Research — Hermes Agent

Copyright (c) Nous Research

Source: Hermes Agent (`hermes-agent`). Borrowed material: task-completion
guidance, verify-before-done and the finalize-on-budget message that were
adapted for `persona/rules.md` and `packages/runner`.

## Anton Razzhigaev — Ouroboros

Copyright (c) Anton Razzhigaev

Source: Ouroboros (`ouroboros`). Borrowed material: outcome honesty, honesty
about missing capabilities and the "try before declaring a blocker" rule that
were adapted for `persona/rules.md`.

## ruvnet — ruflo

Copyright (c) 2024-2026 ruvnet

Source: ruvnet/ruflo (`ruvnet/ruflo`). Borrowed material: the anomaly detection
method (median and MAD, modified z-score), budget thresholds and projection,
untrusted-content handling and deep-research methodology that were rewritten in
Russian for the skills `wb-ads-anomalies` and `wb-budget-forecast` in
`examples/skills`, and the built-in skills `untrusted-content` and
`deep-research` in `packages/learn/builtin-skills`.

## MIT License

Copyright (c) DeepSeek AI
Copyright (c) OpenClaw Foundation
Copyright (c) Nous Research
Copyright (c) Anton Razzhigaev
Copyright (c) 2024-2026 ruvnet

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Transitive dependencies under copyleft licences

The packages below are not used directly by DSHBOT. They are pulled in through
the audio and office dependencies in `package-lock.json`; the names and licence
identifiers match the `license` fields of that lock file.

| Package | Licence in `package-lock.json` | Pulled in by |
| --- | --- | --- |
| `@audio/decode-aac` | `GPL-2.0` | `@audio/decode-mp4` |
| `@audio/decode-ac3` | `GPL-2.0-or-later` | `@audio/decode-mp4` |
| `@audio/decode-dts` | `GPL-2.0-or-later` | `@audio/decode-mp4` |
| `@audio/decode-eac3` | `LGPL-2.1-or-later` | `@audio/decode-mp4` |
| `codec-parser` | `LGPL-3.0-or-later` | `ogg-opus-decoder`, `@audio/decode-flac`, `@audio/decode-opus`, `@wasm-audio-decoders/flac` |
| `jszip` | `MIT OR GPL-3.0-or-later`, used under MIT | `docx`, `pptxgenjs`, `read-excel-file`, `write-excel-file` and other office document packages |

`@audio/decode-mp4` itself is MIT and pulls the GPL/LGPL audio decoders listed
above. `codec-parser` is reached through `ogg-opus-decoder` and the FLAC
decoder used by `@audio/decode-mp4` and `@audio/decode-flac`. `jszip` is
dual-licensed and DSHBOT uses it under the MIT option; it is listed here because
the package also offers a GPL-3.0 option that downstream redistribution must be
aware of.

The full licence text of each package is shipped in its own `node_modules`
directory after `npm ci`. If you redistribute a build that bundles these
packages, keep their licence texts and comply with the corresponding copyleft
terms.
