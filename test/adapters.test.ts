import { afterEach, describe, expect, test } from "bun:test";
import { fork, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer, connect as dial, type Socket as TcpSocket } from "node:net";
import { fileURLToPath } from "node:url";
import { Worker as Thread } from "node:worker_threads";
import { broadcast, connect, custom, lines, memory, websocket, worker, type Adapter, type Frame, type Port, type PortError } from "../src/index.ts";
import type { App } from "./contract.ts";

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);
const script = (name: string) => fileURLToPath(fixture(name));

/** Everything a test opens, closed again afterwards. */
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** The same conversation, whatever the transport underneath. */
const converse = async (port: Port<App>) => {
  expect(await port.ask("sum", { a: 20, b: 22 })).toBe(42);
  const note = port.once("note");
  port.send("user.joined", { name: "공항" });
  expect(await note).toBe("welcome 공항");
};

describe("worker", () => {
  test("a web worker, through self", async () => {
    const thread = new Worker(fixture("worker.ts"));
    const port = connect<App>(worker(thread));
    cleanup.push(() => port.close(), () => thread.terminate());

    await converse(port);

    const error = await port.ask("fail", "too far").catch((error: Error) => error);
    expect(error).toMatchObject({ name: "RangeError", message: "too far" });
  });

  test("a node worker thread, through parentPort", async () => {
    const thread = new Thread(fixture("thread.ts"));
    const port = connect<App>(worker(thread));
    cleanup.push(() => port.close(), () => thread.terminate());

    await converse(port);
  });

  test("the two ends of a MessageChannel", async () => {
    const { port1, port2 } = new MessageChannel();
    const here = connect<App>(worker(port1));
    const there = connect<App>(worker(port2));
    cleanup.push(() => here.close(), () => there.close(), () => port1.close(), () => port2.close());
    there.answer("sum", ({ a, b }) => a + b);
    there.on("user.joined", ({ name }) => there.send("note", `welcome ${name}`));

    await converse(here);
  });
});

describe("broadcast", () => {
  test("reaches a worker that only shares the channel name", async () => {
    const port = connect<App>(broadcast("공항-test"));
    const up = port.once("note");
    const thread = new Worker(fixture("tab.ts"));
    cleanup.push(() => port.close(), () => thread.terminate());

    expect(await up).toBe("tab is up");
    expect(await port.ask("sum", { a: 1, b: 2 })).toBe(3);
  });
});

describe("websocket", () => {
  test("a client socket to a server that receives by callback", async () => {
    type Link = ReturnType<typeof custom>;
    const server = Bun.serve<{ link: Link; port: Port<App> }>({
      port: 0,
      fetch(request, server) {
        return server.upgrade(request, { data: {} as never }) ? undefined : new Response("not a socket", { status: 400 });
      },
      websocket: {
        open(ws) {
          ws.data.link = custom((frame) => ws.send(JSON.stringify(frame)));
          ws.data.port = connect<App>(ws.data.link);
          ws.data.port.answer("sum", ({ a, b }) => a + b);
          ws.data.port.on("user.joined", ({ name }) => ws.data.port.send("note", `welcome ${name}`));
        },
        message(ws, message) {
          ws.data.link.receive(message);
        },
        close(ws) {
          ws.data.port.close();
        },
      },
    });
    const socket = new WebSocket(`ws://localhost:${server.port}`);
    const port = connect<App>(websocket(socket));
    cleanup.push(() => port.close(), () => socket.close(), () => server.stop(true));

    // Nothing has opened yet: these frames wait for the socket.
    expect(socket.readyState).toBe(WebSocket.CONNECTING);
    await converse(port);
  });
});

