# Task supervisor extension

An optional Persona extension for an **existing** [DSH Super-agent prototype](https://github.com/deepseek-ai/dsh-superagent-prototype). It adds a standard extension page to the drawer, not a new primary navigation item. It does not install DSH, start the supervisor, configure accounts, or replace Persona's assistant runtime.

## Architecture and boundaries

```text
Persona extension page -> hub program (stdio)
  -> authenticated Persona nodes.call -> selected computer program (--node)
  -> http://127.0.0.1:<port>/orchestrator/api/
```

The hub never contacts its own loopback to reach a remote supervisor. The same Go binary serves the hub and computer roles. The manifest requests only the computer's loopback network host, no files, no secrets and no hub-network permission. The node is lease-managed by Persona Link. No service port or upstream API is exposed to the browser.

Read-only by default:

- Executor paused/running state and running, queued and maximum worker counts.
- Ticket filters, 20-item pagination and explicit refresh (30-second refresh while a successful page is open).
- Ticket metadata: title, ID, stage, action, input/assignment counts and timestamps.
- English, Simplified Chinese and Japanese UI and settings. The current Persona protocol supports only one language for manifest contribution titles; the drawer entry is English, while the opened page is localized.

Optional controls require the `allow_control` setting and a confirmation on every button: retry ticket, stop ticket, pause executor, resume executor. Both hub controller and node controller enforce the opt-in; the node accepts only these four operations. Retry/stop recheck the upstream ticket's current advertised eligibility before posting. A stop is **not** an undo, and pause does not promise cancellation of already-running work.

This is not a chat runtime. The upstream management API has **no create-ticket or send-message route**. New requests and follow-up answers still enter through DSH Super-agent's configured Feishu/GitHub Sources. This panel does not add a second message-ingestion bot or change Persona's existing Lark integration. It does not expose prompts, environment variables, accounts, raw error details, full transcripts, execution directories, settings, source administration or a generic HTTP proxy. Ticket titles are still user data: access must remain restricted to the intended Persona users/devices.

## Requirements

- A Persona hub and paired Persona Link computer with the standard extension node protocol.
- An already configured DSH Super-agent instance listening on **127.0.0.1** on that computer. Default port `3082` matches the upstream deployment example; use the actual configured port.
- Go 1.24 or newer to build. This module uses only the standard library and the repository's local Go SDK (`../../sdk/go`); no external Go dependency is added.

## Build and test

Run from this directory inside the Persona source checkout:

```sh
GOWORK=off go test ./...
GOWORK=off go test -race ./...
GOWORK=off go build -o bin/dsh-supervisor-local .
./bin/dsh-supervisor-local manifest
```

Tests use `exttest` for extension-protocol conformance and the actual hub UI -> `nodes.call` contract, plus local `httptest` servers. They cover both program roles, locale rendering, confirmation actions, disabled/forged controls, target validation, current upstream list/detail shapes, response projection, redirects, timeouts, the 8 MiB response cap and no automatic failed-write retry. Tests do not start DSH, log in, call a model, or change an installed Persona configuration.

## Package and install manually

Have the intended Go toolchain and `personad` on `PATH`. Keep this directory in the checkout while building so the local SDK replacement resolves. Use the standard packer to build all four declared platforms and include `l10n/`:

```sh
GOWORK=off personad extension test .
GOWORK=off personad extension pack . --out dist
```

The packer prints the generated archive paths and hashes. Install the printed archive on the hub using `personad extension install <archive-path>` (or upload the archive through the extension settings UI). Review the displayed permissions before approving. Do not publish or register a marketplace merely to test this extension.

Then in Persona's extension settings:

1. Open **Task supervisor** and enable it if needed.
2. Select exactly one already-paired computer that runs DSH Super-agent. Selecting the computer deploys the node program through Persona Link.
3. Set the local supervisor port and save. Keep **Allow task controls** off for the initial connection.
4. Open the extension page from the drawer and verify the read-only state against the supervisor's own panel.
5. Only if desired, explicitly enable **Allow task controls**, review its warning and save. Test a low-risk action with confirmation.

The equivalent configuration command uses a machine **ID**, not a hostname or a URL:

```sh
personad extension config dsh-supervisor 'machines=["your-machine-id"]' port=3082 allow_control=false
```

These instructions are manual. Development of this integration does not perform installation, enablement, account configuration or any upstream control operation.

## Security and failure behavior

- The configured port must be in `1..65535`; callers cannot supply a URL, headers, a port override or an arbitrary route. Ticket IDs accept only ASCII letters, digits, `_` and `-`, up to 128 characters, with an alphanumeric first character.
- Requests target literal `127.0.0.1`, bypass environment proxies, send `X-Orchestrator-Request: 1`, carry no browser cookies/authorization/origin, and never follow redirects. Each HTTP request has an 8-second timeout and an 8 MiB response limit; a dashboard uses separate state and ticket reads and is not an atomic snapshot.
- The DSH prototype has no bearer-authenticated management API; its own boundary is loopback plus the request header. This extension relies on Persona's authenticated hub/node channel to reach that local boundary, not on an invented upstream token scheme. A hostile process with access to that local port is outside this connector's trust boundary.
- Only bounded, typed metadata is returned to the hub. Raw upstream errors are suppressed. Unknown ticket stages and malformed upstream response shapes fail closed, rather than appearing idle/successful.
- There is no automatic application retry of control requests, no queued offline write, and no promise of exactly-once execution. A lost response can leave a write's outcome unknown: refresh/check the supervisor before deciding to retry. Failed page reads stop the page's automatic refresh until manually refreshed.
- Disabling the extension or deselecting its computer stops the connector, **not** the independently running DSH supervisor or its workers.

## Verified upstream contract

The implementation follows the prototype's current primary source (inspected 2026-11-12):

- [`src/app/api.ts`](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/app/api.ts): `GET state`, `GET tickets`, `GET tickets/:id`, `POST tickets/:id/retry`, `POST tickets/:id/stop`, `POST executor/pause`.
- [`src/app/http.ts`](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/app/http.ts): loopback/same-origin header checks, state and detail response shapes.
- [`src/app/views/records.ts`](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/app/views/records.ts) and [`tickets.ts`](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/app/views/tickets.ts): list counts versus detail arrays, stage and eligibility projections.
- [`src/core/stage.ts`](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/core/stage.ts): ticket stage/action classification.
- [`docs/006-deployment.md`](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/006-deployment.md): independent deployment and management API usage.

The upstream prototype can change. A live, user-authorized smoke test against the installed version is still required before treating this as production-ready; mock and protocol tests are not evidence of a live deployment.
