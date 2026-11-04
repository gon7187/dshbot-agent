# Upstream core

Vendored from https://github.com/deepseek-ai/dsh-superagent-prototype at commit
`6337fc823ce20251c8de8085948165c81aaa701e`.

`src/core/*.ts` preserves the upstream pure domain core with two runtime adaptations:
local `.ts` import extensions become `.js` for DSHBOT's NodeNext convention, and
TypeScript constructor parameter properties become explicit property declarations
and constructor assignments for Node's production strip-only TypeScript loader.
The upstream MIT license is preserved in `LICENSE.upstream`.

`src/repository.ts` is DSHBOT's SQLite adapter; it uses the existing shared database
and owns only tables prefixed with `superagent_`.
