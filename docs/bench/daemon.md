# Daemon bench

The full daemon (`packages/app/src/main.ts`) as a child process against a fake Telegram Bot API and a fake
DeepSeek Messages API on 127.0.0.1. The model never leaves the machine and no real key is used.

- Cold start to first getUpdates: 875 ms
- RSS idle: 222.8 MB
- RSS after 20 turns: 245.8 MB
- Turn overhead inbound: median 8.3 ms, p95 19.1 ms
- Turn overhead outbound: median 3.6 ms, p95 8.2 ms
- Prefix: 43334 bytes, ~10834 tokens (bytes/4 heuristic, no tokenizer)
- Background model calls after the last turn: 1
- Model calls in 10 idle schedule ticks: 0

Measured by `npm run bench:daemon:write` on Node v26.8.1 at commit 6236810abcb43665b30525d11ac15b5d6ea2fede.
