# T3 Code local bridge

For people managing development work in Persona's Agents view. This optional bridge uses the installed, official
`t3 thread` CLI; it does not embed or install T3 Code, authenticate a model, or rewrite any T3 settings.

## Run

Requires Node 22.19+, a running Persona node, a current T3 Code server and matching `t3` CLI, and a project already
registered in T3 Code. Start from this repository checkout:

```sh
node integrations/t3/index.mjs --project /absolute/path/to/project
```

Repeat `--project` for another project. Optional flags: `--command /path/to/t3`, `--socket /path/to/runtime.sock`,
`--runtime t3-secondary`, and `--messages 40` (1–100). Keep each bridge's runtime id unique on a machine.

Read-only is the default: no start or send capability is registered. To deliberately permit execution:

```sh
node integrations/t3/index.mjs --project /absolute/path/to/project --allow-execution
```

Before enabling execution, set the project's model and permission mode in T3 Code. The bridge uses those defaults;
the CLI cannot impose a safer permission ceiling. The local CLI runs as the machine owner and internally obtains a
short-lived full-access-capable credential. Persona authorization does not turn that into a sandbox.

## Capabilities and limits

- Lists threads and reads a bounded recent-message snapshot. A notice explicitly identifies that limit; a changed
  window gets a new history identity. It is not the complete transcript and contains no tool activity or token streaming.
  An existing thread's absolute `worktreePath`, when reported by T3, is used as its session directory; project grouping
  remains the configured project. Invalid worktree paths or unknown status values fail closed. A failed refresh
  disables new sends until a successful refresh, while preserving prior send receipts.
- With execution enabled, starts a thread in an explicitly configured project and queues text into a listed thread.
  New work uses T3's project checkout, not an automatically created worktree. Choose isolated worktrees in T3 itself.
- Prompts use stdin and arguments are passed without a shell. No credentials are accepted by this bridge.
- No interrupt, approval handling, images, model/mode switching, archive, main-assistant, or automatic restart capability.
  Answer approvals and stop work in T3 Code. Unsupported requested model/mode/effort changes are rejected, not ignored.
- Failed execution calls are not automatically retried. In-process send ids retain both success and failure outcomes.
  After 500 distinct sends the bridge refuses new sends rather than forgetting receipts; restart it deliberately.
  After an ambiguous failure or bridge restart, inspect T3 before manually resending: its CLI has no idempotency-key flag.
- This bridge cannot resume a session that T3 itself cannot resume. Shutting down the bridge does not stop T3 work.
  It does stop and await its own short-lived CLI children, escalating TERM to KILL after a bounded grace period;
  it never sends a signal to the independently owned T3 server. CLI exit code 2 is reported as `needs_user`, with
  instructions to resolve the request in T3 instead of retrying it automatically.

For remote OAuth-based control and richer operations, use T3's documented MCP interface as a separate integration;
do not expose this CLI as an unauthenticated HTTP service.

## Verification

```sh
cd integrations/t3
npm test
```

Tests use a fake CLI and the existing runtime SDK fake node; no model calls or user credentials are needed.
The repository runtime CI automatically discovers this package.

Primary contract: [T3 outside agents](https://github.com/pingdotgg/t3code/blob/main/docs/user/outside-agents.md)
and [CLI implementation](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/cli/thread.ts).
