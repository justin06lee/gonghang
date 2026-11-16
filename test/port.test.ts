import { describe, expect, test } from "bun:test";
import { connect, custom, memory, PortError, type Adapter, type Frame } from "../src/index.ts";
import type { App } from "./contract.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The error a promise rejects with, or undefined if it resolved. */
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: Error & { code?: unknown }) => error,
  );

describe("one port", () => {
  test("send is heard by on, until it is stopped", () => {
    const port = connect<App>();
    const heard: string[] = [];
    const stop = port.on("user.joined", ({ name }) => heard.push(name));

    port.send("user.joined", { name: "justin" });
    stop();
    port.send("user.joined", { name: "nobody" });

    expect(heard).toEqual(["justin"]);
  });

  test("every listener hears, and a message with no data needs none", () => {
    const port = connect<App>();
    let ticks = 0;
    port.on("tick", () => ticks++);
    port.on("tick", () => ticks++);
    port.send("tick");
    expect(ticks).toBe(2);
  });

  test("a handler given twice listens twice, and each stop is its own", () => {
    const port = connect<App>();
    let ticks = 0;
    const handler = () => ticks++;
    const stop = port.on("tick", handler);
    port.on("tick", handler);

    port.send("tick");
    expect(ticks).toBe(2);

    stop();
    port.send("tick");
    expect(ticks).toBe(3);
  });

  test("once resolves with the next message only", async () => {
    const port = connect<App>();
    const next = port.once("user.joined");
    port.send("user.joined", { name: "first" });
    port.send("user.joined", { name: "second" });
    expect(await next).toEqual({ name: "first" });
  });

  test("ask gets what answer returns, sync or async", async () => {
    const port = connect<App>();
    port.answer("sum", ({ a, b }) => a + b);
    port.answer("shout", async (text) => text.toUpperCase());
    port.answer("now", () => 42);

    expect(await port.ask("sum", { a: 2, b: 3 })).toBe(5);
    expect(await port.ask("shout", "hey")).toBe("HEY");
    expect(await port.ask("now")).toBe(42);
  });

  test("a question takes one answerer per port, and it can step down", async () => {
    const port = connect<App>();
    const stop = port.answer("now", () => 1);
    expect(() => port.answer("now", () => 2)).toThrow(/already has an answer/);

    stop();
    port.answer("now", () => 2);
    expect(await port.ask("now")).toBe(2);
  });

  test("asking with nobody to answer fails straight away", async () => {
    const port = connect<App>();
    const error = await failure(port.ask("now"));
    expect(error).toBeInstanceOf(PortError);
    expect(error?.code).toBe("unanswered");
  });

  test("an error thrown while answering reaches the asker", async () => {
    const port = connect<App>();
    port.answer("fail", (reason) => {
      throw Object.assign(new RangeError(reason), { code: "E_NOPE" });
    });

    const error = await failure(port.ask("fail", "too big"));
    expect(error?.name).toBe("RangeError");
    expect(error?.message).toBe("too big");
    expect(error?.code).toBe("E_NOPE");
  });

  test("a handler that throws goes to onError and spares the others", async () => {
    const errors: unknown[] = [];
    const port = connect<App>([], { onError: (error) => errors.push(error) });
    let reached = false;
    port.on("tick", () => {
      throw new Error("sync");
    });
    port.on("tick", async () => {
      throw new Error("async");
    });
    port.on("tick", () => {
      reached = true;
    });

    port.send("tick");
    await wait(0);

    expect(reached).toBe(true);
    expect(errors.map((error) => (error as Error).message)).toEqual(["sync", "async"]);
  });

  test("without a contract, anything goes", async () => {
    const port = connect();
    port.answer("double", (n) => n * 2);
    port.on("anything", () => {});
    port.send("anything", { at: "all" });
    expect(await port.ask("double", 21)).toBe(42);
  });
});

