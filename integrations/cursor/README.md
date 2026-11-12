# Cursor ACP runtime

For people using Persona's Agents view to start development sessions with their existing official Cursor CLI.
This bridge speaks [Cursor's documented ACP interface](https://cursor.com/docs/cli/acp), not a reverse-engineered
model endpoint. It does not embed Cursor's IDE, copy subscription tokens, install the CLI, or alter its settings.

## Run

Requires Node 22.19+, a running Persona node, and an installed Cursor CLI with ACP support. Authenticate using
Cursor's own `agent login` first (or its documented API-key environment). No credentials belong in this repository.

```sh
node integrations/cursor/index.mjs
```

Optional flags: `--command /path/to/agent`, `--socket /path/to/runtime.sock`, `--runtime cursor-secondary`.
Choose the Cursor launcher when creating an Agent in Persona, then select an existing absolute project directory.
The bridge spawns `agent acp` directly, without a shell or unrestricted/bypass flags.

## Behavior

- ACP initialization and optional advertised `cursor_login` authentication precede session creation.
- Each new Persona session owns a separate ACP process. Text, reasoning, and basic tool-call/result events are mapped
  to the existing chat view. Text streaming is accumulated even when nobody watches.
- Permission requests, Cursor questions, and plan approvals use Persona's existing interaction cards. Only explicit
  approval grants a single operation. Dismissal, timeout, invalid answers, interruption, and disconnect do not approve.
  Every upstream request gets a fresh approval identity, even if Cursor reuses a tool-call ID. No persistent
  "allow always" grant is advertised. Empty plans and ambiguous question/option IDs fail closed; multi-select labels
  containing `, ` are refused because Persona's current answer format cannot disambiguate them.
- Plan starts require Cursor to advertise `plan`, then successfully accept `session/set_mode` before any prompt.
  Unsupported model, effort, takeover, and bypass settings fail explicitly. Default starts use Cursor's own selected
  model and settings; no model catalog or permission guarantee is invented by the bridge.
- Interrupt sends `session/cancel`; if the process does not settle within five seconds it is terminated. Loss of the
  Persona hub also cancels active turns and terminates pending startup handshakes. No new turn can begin without
  an active hub connection. Shutdown awaits owned children, escalating TERM to KILL after a bounded grace period.

## Boundaries

This first adapter manages only sessions it starts during the current bridge process. It neither discovers IDE
sessions nor automatically restores old sessions after restart. Conversation items are held in memory; the Persona
hub can cache them, but this adapter is not a durable transcript archive. Shutdown terminates its owned ACP processes.
Start a new session after a disconnected process; the bridge never silently retries a prompt.

Text prompts only. Images, model switching, effort selection, native subagent trees, todo rendering, generated-image
previews, and the Persona main-assistant backend are not advertised. Unsupported reverse ACP methods return an error;
the adapter does not grant filesystem or terminal delegation capabilities it has not implemented.

Cursor's own configuration and workspace permissions still apply. No bypass flag is passed, but existing unrestricted
CLI settings are not a sandbox: review them before using any coding agent on important repositories.

## Verification

```sh
cd integrations/cursor
npm test
```

Tests use a mock ACP process and Persona's runtime fake node; they do not call a model, sign in, or modify a user project.
The repository runtime CI discovers this package automatically. Live CLI compatibility still requires a user-authenticated
Cursor installation; mocks prove the bridge's protocol handling and deny-safe behavior, not account availability.
