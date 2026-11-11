<div align="center">

<img src="assets/gonghang.svg" alt="공항 (gonghang)" width="620" />

# 공항

**Tiny typed messaging between the parts of your program.**<br>
*One shared contract, a port for each component, an adapter for every boundary.*

</div>

---

공항 (*gonghang*, Korean for "airport") lets the pieces of a program talk to each other without knowing where the others live: two modules in one process, a page and its worker, a browser and a server, a parent process and its child. You write down what can be said once, as a plain TypeScript type. Each piece opens a port and uses the same few verbs, whatever sits in between.

It is one file with no dependencies, and it runs on bun, node, deno and in browsers.

## Install

```sh
bun add @justin06lee/gonghang
```

From a clone instead, run `make` in it once and then `bun add /path/to/공항` in your project.

Or install nothing: the whole library is [`src/index.ts`](src/index.ts). Copy that file into a project and import from it.

## The whole thing in a minute

**1. Write the contract.** One type, in a file every component can import.

```ts
// contract.ts
export type App = {
  "user.joined": { name: string };                      // a message
  "sum": (input: { a: number; b: number }) => number;   // a question
};
```

A function is a **question**: one side asks it, another answers. Anything else is a **message**: one side sends it, everyone listening hears it.

**2. Open a port** in each component.

```ts
import { connect } from "@justin06lee/gonghang";
import type { App } from "./contract";

const port = connect<App>();
```

**3. Talk.**

```ts
port.on("user.joined", ({ name }) => console.log(`hi ${name}`));
port.send("user.joined", { name: "justin" });

port.answer("sum", ({ a, b }) => a + b);
const total = await port.ask("sum", { a: 20, b: 22 }); // 42
```

Names autocomplete, payloads are checked, and `total` is a `number`, all from the contract. Sending a question or asking a message is a type error.

That is already a working bus for one process. To reach a component that lives somewhere else, hand `connect` an adapter. Nothing else in your code changes.

```ts
// main.ts
import { connect, worker } from "@justin06lee/gonghang";
const port = connect<App>(worker(new Worker("./worker.ts")));

// worker.ts
import { connect, worker } from "@justin06lee/gonghang";
const port = connect<App>(worker(self));
```

## The port

| | |
|---|---|
| `port.send(name, data)` | Tell everyone. |
| `port.on(name, handler)` | Hear it every time. Returns a function that stops listening. |
| `port.once(name)` | A promise for the next one. |
| `port.ask(name, input)` | Ask, and await the answer. |
| `port.answer(name, handler)` | Be the one who answers. Return the answer or a promise of it. Returns a function that steps down. |
| `port.close()` | Stop listening, fail the asks still waiting, let go of the adapters. |

Handlers also get the raw frame as a second argument, if you want to know who sent something: `port.on("user.joined", (data, frame) => frame.from)`.

## Adapters

An adapter is how a port reaches past its own process. Pick the one that matches the boundary.

| Adapter | Reaches | Data travels as |
|---|---|---|
| *none* | handlers on the same port | the same object |
| `memory()` | every port given the same hub, in one process | the same object |
| `worker(target)` | the other side of a `postMessage` | a structured clone |
| `broadcast(name)` | everything on that BroadcastChannel | a structured clone |
| `websocket(socket)` | the other end of a WebSocket | JSON |
| `lines(input, output)` | the other end of a pair of streams | JSON, one frame per line |
| `custom(send)` | anything else | whatever you make of it |

### `memory()`

A hub inside one process, for when each component should own its port instead of sharing one. Also the easy way to test two sides of a conversation.

```ts
const hub = memory();
const billing = connect<App>(hub);
const emails = connect<App>(hub);
```

### `worker(target)`

Anything with `postMessage`: a `Worker`, `self` inside one, a `MessagePort`, and `Worker` and `parentPort` from node's `worker_threads`.

```ts
connect<App>(worker(new Worker("./worker.ts"))); // outside
connect<App>(worker(self));                      // inside
```

### `broadcast(name)`

Every tab, iframe and worker that opens the same name, with no reference to each other needed. Nothing is held for latecomers: only ports listening at that moment hear a message.

```ts
connect<App>(broadcast("my-app"));
```

### `websocket(socket)`

The client end of a WebSocket. Frames sent before the socket opens wait for it, so there is no `onopen` to arrange.

```ts
connect<App>(websocket(new WebSocket("wss://example.com/live")));
```

### `lines(input, output)`

One frame of JSON per line over any streams: node streams, web streams, a bun `FileSink`. That covers child processes, TCP and unix sockets, and pipes. Lines that aren't frames are skipped, so a stray `console.log` in the child does no harm.

```ts
// parent
const child = Bun.spawn(["bun", "child.ts"], { stdin: "pipe", stdout: "pipe" });
connect<App>(lines(child.stdout, child.stdin));

// child
connect<App>(lines(process.stdin, process.stdout));

// one socket, both directions
connect<App>(lines(socket));
```

### `custom(send)`

For transports that hand you messages in a callback you don't control. You say how to send, and call `receive` yourself when something arrives. A WebSocket server is the usual case, with one port per connection, so what a port sends goes to that client only:

