# Runner bench

Stage-1 prototype: `startRunner` on the minimal DeepSeek Harness plugin set,
measured against a local DeepSeek Messages API stub (SSE, `pong`) on 127.0.0.1.
The model never leaves the machine and no real key is used.

- Cold start to readiness: 141 ms
- First prompt (ping to reply): 31 ms
- RSS after one turn: 126.3 MB
  - heapUsed: 20.7 MB
  - external: 8 MB

The size of the stable prefix of an owner turn (`docs/DESIGN.md` §4 and §9): the full daemon
(`startDshbot`) runs in this process against a fetch stub, one owner message opens a turn, and the
first Messages request is measured. Bytes are UTF-8 bytes of the system prompt and of the JSON of
`tools[]`; the token count is the bytes/4 heuristic, not a tokenizer.

- Prefix: 32993 bytes, ~8248 tokens (bytes/4 heuristic, no tokenizer)
- System: 16397 bytes, ~4099 tokens (bytes/4 heuristic, no tokenizer)
- Tools: 16596 bytes, ~4149 tokens (bytes/4 heuristic, no tokenizer)
- Tools in tools[]: 17 (the rest is reached through tool_search)

For comparison, OpenClaw holds about 580 MB RSS and ~20k tokens of tool schemas.

Measured by `npm run bench:runner` on Node v26.8.1.
