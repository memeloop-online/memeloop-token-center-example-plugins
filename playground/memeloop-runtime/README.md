# MemeLoop browser loop integration

`default.mjs` is vendored **unchanged** from the official MemeLoop repository:

https://github.com/memeloop-online/memeloop/blob/7e9aec265a8870ec45cd186112d65108fb6b606d/packages/memeloop/src/loops/agent-tool-loop/default.mjs

Pinned commit: `7e9aec265a8870ec45cd186112d65108fb6b606d`.
Package: `memeloop`, version `0.0.0`; its package.json declares MIT licensing.
The upstream repository does not currently contain a root LICENSE file.

This is the actual official agent/tool orchestration script, not a package import
with an invented browser API. It calls the documented `createState`, `startTurn`,
`runIteration`, and `stopTurn` primitives. `../agent-loop.mjs` supplies those
primitives as an ephemeral browser adapter and implements native OpenAI tool
messages through Token Center's authenticated host bridge. MemeLoop owns loop
orchestration and lifecycle; the adapter owns inference and tools.

The complete MemeLoop package includes Node transport/storage/plugin dependencies
and has no published browser-specific export. Importing its root entry would pull
unrelated runtime dependencies into the plugin. The official script extension
boundary avoids that dependency graph and needs no CDN, install, or runtime code
download. Any upstream update must deliberately update this source and pin.

The adapter keeps all conversation state in memory, limits model iterations and
tool calls, cancels pending waits, requires explicit confirmation before changes,
and denies credential/secret and export routes. Discovery supports path/summary search, pagination, exact operation details, and referenced component schemas. Only methods and paths present in the discovered OpenAPI document may execute. The AbortSignal is passed into every host transport call; displayed tool results are redacted and bounded. Already dispatched bridge requests
cannot be rolled back by browser cancellation. Host-side operator permissions and
tenant isolation apply to every request. Local tests/builds were not run, per the
shared workspace AGENTS.md; CI must verify the shipped plugin.

Provider `reasoning_content` strings are preserved only in private per-run assistant
protocol messages for native Kimi tool continuation. They are never included in UI
events or returned display messages. `enableTools: false` omits tool definitions
for text-only models and prevents execution of unsolicited tool calls.

`protocol: 'anthropic'` uses `/internal/v1/inference/messages` with the selected
`key_id`, separate system prompt, `max_tokens: 2048`, and native Messages tool
schemas. Assistant content blocks (including opaque thinking/signature blocks)
are replayed only in private protocol history. Tool outputs are grouped into a
native user `tool_result` turn. Only text blocks reach display events/messages.
The default `protocol: 'openai'` retains Chat Completions behavior. Both protocols
use the same host authorization, tenant scope, cancellation, and tool policies.
