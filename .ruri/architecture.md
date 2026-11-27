# 공항 — architecture

The shape of this project, for a model that has never seen it: where to change what, the stack it is built as, how the parts connect, where things are, how to run it. Where the work stands — git, decisions, what worked and what didn't, what's open — is in catchup.md beside this file.
Don't edit this file: ruri writes it. `ruri architecture` prints it with every line numbered, and once you have read it that way you can put right what your work changed — `ruri architecture add|set|drop <section> …`. The user corrects it on the architecture page.

공항 (npm: @justin06lee/gonghang) is a zero-dependency TypeScript library that lets independently running components exchange typed messages and request/answer calls through a shared contract type. It is meant to be dropped into any project as a ports-and-adapters layer, with the transport (same process, worker, WebSocket, child process, TCP) swapped by changing one line.

## Where to change what

- **Port API (send, on, once, ask, answer, close):** src/index.ts, test/port.test.ts, README.md
- **Link loss and disconnect handling (gone callback, disconnected, closed):** src/index.ts, test/port.test.ts, docs/guide.md
- **Adapters (memory, worker, websocket, lines, custom, broadcast):** src/index.ts, test/adapters.test.ts
- **Options (channel, name, timeout, relay, stacks, tap, onError):** src/index.ts, README.md
- **Shared contract typing:** test/contract.ts, test/types.ts, src/index.ts
- **Packaging and build config:** package.json, tsconfig.build.json, tsconfig.json
- **Documentation:** docs/guide.md, README.md, docs/diagrams/overview.svg

## The stack, top to bottom

1. **Port API** — connect, send, on, once, ask, answer, close; the only surface apps touch (`src/index.ts`)
2. **Adapters** — Transport plugins that move JSON frames: memory, worker, broadcast, websocket, lines, custom (`src/index.ts`)
3. **Transports** — Bun or Node runtime primitives: Worker, WebSocket, stdio streams, TCP sockets (`external, provided by runtime`)

## How it flows

- **Send and receive a message:** Contract type declares the message name and payload → port.send(name, payload) in sender → Adapter serializes frame and transmits → Adapter listen delivers frame to receiving port → port.on handler runs with payload
- **Ask and answer a question:** port.ask(name, input) creates a request frame with an id → Adapter transmits request to the answering port → port.answer handler computes the result → Reply frame with the same id returns over the adapter → ask promise resolves, or rejects on error, timeout, or disconnect
- **Link loss:** Adapter detects the other side is gone → Adapter calls the gone callback passed to listen → Port rejects waiting asks at once with a disconnected error

## Where things are

- src/index.ts — the whole library: port API and all adapters
- test/contract.ts — shared contract used by tests
- test/port.test.ts — core messaging and ask/answer tests
- test/adapters.test.ts — adapter tests over real transports
- test/types.ts — compile-time contract typing tests
- README.md — usage guide with snippets from tests and examples
- docs/guide.md — reader guide: concepts, full API, failure modes, options, code map
- docs/diagrams/ — SVG diagrams used by the guide
- package.json — package metadata, scoped name @justin06lee/gonghang, version 0.1.0
- tsconfig.json — development compiler config
- tsconfig.build.json — build compiler config

## What it does

- Typed send/on and ask/answer over a shared contract type
- Pluggable adapters: memory, worker, broadcast, websocket, lines, custom
- Custom adapter from send and listen, with a gone callback
- Per-call ask timeouts, where 0 waits indefinitely
- Opt-in relay forwarding frames between adapters
- Optional stack traces sent back with errors
- tap and onError hooks for observing traffic and failures
- Dead links fail waiting asks at once with disconnected error
- Size-capped line framing for untrusted stream peers
- Zero dependencies in a single source file
- Runnable worker, child process, and WebSocket examples