```ts
type Seat = { link: ReturnType<typeof custom>; port: Port<App> };

Bun.serve<Seat>({
  fetch: (request, server) => (server.upgrade(request, { data: {} as Seat }) ? undefined : new Response("no")),
  websocket: {
    open(ws) {
      const link = custom((frame) => ws.send(JSON.stringify(frame)));
      const port = connect<App>(link, { stacks: false });
      port.answer("sum", ({ a, b }) => a + b);
      ws.data = { link, port };
    },
    message: (ws, message) => ws.data.link.receive(message),
    close: (ws) => ws.data.port.close(),
  },
});
```

### Your own

An adapter is two functions. This one is node's process IPC:

```ts
import type { Adapter } from "@justin06lee/gonghang";

const ipc = (child: ChildProcess): Adapter => ({
  send: (frame) => child.send(frame),
  listen: (receive) => {
    child.on("message", receive);
    return () => child.off("message", receive); // optional: how to stop
  },
});
```

`receive` takes a frame or the JSON text of one and ignores everything else, so pass it whatever arrives without checking first.

That is also where anything fancier goes. Compression, encryption, batching, reconnecting, validating what comes in: wrap an adapter in another adapter and the ports never know.

```ts
const validated = (inner: Adapter): Adapter => ({
  send: inner.send,
  listen: (receive) => inner.listen((frame) => looksRight(frame) && receive(frame)),
});
```

## Hubs

A port can hold several adapters. It sends through all of them and hears from all of them, but it does not pass what arrives on one out through the others unless you say so:

```ts
// The main thread, letting two workers talk to each other.
connect<App>([worker(first), worker(second)], { relay: true });
```

Relay is off by default on purpose. With it on, everything connected hears everything, which is what you want between your own workers and not what you want between two strangers' browser tabs. Loops are safe: a frame is handled once per port however many ways it arrives.

## Options

```ts
connect<App>(adapters, {
  channel: "main",   // ports only hear ports on the same channel
  name: "renderer",  // stamped on every frame as `from`; random if left out
  timeout: 5000,     // how long ask waits, in ms; 0 waits forever
  relay: false,      // pass frames between adapters (see Hubs)
  stacks: true,      // send stack traces with errors; turn off facing strangers
  tap: (frame, direction) => console.log(direction, frame), // see every frame
  onError: (error) => report(error), // errors thrown in on() handlers and adapters
});
```

One ask can have its own patience: `port.ask("sum", input, { timeout: 500 })`.

## Good to know

- **A port hears its own messages.** `send` reaches the handlers on the same port too, like any event emitter.
- **In one process, delivery is immediate.** Handlers run before `send` returns. Across an adapter, they run when the frame gets there.
- **One answerer per question per port.** A second `answer` for the same name throws. Across ports, the first answer to arrive wins and the rest are dropped.
- **Data has to survive the trip.** JSON for `websocket` and `lines`, a structured clone for `worker` and `broadcast`. With no adapter or `memory()`, handlers get the very same object, so don't mutate it.
- **A port trusts its adapters.** Whatever arrives on one is treated as coming from a peer. On a public socket, check inside your handlers who is asking and what they sent.
- **Without a contract, anything goes.** `connect()` with no type allows every name and types everything as `any`.

## When an ask fails

It rejects, in one of two ways. If the answerer threw, you get an `Error` with the same `name`, `message` and `code`, and its stack. The error's class does not cross, so check `error.name` rather than `instanceof`. If nobody answered, you get a `PortError`:

| `error.code` | Meaning |
|---|---|
| `"timeout"` | Nobody answered in time. |
| `"unanswered"` | The port has no adapters and no answerer, so nobody could. |
| `"closed"` | The port closed first. |

## Other languages

Frames are plain JSON, so a component in Go, Rust or Python can sit on the other end of `lines` or a WebSocket and speak them directly. There are three kinds:

```json
{"channel":"main","id":"a#1","from":"a","kind":"send","name":"user.joined","data":{"name":"justin"}}
{"channel":"main","id":"a#2","from":"a","kind":"ask","name":"sum","data":{"a":20,"b":22}}
{"channel":"main","id":"b#1","from":"b","kind":"answer","name":"sum","to":"a#2","data":42}
```

An answer that failed carries `"error":{"name":"RangeError","message":"too big"}` instead of `data`. Every frame needs an `id` that is unique to it, and an answer's `to` is the `id` of the ask it answers.

## Examples

The same small kitchen, over three boundaries. Each runs with bun from the repo root.

```sh
bun examples/worker/main.ts        # a worker thread
bun examples/process/parent.ts     # a child process over stdin and stdout
bun examples/websocket/server.ts   # a server, then examples/websocket/client.ts beside it
```

## Development

```sh
make   # install, typecheck, test, build
```

The tests drive every adapter over the real thing: web workers, node worker threads, a MessageChannel, a BroadcastChannel, a WebSocket server, child processes, process IPC and a TCP socket. `test/types.ts` is the type-level half: it only has to compile.

MIT licensed.
