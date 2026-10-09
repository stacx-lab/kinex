# Context / cache / hot-loading audit

2026-10-08, installed Pi 1.1.0, Node 22.19.0. Request-prefix checks updated for
Anthropic inline tool definitions; earlier compaction findings are identified below.

## Request-prefix verification

`test/context-audit.test.mjs` captures actual HTTP bodies sent by the SDK to
local OpenAI Chat Completions, OpenAI Responses and Anthropic Messages fixtures.
For each protocol it verifies baseline → device load → skill addition → device
unload → dispose/reopen the same session:

- Tool declarations and system/instructions remain identical.
- Each earlier request's model-visible message/input array remains an exact prefix
  of the next request. Anthropic cache_control placement is excluded from this
  content comparison because the cache boundary intentionally moves forward.
- OpenAI Responses prompt_cache_key exists and stays unchanged on session reopen.
- Updated robotics state and the skill catalog appear as appended messages.

A separate multi-step test edits an existing tool implementation and calls it again
within the same task. The updated code executes and the tool declaration/history
prefix stay stable. Existing application tests also cover retries, image replay,
compaction and stable schemas.

Five additional protocol fixtures exercise Kinex hot loading through the installed
SDK with explicit model compatibility profiles:

- Responses `supportsAdditionalTools`: initial request tools stay fixed; additions
  appear as `additional_tools` in subsequent input.
- Responses `supportsToolSearch`: initial tools stay fixed; Pi synthesizes
  `tool_search_call` / `tool_search_output` entries for additions.
- Completions with `supportsMidConvoSystemMessages` and
  `supportsMidConvoToolAdditions`: tools are added in later messages.
- Anthropic with `supportsMidConvoSystemMessages` and
  `supportsMidConvoToolChanges`: additions and redefinitions use inline
  `tool_definition` blocks in history. Initial tool definitions stay fixed.
- Responses without these capabilities: current tools are sent at request level,
  so adding a schema changes the request's initial tool declarations.

The native addition tests assert stable preceding messages and system content.
Removal makes addition-only transports fall back to current declarations; native
Anthropic removal and redefinition retain the initial declarations and previous
message prefix. Redefining the same tool name with a different description falls
back in the other tested profiles. Separate tests
cover live parameter-schema changes. Model capabilities are never forced on by
Kinex: production uses Pi's model configuration.

These are request construction checks, not real cache-hit measurements. No paid
provider calls were made. Fixture usage counters are synthetic and must not be
reported as a measured cache-hit percentage. Real provider/OAuth compatibility,
routing, cache expiry and minimum-length rules remain unmeasured. Genuine
schema/system/model/thinking changes or compaction can invalidate cache content;
a permanent identical prefix across these changes is not promised. Skill-list
changes alone do not change tool declarations.

## Context and compaction

Pi owns the JSONL session tree and constructs active context. Kinex adds fixed
robotics instructions as a system section. Device/Python/guide/convention/skill/
recording/discovery-error snapshots are persisted hidden custom messages. Only
changed sections are appended in before_agent_start and turn_end.

turn_end runs after the complete tool batch. It refreshes active tool declarations
and queues changed snapshots with `triggerTurn: false`. Tests exposed that Pi
0.86.1 persists these messages to agent state while the running loop retains a
separate array. Kinex wraps the public `prepareNextTurnWithContext` hook to copy
current agent messages into the next-turn context before calling Pi's original
compaction/loadout preparation. This makes the snapshot visible on the next request
and includes it in Pi's compaction estimate, without forking the SDK or adding an
extra response. Aborted turns skip discovery; existing permission checks remain.

Pi 0.86.1 defaults:

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

The automatic threshold is strictly `contextTokens > contextWindow - reserveTokens`.
For a 128000-token model that is >111616; for 200000 it is >183616.
Context estimation uses recent valid provider usage (including cached tokens),
plus estimates for subsequent messages/tool outputs where applicable. It is not
the session's cumulative billed token count. Without usable usage, Pi estimates
from message content.

