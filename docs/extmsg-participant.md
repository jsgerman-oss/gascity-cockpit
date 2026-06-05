# extmsg Participant Integration

> Status: **BUILT** (`src/extmsg/`, `src/api/extmsg.ts`). Implements
> cockpit-1ll.12 (Phase 3) and the ratified Fork #2 from the pack design
> (`pack/docs/DESIGN.md`). Builds on the typed /v0 client (cockpit-1ll.1,
> `src/api/`) and the connection/resilience contract (cockpit-1ll.2,
> `src/discovery/`).

Makes VS Code a **first-class, durable participant** in gascity's external
messaging (extmsg) fabric: the Cockpit registers itself as an extmsg *adapter*
in each running city, advertising a reachable callback URL the supervisor uses
for outbound delivery.

## Why this exists

extmsg is the supervisor's durable, multi-party conversation fabric — adapters
(Slack, a CLI, the editor) register against a city, bind sessions to
conversations, exchange inbound/outbound messages, and share a transcript. For
the editor to be a real participant (not just a reader) it must be addressable:
the supervisor needs somewhere to deliver messages.

Adapter registration is `POST /v0/city/{cityName}/extmsg/adapters` with
`{provider, account_id, name, callback_url, capabilities}`. Two facts shape the
design (pack `docs/DESIGN.md` Fork #2):

1. **The registry is in-memory and ephemeral** — it is lost on a controller
   restart. So a static pack install cannot durably register; the *host*
   re-registers on every (re)connect. That is what "durable" means here.
2. **An adapter needs a reachable `callback_url`** — a running HTTP service. The
   Cockpit is a VS Code extension (a client), so it stands up a small loopback
   HTTP service and advertises its URL at registration time.

The `.14` pack ships only the adapter *spec* (`contract/v0.toml` `[extmsg]`,
provider `cockpit` + capabilities); the actual runtime registration lives here.

## Architecture

A provider-agnostic, `vscode`-free core (Seam 1) with a thin editor binding:

| Layer | File | Responsibility |
|-------|------|----------------|
| API methods | `src/api/extmsg.ts` | Typed wrappers over every `/extmsg/*` endpoint + `/v0/cities` |
| Adapter identity | `src/extmsg/identity.ts` | Provider / account / name / capabilities, mirroring `contract/v0.toml` |
| Callback service | `src/extmsg/callback-server.ts` | Loopback HTTP listener; its URL is the `callback_url` |
| Registration manager | `src/extmsg/participant.ts` | Starts the service, fans registration across running cities, re-registers on reconnect |
| Editor binding | `src/extension.ts` | Drives connect/disconnect off supervisor reachability; status command |

### Registration contract

The runtime POST body is the TypeScript twin of the pack's
`adapter_registration_spec` (same casing — snake_case envelope, **PascalCase**
capability keys):

```jsonc
{
  "provider": "cockpit",
  "account_id": "default",
  "name": "VS Code Cockpit",
  "callback_url": "http://127.0.0.1:<port>/extmsg/callback/<token>",
  "capabilities": {
    "SupportsChildConversations": true,
    "SupportsAttachments": false,
    "MaxMessageLength": 0
  }
}
```

`contract/v0.toml` `[extmsg]` is the source of truth for provider id and
capabilities; the constants in `identity.ts` mirror it.

### Lifecycle (durability)

`ExtMsgParticipant` mirrors `LiveStatus`: the editor calls `connect(endpoint)`
when the supervisor is healthy, `disconnect()` when it goes away, and
`connect()` again on a restart. On connect it starts the callback service, lists
cities, and registers in each **running** city. Because the server-side registry
is ephemeral, re-registering on every (re)connect is the durability mechanism.
A generation counter discards in-flight work superseded by a newer
connect/disconnect.

Per Fork #2 it **refuses to register callback-less**: if the callback service
cannot start, no registration happens (a registration without a reachable
callback is exactly the half-working state the pack avoids).

### The callback service

A `node:http` listener that:

- binds `127.0.0.1` only (never a routable interface);
- guards its route with an unguessable token segment
  (`/extmsg/callback/<token>`), so only the supervisor — which received the URL
  at registration — can reach it, not arbitrary local processes;
- caps the request body to bound memory from a runaway/hostile POST;
- answers `GET`/`HEAD` as a liveness probe and `POST` as a delivery (parsed
  JSON, or raw text when not JSON), always returning `200` so a faulty handler
  never 500s the supervisor.

The delivery payload is the supervisor→adapter contract, which lives outside the
`/v0` OpenAPI surface, so deliveries are surfaced permissively (raw body +
headers) rather than against a rigid schema.

## Using it

- Command **"GasCity Cockpit: Show extmsg Participant Status"** shows the
  callback URL, per-city registration state, and recent delivery count, and can
  copy the callback URL.
- Registration follows the supervisor automatically — no manual step.

## Testing

Seam 1 conventions (`environment: node`, no `vscode`):

- `src/api/extmsg.test.ts` drives the typed client against a mock /v0 server
  (path, query, body, CSRF header per endpoint).
- `src/extmsg/callback-server.test.ts` exercises a **real** loopback server with
  `fetch` — delivery, non-JSON tolerance, the 404/405/413 guards, the probe.
- `src/extmsg/participant.test.ts` uses a fake callback service + mock /v0 to
  cover multi-city registration, callback-less refusal, per-city failure
  isolation, unregister-on-disconnect, and the delivery ring buffer.