describe("lines", () => {
  test("a child process over bun's web streams", async () => {
    const child = Bun.spawn(["bun", script("child.ts")], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    const port = connect<App>(lines(child.stdout, child.stdin));
    cleanup.push(() => port.close(), () => child.kill());

    await converse(port);
    expect(await port.ask("shout", "한글도 됩니다")).toBe("한글도 됩니다".toUpperCase());
  });

  test("a child process over node streams", async () => {
    const child = spawn("bun", [script("child.ts")], { stdio: ["pipe", "pipe", "inherit"] });
    const port = connect<App>(lines(child.stdout, child.stdin));
    cleanup.push(() => port.close(), () => child.kill());

    await converse(port);
  });

  test("both directions on one TCP socket", async () => {
    const server = createServer((socket) => {
      const port = connect<App>(lines(socket));
      port.answer("sum", ({ a, b }) => a + b);
      port.on("user.joined", ({ name }) => port.send("note", `welcome ${name}`));
      socket.on("close", () => port.close());
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port: tcpPort } = server.address() as { port: number };
    const socket: TcpSocket = dial(tcpPort);
    const port = connect<App>(lines(socket));
    cleanup.push(() => port.close(), () => socket.destroy(), () => server.close());

    await converse(port);
  });

  test("frames split across chunks, and several in one chunk", () => {
    const listeners = new Set<(chunk: Uint8Array) => void>();
    const stream = {
      on: (event: string, listener: (chunk: Uint8Array) => void) => event === "data" && listeners.add(listener),
      off: (_: string, listener: (chunk: Uint8Array) => void) => listeners.delete(listener),
      write: () => {},
    };
    const port = connect<App>(lines(stream));
    const heard: string[] = [];
    port.on("user.joined", ({ name }) => heard.push(name));

    const frame = (id: string, name: string) =>
      JSON.stringify({ channel: "main", id, from: "x", kind: "send", name: "user.joined", data: { name } }) + "\n";
    const bytes = new TextEncoder().encode(frame("x#1", "공항") + frame("x#2", "airport") + frame("x#3", "空港"));
    // Cut in awkward places: inside a frame, and inside a multi-byte character.
    const cut = bytes.indexOf(0xea) + 1;
    for (const chunk of [bytes.slice(0, cut), bytes.slice(cut, cut + 40), bytes.slice(cut + 40)]) {
      for (const listener of listeners) listener(chunk);
    }

    expect(heard).toEqual(["공항", "airport", "空港"]);
    port.close();
    expect(listeners.size).toBe(0);
  });
});

describe("your own", () => {
  // The adapter from the README: node's process IPC, in two functions.
  const ipc = (child: ChildProcess): Adapter => ({
    send: (frame) => child.send(frame),
    listen: (receive, gone) => {
      child.on("message", receive);
      child.on("exit", gone);
      return () => child.off("message", receive);
    },
  });

  test("a hand-written adapter is two functions", async () => {
    const child = fork(script("forked.ts"));
    const port = connect<App>(ipc(child));
    cleanup.push(() => port.close(), () => child.kill());

    await converse(port);
  });

  test("and it can say when the other side has gone", async () => {
    const child = fork(script("forked.ts"));
    const port = connect<App>(ipc(child));
    cleanup.push(() => port.close(), () => child.kill());
    await converse(port);

    const stranded = port.ask("now", undefined, { timeout: 0 }).catch((error: PortError) => error.code);
    child.kill();

    expect(await stranded).toBe("disconnected");
  });

  test("wrapping an adapter adds behaviour the ports never see", async () => {
    const looksRight = (frame: unknown) => (frame as Frame).name !== "tick";
    const validated = (inner: Adapter): Adapter => ({
      send: inner.send,
      listen: (receive, gone) => inner.listen((frame) => looksRight(frame) && receive(frame), gone),
    });

    const hub = memory();
    const here = connect<App>(validated(hub));
    const there = connect<App>(hub);
    cleanup.push(() => here.close(), () => there.close());
    const heard: string[] = [];
    here.on("tick", () => heard.push("tick"));
    here.on("note", (text) => heard.push(text ?? ""));

    there.send("tick");
    there.send("note", "let through");

    expect(heard).toEqual(["let through"]);
  });
});

describe("when the other side goes away", () => {
  /** An ask nobody answers and no timeout ends: only the adapter noticing can settle it. */
  const stranded = (port: Port<App>) => port.ask("now", undefined, { timeout: 0 }).catch((error: PortError) => error.code);

  test("a worker that is terminated", async () => {
    const thread = new Worker(fixture("worker.ts"));
    const port = connect<App>(worker(thread));
    cleanup.push(() => port.close(), () => thread.terminate());
    await converse(port);

    const waiting = stranded(port);
    thread.terminate();

    expect(await waiting).toBe("disconnected");
    expect(await stranded(port)).toBe("disconnected"); // and from now on, straight away
  });

  test("a node worker thread that exits", async () => {
    const thread = new Thread(fixture("thread.ts"));
    const port = connect<App>(worker(thread));
    cleanup.push(() => port.close(), () => thread.terminate());
    await converse(port);

    const waiting = stranded(port);
    await thread.terminate();

    expect(await waiting).toBe("disconnected");
  });

  test("a MessageChannel closed at the far end", async () => {
    const { port1, port2 } = new MessageChannel();
    const here = connect<App>(worker(port1));
    const there = connect<App>(worker(port2));
    cleanup.push(() => here.close(), () => there.close(), () => port1.close(), () => port2.close());

    const waiting = stranded(here);
    port2.close();

    expect(await waiting).toBe("disconnected");
  });

  test("a websocket the server hangs up on", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request, server) {
        return server.upgrade(request, { data: undefined }) ? undefined : new Response("not a socket", { status: 400 });
      },
      websocket: { message: (ws) => void ws.close() },
    });
    const socket = new WebSocket(`ws://localhost:${server.port}`);
    const port = connect<App>(websocket(socket));
    cleanup.push(() => port.close(), () => socket.close(), () => server.stop(true));

    expect(await stranded(port)).toBe("disconnected");
  });

  test("a websocket that never connects", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("only here to find a free port") });
    const free = server.port;
    await server.stop(true);
    const socket = new WebSocket(`ws://localhost:${free}`);
    const port = connect<App>(websocket(socket));
    cleanup.push(() => port.close(), () => socket.close());

    expect(await stranded(port)).toBe("disconnected");
  });

  test("a child process that dies, over bun's web streams", async () => {
    const child = Bun.spawn(["bun", script("child.ts")], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    const port = connect<App>(lines(child.stdout, child.stdin));
    cleanup.push(() => port.close(), () => child.kill());
    await converse(port);

    const waiting = stranded(port);
    child.kill();

    expect(await waiting).toBe("disconnected");
  });

  test("a child process that dies, over node streams", async () => {
    const child = spawn("bun", [script("child.ts")], { stdio: ["pipe", "pipe", "inherit"] });
    const port = connect<App>(lines(child.stdout, child.stdin));
    cleanup.push(() => port.close(), () => child.kill());
    await converse(port);

    const waiting = stranded(port);
    child.kill();

    expect(await waiting).toBe("disconnected");
  });

  test("a TCP socket the server drops", async () => {
    const server = createServer((socket) => socket.once("data", () => socket.destroy()));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port: tcpPort } = server.address() as { port: number };
    const socket: TcpSocket = dial(tcpPort);
    const port = connect<App>(lines(socket));
    cleanup.push(() => port.close(), () => socket.destroy(), () => server.close());

    expect(await stranded(port)).toBe("disconnected");
  });
});

describe("a stream that died", () => {
  test("still catches a write that fails late", () => {
    // In node, a write made just before the other side died fails after the stream has ended,
    // and an "error" nobody listens for brings the whole process down.
    const dead = Object.assign(new EventEmitter(), { write: () => {} });
    const port = connect<App>(lines(dead));
    cleanup.push(() => port.close());

    dead.emit("end");
    expect(() => dead.emit("error", new Error("EPIPE"))).not.toThrow();

    // A stream that is merely let go of is left as it was found.
    const alive = Object.assign(new EventEmitter(), { write: () => {} });
    connect<App>(lines(alive)).close();
    expect(alive.eventNames()).toHaveLength(0);
  });
});