Checks occur before a new user prompt, after a low-level agent run, and between
tool execution and the next assistant response within a task. Context-overflow or
eligible truncation errors can trigger compact-and-retry recovery; manual
`/compact [instructions]` is also supported. The transcript is kept on disk; the
next model request uses a summary and retained recent messages (~20000 tokens by
default, respecting valid cut points). Compaction changes the conversation prefix
by design and may cause a cache warm-up request.

Kinex settings paths are `$KINEX_CONFIG_DIR/agent/settings.json` and
`.kinex/agent/settings.json`, not the default Pi paths. Old
`kinex.json: compaction.token_limit` is not used. Model-specific overrides are
supported by Pi's settings API.

`session_compact` now reads and immediately persists a full snapshot, synchronizing
it with agent state before Pi's first continuation request. It does not use queued
sendMessage at this boundary. Request capture verifies this for manual compaction,
in-task threshold compaction and overflow recovery, including a device state change
during summarization. Subsequent hooks and session reopen do not duplicate unchanged
snapshots. If recovery fails, the task aborts and ordinary model requests are blocked
until core state can be refreshed successfully.

Robotics summary rules retain IDs, calibration values with units/frames, pending
actions and unverified outcomes, explicitly distinguishing command acceptance from
observed completion. The adapter records the compaction signal and adds rules only
to matching requests through the public agent stream function. Pi still owns the
default/user summary instructions, split-turn summaries, authentication, retries,
usage, cut points and storage. Tests cover user focus, split-turn retry, failure and
cancellation; ordinary requests do not inherit the temporary summary rule. Fake
summaries verify wiring and state continuity, not a real model's summarization quality.

Evidence: installed `pi-coding-agent/dist/core/compaction/compaction.js`,
`core/settings-manager.js`, `core/agent-session.js`; Kinex `context.ts`, `extension.ts`
and `compaction.ts`.

## Tool-batch ordering

All core tools, including hot-loaded tools, and question use Pi's sequential tool
metadata. Any batch containing one is serialized in assistant call order; pure
coding batches keep Pi's parallel mode. The previous denied-device/sibling-side-
effect probe is now a regression test. Coverage includes device, calibration and
Python-controller denial, question cancellation in auto mode, cancellation during
a running core call, completed-call preservation, next-prompt/session-reopen
recovery, and hot-loaded mixed-batch ordering. A rendezvous test verifies that two
pure coding bash calls still execute concurrently.

These are standalone Pi adapter contracts. Core source/API and its device-local
queues are unchanged; an adapter for another harness must supply equivalent host
scheduling and compaction integration.

## Hot loading: execution versus discovery

| Change | Same task, next tool invocation | Next ordinary user prompt |
| --- | --- | --- |
| New TS/JS/Python tool name/schema | Registered after the current batch; available in the next model request | Rescanned and registered |
| Existing tool description/schema edit | Refreshed after the current batch | Refreshed |
| Existing tool implementation-only edit | Fresh code is loaded by core; tested with TS | Also fresh |
| New skill | Catalog announced after the current batch; skill tool reads it when called | Catalog remains available |
| Existing skill body edit | Another skill(name) reads fresh contents; tested | Also fresh |
| Skill description/list changes | Changed catalog appended after the current batch | Snapshot updates if changed |
| Deleted or broken tool | Deactivated after the current batch; discovery errors appended, repair reactivates | Rescanned |

The same-task fixture creates a tool through Pi write, calls it in the next step,
then creates a skill, checks the catalog announcement, edits its body and reloads
it. Batch coverage verifies snapshots follow all tool results; unchanged state
does not emit repeated snapshots. The real CLI test runs with stdin closed and
creates/calls a new tool without another user prompt. Final replies do not trigger
extra model requests. Existing prefix/session-reopen checks remain in place.

There is no file watcher or idle-task wake-up. Changes become discoverable at the
next normal request boundary of an ongoing task or the next user prompt. A tool
created by one call is not promised available to a sibling call in the same batch.
Persistent device drivers are a separate lifecycle: use `/reload <device>` for
edited driver code. Bare `/reload` refreshes agent resources.

Validation: see [PLAN.md](PLAN.md) for the complete integration validation results.
`test/context-audit.test.mjs` contains the request and hot-loading scenarios.

Upstream references:
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching
