# Unified development workbench

This fork uses Persona as the control plane and web workbench. It does not embed four desktop applications,
replace their authentication, or make every runtime support the same operations. The upstream starting point is
`nwverse/persona` commit `683f5a31`; its MIT license and notices are retained.

## Ownership and everyday use

```text
Web / paired Feishu bot
        |
Persona assistant, approvals, task records
        |
        +-- Persona node -- Orca workspaces / existing Claude and Codex sessions
        +-- Persona node -- DSH runtime -- selected model API
        +-- Persona node -- Cursor ACP bridge -- official Cursor CLI
        +-- Persona node -- T3 CLI bridge -- existing T3 server

DSH Super-agent owns its own tickets and worker assignments.
Its source integrations remain the entry point for new supervised work.
```

Use **Assistant** for office work and delegation, and **Agents** for development. A development session's side
panels already provide files, changes/review, terminal and preview, subject to that session's capabilities.
The web text editor adds small-file editing; this is not a full language-server IDE. For navigation, refactoring,
debugging and extension-heavy work, open the same checkout in your existing desktop IDE.

**One task has one dispatcher.** Decide whether Persona or DSH Super-agent owns a request. Do not connect both
Feishu bots to the same incoming messages and let both execute them. Seeing a worker in Persona does not transfer
ownership of its Super-agent ticket. Sending directly to a worker is not equivalent to submitting through its
source's authorization and routing rules.

## What connects where

| Component | Connection | Capability boundary |
| --- | --- | --- |
| Persona | Existing hub, managers, node and web/PWA | Identity, approvals, conversations, memory and task views |
| Orca | Existing node host integration | Workspaces/worktrees and supported sessions; not a replacement editor |
| DSH | Existing Cordis runtime plugin | Sessions, tool activity, approvals, questions and main-assistant support |
| DSH Super-agent | `integrations/superagent/`, optional hub/node extension | Existing ticket metadata and opt-in controls; new requests still enter through its configured Sources |
| Cursor | `integrations/cursor/`, official ACP over stdio | Bridge-owned sessions; official CLI authentication and permissions |
| T3 Code | `integrations/t3/`, official local CLI | Recent text messages; read-only unless execution is explicitly enabled |
| Official Codex | Existing official app-server integration | Model discovery, conversation and approval behavior supported by that server |
| Official Claude Code | Existing Claude launcher / Agent SDK paths | Official authentication remains with the official client |
| Compatible model gateway | Direct API provider or DSH provider | An API endpoint is a model, not a coding runtime |

## Build and run the fork

From the checkout root, start with the read-only environment check:

```sh
node scripts/workbench/doctor.mjs
node scripts/workbench/doctor.mjs --json
```

It checks installation candidates without running discovered commands, reading account configuration, logging in or
starting services. **Installed does not mean authenticated or connected.** `--strict` checks local source-development
prerequisites; a remote-database deployment may intentionally fail that local-only check. A command named `codex`
or `agent` is not proof that it is the official client.

Use Node 22.19 or later and the Go version required by `server/go.mod` or later. Install the pinned web dependencies:

```sh
cd web
npm ci
npm test
npm run build
```

The production hub needs PostgreSQL. Follow [server deployment](../server/server.md),
[configuration](../operations/config.md) and [Docker deployment](../operations/docker.md). Build from **this fork**
to get its changes; an upstream release installer does not include them. A Vite page or mock hub alone is not a
running assistant. Do not point development tests at your production hub.

Connect and confirm the computer that will run agents, then configure one working runtime before adding the others.
Start with the least permission needed and a disposable repository. A worktree is isolation of changes, not an
operating-system sandbox.

### DSH and compatible model gateways

1. Install DSH through its [official instructions](https://github.com/deepseek-ai/deepseek-harness) and configure
   its chosen provider's authentication. Check DSH's own Node requirement separately from Persona's: the published
   `@deepseek-ai/dsh@0.2.2-rc.1` requires Node 24.9 or later. A project-local installation and separate `DSH_HOME`
   avoid changing an existing client or account profile.
2. Configure the model in DSH. Its `openai-completions` provider takes the API root, without the final
   `/chat/completions`. A nonstandard root need not end in `/v1`. Keep the key in a local environment variable or
   DSH's secret mechanism; do not commit it.
3. Install this checkout's `integrations/dsh` bundle through DSH's plugin manager, then run its web profile.
4. Once the runtime is connected, choose its launcher for Persona's main assistant or a development session.
   The selected model and effort remain DSH settings; this bridge does not silently replace them.

The existing plugin uses the sibling `runtime-sdk`; keep the repository layout intact. See the exact install and
assistant behavior in [DSH integration](dsh.md).

For Persona's **direct API** tasks, Model Providers supports Chat Completions, Responses and Messages with different
execution capabilities. The first two are not themselves the main assistant's tool loop. This fork accepts an exact
Chat Completions or Responses request URL, so a gateway with a nonstandard prefix does not gain an unwanted `/v1`:

```text
Conventional base:  https://api.example.com/v1
Exact Chat URL:     https://gateway.example.com/team/chat/completions
Exact Responses:    https://gateway.example.com/team/responses
```

Runtime calls, connection checks and curl import share the endpoint logic. Model discovery tries the sibling
`models` endpoint; a gateway without discovery still needs a manually supplied model ID. Chat gateways returning
JSON despite a streaming request are supported for text completion, with validation for refusal, malformed replies
and empty/tool-only output. This is not evidence that the gateway supports agent tools, image input or reasoning.
Test those capabilities in the chosen runtime before using it on a real project.

The JSON-response fallback belongs to Persona's direct/background Chat API client. It does not change DSH's
streaming parser. A gateway that ignores `stream: true` may still be incompatible with DSH's agent loop; verify
streaming and tool-call responses separately before claiming main-assistant compatibility.

For DeepSeek, use its [official API configuration](https://api-docs.deepseek.com/) and a model available to your
account. Choose DSH for its native agent loop, or the existing compatible launcher path when supported. Do not
hardcode model names copied from an old screenshot.

### DSH Super-agent task supervision

The optional [Task supervisor extension](../../integrations/superagent/README.md) adds a standard drawer page. Build
and package it from this fork, install the archive on your hub, and select the paired computer already running
DSH Super-agent. The extension contacts only that computer's loopback management API through Persona Link; it does
not expose the management port to the browser or install a second supervisor.

Begin with **Allow task controls** off. The page shows executor load and ticket metadata, filters, pagination and
explicit refresh. Enabling controls permits confirmed retry, stop, pause and resume; both the hub and computer
program enforce that setting. Stop is not undo, and pause does not promise cancellation of running work.

There is no upstream management API for creating tickets or sending follow-up messages. Submit work through the
supervisor's authorized Feishu/GitHub Sources. This page is supervision, not an additional chat runtime, and does
not surface accounts, environment variables or full transcripts. After an uncertain control result, inspect the
supervisor before retrying; the connector never blindly replays writes.

### Official Codex and Claude

Use a genuine `codex` executable for [Codex app-server](https://learn.chatgpt.com/docs/app-server), not a script that
only translates Chat Completions. If a local gateway helper shadows the command name, select the official executable
explicitly and keep the gateway helper under a distinct name. Do not copy subscription credentials into a gateway.

Claude Code remains on its [official authentication path](https://code.claude.com/docs/en/authentication).
Separate account/configuration directories when needed; do not overwrite an existing personal setup. The existing
Persona integrations are documented in [Codex](codex.md), [Claude](claude-integration.md) and
[model configuration](../assistant/model-config.md).

### Cursor

Authenticate the official Cursor Agent CLI locally, then run the optional bridge from this checkout as the same
system user as the Persona node. See [the Cursor bridge](../../integrations/cursor/README.md) for its exact command
and session-lifetime limits. It uses [official ACP](https://cursor.com/docs/cli/acp), not extracted browser tokens
or a guessed OpenAI-compatible endpoint. Permissions, questions and plans must be answered; disconnection is not
approval. Cursor IDE remains a separate application.

### T3 Code

Keep the official T3 server running and register the project there first:

```sh
node integrations/t3/index.mjs --project /absolute/path/to/project
```

This is read-only. To deliberately enable start and queued send:

```sh
node integrations/t3/index.mjs --project /absolute/path/to/project --allow-execution
```

Set T3's project permission defaults **before** enabling execution: the local CLI does not provide a per-request
permission ceiling. Approvals, stop and complete tool history stay in T3. The bridge reads a bounded recent-message
window, not a complete transcript. An uncertain send is never blindly replayed; check T3 before retrying, especially
after restarting the bridge. See [T3 bridge](../../integrations/t3/README.md).

### Orca and desktop IDEs

Use the existing [engine configuration](engines.md) to select an installed and running Orca host on the correct
computer. Existing worktree/session identity is preserved. Do not open the same task under another dispatcher merely
to make its row visible.

For a local checkout, the desktop commands are ordinary IDE handoffs:

```sh
cursor /absolute/path/to/project
code /absolute/path/to/project
```

These commands operate on the computer where they run. A path belonging to a remote Persona node is not a local path;
use that IDE's remote-development facility or open it on the node's computer. No synthetic deep link can establish
remote filesystem access for you.

## Feishu and office work

Use the public, built-in **official Feishu/Lark bot**, not the private personal-account Lark extension. Configure the
app credentials in Persona settings, pair the owner, and explicitly choose which conversations may reach it.
The setup may require enterprise administrator approval. Credentials stay in the local encrypted configuration.
The bot supports task/session selection and approval cards; see [bot setup](../extensions/bots.md).

Office operations use the existing assistant, document tools and connected sources. Read-only access, sending a
message, modifying a document and executing shell commands are distinct permissions. Connecting a bot does not grant
permission to read every chat or send arbitrary messages as the user.

## Web text editing

On a compatible hub and node, open a complete UTF-8 text file of at most 1 MiB from an Agent's Files panel and select
**Edit**. Save submits the revision read with the file. A conflict leaves the draft intact; there is no forced
overwrite button. Preview, binary and paged/large files keep their existing behavior.

Drafts stay in memory in this browser session, scoped to the connection, assistant, computer and path. They are not
a backup and do not survive a browser restart. A refresh warns while unsaved drafts exist; leaving the file keeps
the draft, and switching credentials retires it. Save failures keep text for copying or another deliberate attempt.
The server uses the existing write-path restrictions and an atomic replacement, preserving the file mode. This is
optimistic conflict detection, not a distributed lock against every external editor; avoid simultaneous saves to
the same file and inspect the Git diff afterwards.

## Acceptance and remaining setup

### Opt-in cache and tool-call probe

`scripts/workbench/cache_tools.py` is a Python standard-library probe for compatible Chat Completions gateways.
It does not launch an Agent or modify Persona configuration. Without `--run`, it prints help and makes no requests.
Keep a private JSON configuration outside tracked files, owned by the current user with mode `0600`:

```json
{
  "CHAT_COMPLETIONS_URL": "https://gateway.example.com/v1/chat/completions",
  "API_KEY": "<your-private-key>"
}
```

Create a dedicated private output directory with mode `0700`, also outside tracked files, then run:

```sh
python3 scripts/workbench/cache_tools.py --run \
  --config /absolute/private/gateway.json \
  --output-dir /absolute/private/probe-results \
  --model your-model-id
```

Repeat `--model` to test more than one model. `--only cache` or `--only tools` limits the test. Use `--url-key`
and `--api-key-key` when an existing private configuration uses different field names. If the gateway requires a
session-affinity header, supply its documented name with `--session-header`; each phase retains one generated ID
across its requests. HTTPS verifies certificates; plaintext HTTP requires explicit `--allow-http`. Redirects,
environment proxies and automatic retries are not used. Never put credentials on the command line.

Each model uses three identical synthetic long-prefix requests, with an ephemeral `cache_control` block, followed
by a two-request function-call roundtrip. This consumes model tokens. The only executable tool is local integer
addition; no model-generated shell code is executed. The returned assistant message, including provider-specific
signature fields, is preserved when sending the tool result back. A fresh receipt proves the final answer consumed
the local tool result. Success requires a positive server-reported cache-read count on a repeat request, not just
HTTP success or lower latency. Missing counters mean an unverified hit, not proof that caching is unsupported.
Cache controls and token limits are gateway/model-dependent; this probe does not establish universal compatibility,
streaming behavior, cache pricing or production Agent readiness. Reports are private and must not be committed.

Offline tests: `python3 -m unittest discover -s scripts/workbench -p 'test_cache_tools.py'`.

### Opt-in live DSH acceptance

`web/e2e/workbench-live.mjs` exercises a real local hub and DSH runtime. First create a private fixture root
outside the hub's state directory, confirm the assistant computer, and select the connected DSH launcher.
The existing private hub configuration supplies authentication; never put a token on the command line.
If the node uses `PERSONA_NODE_SESSION_DIR`, also explicitly set `PERSONA_NODE_WORKSPACE_DIR` to this dedicated
fixture root before starting the node. Otherwise the child can execute but remains outside session discovery,
preventing completion tracking. See [isolated node configuration](../operations/config.md).

```sh
PERSONA_LIVE_ORIGIN=http://127.0.0.1:18660 \
PERSONA_LIVE_HUB_CONFIG=/absolute/private/state/hub.json \
PERSONA_LIVE_ROOT=/absolute/private/acceptance \
PERSONA_LIVE_MACHINE=workbench \
PERSONA_LIVE_RUNTIME=dsh \
node web/e2e/workbench-live.mjs --check
```

The default check makes readiness reads only: no pairing, fixture creation or model request. After it passes,
repeat with `--execute` to spend model tokens on one disposable task. It pairs an isolated browser, starts one
Assistant conversation, delegates to one DSH Agent, and checks file contents, an actual test-tool result and
transcript persistence after reload. It uses the paired browser's real API contract, not composer interaction
automation. Chrome must be installed; `PERSONA_LIVE_BROWSER_CHANNEL` can select another Playwright channel.
Set `PERSONA_LIVE_SCREENSHOTS=1` to retain desktop and mobile screenshots for visual review.

Unexpected approval requests stop the test; it never automatically approves them. Command-approval behavior
therefore needs separate acceptance. A ten-minute deadline and observed tool-call limit are not a server-side
model budget. Failure cleanup interrupts only sessions proven to belong to that run, on a best-effort basis.
Fixture instructions are not an operating-system sandbox. Results, model-generated files and an independently
paired browser profile remain under the private fixture root; do not publish that directory.

The harness's offline guard tests run with `node --test web/e2e/workbench-live.test.mjs`.

### Other integrations

Protocol tests use fake ACP/CLI/HTTP peers and synthetic files. They prove connector contracts and failure handling,
not that your accounts are authenticated or that a particular model executes tools correctly. Live acceptance needs:

1. A running authenticated hub, PostgreSQL and confirmed node.
2. Each selected official client installed and signed in.
3. A disposable repository: read one file, propose one edit, deny one action, approve one action, review the diff.
4. One Feishu conversation routed to exactly one dispatcher; verify a single task and a single reply.
5. A reconnect and an uncertain-send check without duplicate execution.

No account login, production migration, always-on service installation or automatic merge is performed by the
connector test suite. Missing dependencies and credentials should be reported as unavailable, not as successful
integration.
