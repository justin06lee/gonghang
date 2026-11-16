// The built file, run for real on whichever runtime is asked to:
//
//   bun test/smoke.mjs  ·  node test/smoke.mjs  ·  deno run -A test/smoke.mjs
//
// `bun test` covers the source in depth, on bun. This is the short proof that
// what ships in dist/ works on the others too, using only what all three share.
import assert from "node:assert/strict";
import { createServer, connect as dial } from "node:net";
import process from "node:process";
import { Worker } from "node:worker_threads";
import { broadcast, connect, lines, memory, worker } from "../dist/index.js";

const runtime = typeof Bun !== "undefined" ? "bun" : typeof Deno !== "undefined" ? "deno" : "node";

/** How a promise ended: "resolved", or the code of the error it rejected with. */
const ending = (promise) =>
  promise.then(
    () => "resolved",
    (error) => error.code,
  );

const watchdog = setTimeout(() => {
  console.error(`✗ ${runtime}: the smoke test hung`);
  process.exit(1);
}, 20_000);

const passed = [];
const check = async (name, run) => {
  await run();
  passed.push(name);
};

await check("memory", async () => {
  const hub = memory();
  const a = connect(hub);
  const b = connect(hub);
  b.answer("sum", ({ a, b }) => a + b);
  b.answer("fail", () => {
    throw Object.assign(new RangeError("too far"), { code: "E_FAR" });
  });

  const heard = b.once("hello");
  a.send("hello", "공항");
  assert.equal(await heard, "공항");
  assert.equal(await a.ask("sum", { a: 20, b: 22 }), 42);
  const error = await a.ask("fail").catch((error) => error);
  assert.deepEqual([error.name, error.message, error.code], ["RangeError", "too far", "E_FAR"]);

  a.close();
  b.close();
  assert.equal(await ending(a.ask("sum")), "closed");
});

await check("worker over a MessageChannel", async () => {
  const { port1, port2 } = new MessageChannel();
  const here = connect(worker(port1));
  const there = connect(worker(port2));
  there.answer("shout", (text) => text.toUpperCase());
  assert.equal(await here.ask("shout", "hey"), "HEY");

  const stranded = ending(here.ask("nobody", undefined, { timeout: 0 }));
  port2.close();
  assert.equal(await stranded, "disconnected");

  here.close();
  there.close();
  port1.close();
});

await check("worker over a worker thread", async () => {
  const thread = new Worker(new URL("./fixtures/smoke-thread.mjs", import.meta.url));
  const port = connect(worker(thread));
  assert.equal(await port.ask("sum", { a: 1, b: 2 }), 3);

  const stranded = ending(port.ask("nobody", undefined, { timeout: 0 }));
  await thread.terminate();
  assert.equal(await stranded, "disconnected");

  port.close();
});

await check("lines over a TCP socket", async () => {
  const server = createServer((socket) => {
    const port = connect(lines(socket));
    port.answer("sum", ({ a, b }) => a + b);
    port.on("bye", () => socket.destroy());
    socket.on("close", () => port.close());
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const socket = dial(server.address().port);
  const port = connect(lines(socket));
  assert.equal(await port.ask("sum", { a: 2, b: 3 }), 5);

  const stranded = ending(port.ask("nobody", undefined, { timeout: 0 }));
  port.send("bye");
  assert.equal(await stranded, "disconnected");

  port.close();
  socket.destroy();
  await new Promise((resolve) => server.close(resolve));
});

await check("broadcast", async () => {
  const name = `gonghang-smoke-${Math.random()}`;
  const a = connect(broadcast(name));
  const b = connect(broadcast(name));
  b.answer("sum", ({ a, b }) => a + b);
  assert.equal(await a.ask("sum", { a: 4, b: 5 }), 9);

  a.close();
  b.close();
});

clearTimeout(watchdog);
console.log(`✓ ${runtime}: ${passed.join(", ")}`);