describe("ports on one hub", () => {
  test("a message reaches the other port, and the sender hears it once", () => {
    const hub = memory();
    const a = connect<App>(hub);
    const b = connect<App>(hub);
    const heard: string[] = [];
    a.on("user.joined", ({ name }) => heard.push(`a:${name}`));
    b.on("user.joined", ({ name }) => heard.push(`b:${name}`));

    a.send("user.joined", { name: "justin" });

    expect(heard.sort()).toEqual(["a:justin", "b:justin"]);
  });

  test("ask crosses to whoever answers", async () => {
    const hub = memory();
    const a = connect<App>(hub);
    const b = connect<App>(hub);
    b.answer("sum", ({ a, b }) => a + b);
    expect(await a.ask("sum", { a: 20, b: 22 })).toBe(42);
  });

  test("an error crosses with its name, message and code", async () => {
    const hub = memory();
    const a = connect<App>(hub);
    const b = connect<App>(hub);
    b.answer("fail", (reason) => {
      throw Object.assign(new TypeError(reason), { code: 7 });
    });

    const error = await failure(a.ask("fail", "wrong shape"));
    expect(error?.name).toBe("TypeError");
    expect(error?.message).toBe("wrong shape");
    expect(error?.code).toBe(7);
  });

  test("the stack comes too, unless the answerer keeps it", async () => {
    const hub = memory();
    const a = connect<App>(hub);
    const open = connect<App>(hub);
    open.answer("fail", function exploding(reason) {
      throw new Error(reason);
    });
    expect((await failure(a.ask("fail", "boom")))?.stack).toContain("exploding");

    open.close();
    const guarded = connect<App>(hub, { stacks: false });
    guarded.answer("fail", function exploding(reason) {
      throw new Error(reason);
    });
    const error = await failure(a.ask("fail", "boom"));
    expect(error?.message).toBe("boom");
    expect(error?.stack).not.toContain("exploding");
  });

  test("ask times out when nobody answers", async () => {
    const hub = memory();
    const a = connect<App>(hub, { timeout: 20 });
    connect<App>(hub);

    const byDefault = await failure(a.ask("now"));
    expect(byDefault).toBeInstanceOf(PortError);
    expect(byDefault?.code).toBe("timeout");

    const started = Date.now();
    const perCall = await failure(a.ask("sum", { a: 1, b: 1 }, { timeout: 60 }));
    expect(perCall?.code).toBe("timeout");
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  test("timeout 0 waits as long as it takes", async () => {
    const hub = memory();
    const a = connect<App>(hub, { timeout: 0 });
    const b = connect<App>(hub);
    b.answer("shout", async (text) => {
      await wait(40);
      return text.toUpperCase();
    });
    expect(await a.ask("shout", "patience")).toBe("PATIENCE");
  });

  test("the first answer wins when two ports answer", async () => {
    const hub = memory();
    const a = connect<App>(hub);
    const b = connect<App>(hub);
    const c = connect<App>(hub);
    b.answer("now", () => 1);
    c.answer("now", async () => {
      await wait(20);
      return 2;
    });
    expect(await a.ask("now")).toBe(1);
    await wait(30); // the late answer arrives and is dropped quietly
  });

  test("channels keep ports apart", async () => {
    const hub = memory();
    const a = connect<App>(hub, { channel: "one", timeout: 20 });
    const b = connect<App>(hub, { channel: "two" });
    let heard = false;
    b.on("tick", () => (heard = true));
    b.answer("now", () => 1);

    a.send("tick");

    expect(heard).toBe(false);
    expect((await failure(a.ask("now")))?.code).toBe("timeout");
  });

  test("things that aren't frames are ignored", () => {
    const hub = memory();
    const port = connect<App>(hub);
    let ticks = 0;
    port.on("tick", () => ticks++);

    for (const junk of ["hello", "{not json", '{"some":"json"}', 42, null, undefined, { kind: "send" }]) {
      hub.send(junk as unknown as Frame);
    }

    expect(ticks).toBe(0);
  });

  test("a frame can arrive as JSON text", async () => {
    const sent: Frame[] = [];
    const link = custom((frame) => sent.push(frame));
    const port = connect<App>(link);
    const heard: string[] = [];
    port.on("user.joined", ({ name }) => heard.push(name));
    port.answer("sum", ({ a, b }) => a + b);

    link.receive(JSON.stringify({ channel: "main", id: "x#1", from: "x", kind: "send", name: "user.joined", data: { name: "wire" } }));
    link.receive(JSON.stringify({ channel: "main", id: "x#2", from: "x", kind: "ask", name: "sum", data: { a: 1, b: 2 } }));
    await wait(0);

    expect(heard).toEqual(["wire"]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "answer", name: "sum", to: "x#2", data: 3 });
  });

  test("a frame seen twice is handled once", () => {
    const link = custom(() => {});
    const port = connect<App>(link);
    let ticks = 0;
    port.on("tick", () => ticks++);

    const frame = { channel: "main", id: "x#1", from: "x", kind: "send", name: "tick" };
    link.receive(frame);
    link.receive(frame);

    expect(ticks).toBe(1);
  });

  test("tap sees every frame, both ways", async () => {
    const hub = memory();
    const seen: string[] = [];
    const a = connect<App>(hub, { name: "a", tap: (frame, direction) => seen.push(`${direction} ${frame.kind} ${frame.name} from ${frame.from}`) });
    const b = connect<App>(hub, { name: "b" });
    b.answer("now", () => 1);

    a.send("tick");
    b.send("tick");
    await a.ask("now");

    expect(seen).toEqual(["out send tick from a", "in send tick from b", "out ask now from a", "in answer now from b"]);
  });

  test("a tap that throws goes to onError and stops nothing", async () => {
    const hub = memory();
    const errors: unknown[] = [];
    const a = connect<App>(hub, {
      tap: () => {
        throw new Error("tap");
      },
      onError: (error) => errors.push(error),
    });
    const b = connect<App>(hub);
    b.answer("now", () => 1);
    let ticks = 0;
    a.on("tick", () => ticks++);

    a.send("tick");
    b.send("tick");

    expect(ticks).toBe(2);
    expect(await a.ask("now")).toBe(1);
    expect(errors).toHaveLength(4); // two sends, the ask and its answer
  });

  test("ports that share a name are still told apart", () => {
    const hub = memory();
    const first = connect<App>(hub, { name: "worker" });
    const second = connect<App>(hub, { name: "worker" });
    const listener = connect<App>(hub);
    const heard: string[] = [];
    listener.on("user.joined", ({ name }) => heard.push(name));

    first.send("user.joined", { name: "one" });
    second.send("user.joined", { name: "two" });

    expect(heard).toEqual(["one", "two"]);
  });

  test("handlers get the frame as well", () => {
    const hub = memory();
    const a = connect<App>(hub, { name: "sender" });
    const b = connect<App>(hub);
    let from = "";
    b.on("tick", (_, frame) => (from = frame.from));
    a.send("tick");
    expect(from).toBe("sender");
  });
});

describe("relay", () => {
  /** left — middle — right, where only the middle touches both hubs. */
  const line = (relay: boolean) => {
    const west = memory();
    const east = memory();
    return {
      left: connect<App>(west, { timeout: 30 }),
      middle: connect<App>([west, east], { relay }),
      right: connect<App>(east),
    };
  };

  test("without it, a port keeps its adapters apart", async () => {
    const { left, right } = line(false);
    let heard = false;
    right.on("tick", () => (heard = true));
    right.answer("now", () => 1);

    left.send("tick");

    expect(heard).toBe(false);
    expect((await failure(left.ask("now")))?.code).toBe("timeout");
  });

  test("with it, messages and questions pass through the middle", async () => {
    const { left, middle, right } = line(true);
    const heard: string[] = [];
    middle.on("user.joined", ({ name }) => heard.push(`middle:${name}`));
    right.on("user.joined", ({ name }) => heard.push(`right:${name}`));
    right.answer("sum", ({ a, b }) => a + b);

    left.send("user.joined", { name: "justin" });

    expect(heard).toEqual(["middle:justin", "right:justin"]);
    expect(await left.ask("sum", { a: 1, b: 2 })).toBe(3);
  });

  test("a hub that can answer does, and passes the question no further", async () => {
    const { left, middle, right } = line(true);
    let asked = 0;
    middle.answer("now", () => 1);
    right.answer("now", () => {
      asked++;
      return 2;
    });

    expect(await left.ask("now")).toBe(1);
    expect(asked).toBe(0);
  });

  test("a ring of relays delivers once instead of looping", async () => {
    const [ab, bc, ca] = [memory(), memory(), memory()];
    const a = connect<App>([ab, ca], { relay: true });
    const b = connect<App>([ab, bc], { relay: true });
    const c = connect<App>([bc, ca], { relay: true });
    let ticks = 0;
    b.on("tick", () => ticks++);
    c.on("tick", () => ticks++);
    c.answer("now", () => 3);

    a.send("tick");

    expect(ticks).toBe(2);
    expect(await a.ask("now")).toBe(3);
  });
});

describe("an adapter whose other side has gone", () => {
  /** An adapter that goes nowhere, with a handle on the `gone` its port gave it. */
  const link = () => {
    const sent: Frame[] = [];
    let leave = () => {};
    const adapter: Adapter = { send: (frame) => void sent.push(frame), listen: (_, gone) => void (leave = gone) };
    return { adapter, sent, leave: () => leave() };
  };

  test("fails the asks waiting on it, and later ones straight away", async () => {
    const only = link();
    const port = connect<App>(only.adapter, { timeout: 0 });
    const pending = failure(port.ask("now"));

    only.leave();

    expect(await pending).toBeInstanceOf(PortError);
    expect((await pending)?.code).toBe("disconnected");
    expect((await failure(port.ask("now")))?.code).toBe("disconnected");
  });

  test("gets nothing more sent through it", () => {
    const only = link();
    const port = connect<App>(only.adapter);

    port.send("tick");
    only.leave();
    port.send("tick");

    expect(only.sent).toHaveLength(1);
  });

  test("an ask keeps waiting while another adapter could still answer", async () => {
    const [first, second] = [link(), link()];
    const port = connect<App>([first.adapter, second.adapter], { timeout: 0 });
    let settled = false;
    const pending = failure(port.ask("now")).finally(() => (settled = true));

    first.leave();
    await wait(10);
    expect(settled).toBe(false);

    second.leave();
    expect((await pending)?.code).toBe("disconnected");
  });

  test("what the port answers itself is untouched", async () => {
    const only = link();
    const port = connect<App>(only.adapter);
    port.answer("shout", async (text) => {
      await wait(20);
      return text.toUpperCase();
    });
    const pending = port.ask("shout", "still here");

    only.leave();

    expect(await pending).toBe("STILL HERE");
    expect(await port.ask("shout", "and after")).toBe("AND AFTER");
  });
});

describe("close", () => {
  test("fails the asks still waiting", async () => {
    const hub = memory();
    const a = connect<App>(hub);
    connect<App>(hub);

    const pending = failure(a.ask("now"));
    a.close();

    expect((await pending)?.code).toBe("closed");
    expect((await failure(a.ask("now")))?.code).toBe("closed");
  });

  test("fails a once still waiting", async () => {
    const port = connect<App>();
    const pending = failure(port.once("tick"));

    port.close();

    expect(await pending).toBeInstanceOf(PortError);
    expect((await pending)?.code).toBe("closed");
    expect((await failure(port.once("tick")))?.code).toBe("closed");
  });

  test("an adapter that fails to stop doesn't stop the rest", async () => {
    const errors: unknown[] = [];
    const stubborn = {
      send: () => {},
      listen: () => () => {
        throw new Error("stuck");
      },
    };
    const port = connect<App>([stubborn, memory()], { onError: (error) => errors.push(error) });
    const pending = failure(port.ask("now"));

    port.close();

    expect((await pending)?.code).toBe("closed");
    expect(errors).toHaveLength(1);
  });

  test("goes quiet in both directions", () => {
    const hub = memory();
    const a = connect<App>(hub);
    const b = connect<App>(hub);
    let heard = 0;
    a.on("tick", () => heard++);
    b.on("tick", () => heard++);

    a.close();
    a.send("tick"); // a no-op now
    b.send("tick"); // b still hears itself

    expect(heard).toBe(1);
    a.close(); // closing twice is fine
  });

  test("an answer that lands after closing is dropped", async () => {
    const hub = memory();
    const a = connect<App>(hub);
    const b = connect<App>(hub);
    b.answer("shout", async (text) => {
      await wait(20);
      return text;
    });

    const pending = failure(a.ask("shout", "late"));
    b.close();
    await wait(40);
    a.close();

    expect((await pending)?.code).toBe("closed");
  });
});
