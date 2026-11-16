/**
 * 공항 (gonghang, "airport") — tiny typed messaging between components.
 *
 *   1. Write one contract type that every component shares.
 *   2. Each component calls connect<Contract>() and gets a port.
 *   3. Ports talk: send / on for messages, ask / answer for questions.
 *   4. An adapter carries it across a boundary: a worker, a socket, a process.
 *
 * No dependencies. This one file is the whole library, so you can install the
 * package or just copy the file into a project.
 */

// ─── The contract ────────────────────────────────────────────────────────────
//
//   type App = {
//     "user.joined": { name: string };                      // a message
//     "sum": (input: { a: number; b: number }) => number;   // a question
//   };
//
// A function is a question: someone asks it, someone answers it.
// Anything else is a message: someone sends it, everyone listening hears it.

type Fn = (...args: any[]) => any;
type IsAny<T> = 0 extends 1 & T ? true : false;

/** The contract you get when you don't write one: any name, any shape. */
export type Loose = Record<string, any>;

/** The names in a contract that are messages. */
export type MessageName<C> = { [K in keyof C & string]-?: C[K] extends Fn ? never : K }[keyof C & string];

/** The names in a contract that are questions. */
export type QuestionName<C> = { [K in keyof C & string]-?: C[K] extends Fn ? K : never }[keyof C & string];

/** What you hand over when you ask a question: its one parameter. */
export type Input<Q> = IsAny<Q> extends true
  ? any
  : Q extends (...args: infer A) => any
    ? A extends [] | [unknown?]
      ? A[0]
      : OneInput
    : never;

/** What an input becomes when the contract gives a question several parameters, so the mistake shows up wherever it is used. */
type OneInput = "공항: a question takes one input, so put several values in one object";

/** What comes back from a question: its return type, promises unwrapped. */
export type Output<Q> = IsAny<Q> extends true ? any : Q extends (...args: any[]) => infer R ? Awaited<R> : never;

/** `[data]`, or nothing at all when there is nothing to pass. */
type Args<T, More extends unknown[] = []> = undefined extends T ? [data?: T, ...more: More] : [data: T, ...more: More];

// ─── The pieces ──────────────────────────────────────────────────────────────

/**
 * What actually travels. Plain data, so it survives JSON and structured clone,
 * and so a component written in another language can speak it too.
 */
export interface Frame {
  /** Which channel it belongs to. Ports ignore frames from other channels. */
  channel: string;
  /** Unique for every frame. */
  id: string;
  /** The name of the port that made it. */
  from: string;
  /** `send` is a message, `ask` is a question, `answer` is the reply to one. */
  kind: "send" | "ask" | "answer";
  /** The contract name. */
  name: string;
  /** The message, the question's input, or the answer. */
  data?: unknown;
  /** On an answer: the id of the ask it answers. */
  to?: string;
  /** On an answer: set when the handler threw instead of answering. */
  error?: { name: string; message: string; stack?: string; code?: unknown };
}

/**
 * How frames cross a boundary. Two functions, so writing your own is easy:
 *
 *   const adapter: Adapter = {
 *     send: (frame) => socket.write(JSON.stringify(frame) + "\n"),
 *     listen: (receive) => socket.on("data", (text) => receive(String(text))),
 *   };
 */
export interface Adapter {
  /** Push one frame out to the other side. */
  send(frame: Frame): void;
  /**
   * Start handing incoming frames to `receive`, either as objects or as the
   * JSON text of one. Anything that isn't a frame is ignored, so a transport
   * can be shared. Return a function that stops listening, if there is one.
   *
   * If you can tell when the other side has left for good, call `gone` then.
   * The port stops sending through this adapter, and asks that nothing could
   * answer any more fail at once instead of waiting out their timeout.
   */
  listen(receive: (frame: unknown) => void, gone: () => void): unknown;
}

export interface Options {
  /** Ports only hear ports on the same channel. Default `"main"`. */
  channel?: string;
  /** This port's name, stamped on every frame as `from`. Default: a random one. */
  name?: string;
  /**
   * How long `ask` waits for an answer, in milliseconds. `0` waits forever, and
   * so does anything over about 24 days, the longest a timer can run. Default `5000`.
   */
  timeout?: number;
  /** Pass frames along from one adapter to the others, which makes this port a hub. Default `false`. */
  relay?: boolean;
  /**
   * When an answer throws, send its stack trace to the asker along with the
   * error. Turn it off on a server whose clients shouldn't read it. Default `true`.
   */
  stacks?: boolean;
  /** See every frame this port sends out or takes in. Good for logging. */
  tap?: (frame: Frame, direction: "in" | "out") => void;
  /** Where errors thrown inside your `on` handlers, your `tap` and adapters go. Default: `console.error`. */
  onError?: (error: unknown) => void;
  /** Told when an adapter says its other side has left for good, with the adapter that said so. */
  onDisconnect?: (adapter: Adapter) => void;
}

/** Stops whatever the call that returned it started. */
export type Stop = () => void;

export interface Port<C = Loose> {
  /** Tell everyone something. Every port listening for it hears it, this one included. */
  send<K extends MessageName<C>>(name: K, ...data: Args<C[K]>): void;

  /** Hear a message every time anyone sends it. Call the returned function to stop. */
  on<K extends MessageName<C>>(name: K, handler: (data: C[K], frame: Frame) => void): Stop;

  /** Wait for the next time a message is sent. Rejects if the port closes first. */
  once<K extends MessageName<C>>(name: K): Promise<C[K]>;

  /** Ask a question and wait for whoever answers it. Rejects on a timeout, or with the error the answerer threw. */
  ask<K extends QuestionName<C>>(name: K, ...input: Args<Input<C[K]>, [options?: { timeout?: number }]>): Promise<Output<C[K]>>;

  /** Be the one that answers a question. Return the answer (or a promise of it); throw to fail the ask. */
  answer<K extends QuestionName<C>>(
    name: K,
    handler: (input: Input<C[K]>, frame: Frame) => Output<C[K]> | Promise<Output<C[K]>>,
  ): Stop;

  /** Stop listening, fail any ask or once still waiting, and let go of the adapters. */
  close(): void;
}

/** Why an ask failed without anyone answering it, or a once without its message arriving. */
export class PortError extends Error {
  /**
   * - `"timeout"`: nobody answered in time
   * - `"unanswered"`: there is nobody who could answer
   * - `"disconnected"`: the other side went away
   * - `"closed"`: the port closed first
   */
  code: "timeout" | "unanswered" | "disconnected" | "closed";

  constructor(code: PortError["code"], message: string) {
    super(`공항: ${message}`);
    this.name = "PortError";
    this.code = code;
  }
}

// ─── connect ─────────────────────────────────────────────────────────────────

/**
 * Open a port.
 *
 *   const port = connect<App>();                  // components in one process
 *   const port = connect<App>(worker(self));      // ...and across a boundary
 *   const port = connect<App>([a, b], { relay: true });   // a hub between two
 */
export function connect<C = Loose>(adapters: Adapter | Adapter[] = [], options: Options = {}): Port<C> {
  const channel = options.channel ?? "main";
  const key = Math.random().toString(36).slice(2, 10).padEnd(8, "0"); // keeps this port's frame ids its own
  const me = options.name ?? key;
  const patience = options.timeout ?? 5000;
  const onError = options.onError ?? ((error: unknown) => console.error("[공항]", error));
  const links = [adapters].flat();

  const listeners = new Map<string, Set<(data: any, frame: Frame) => unknown>>(); // name → who hears it
  const answerers = new Map<string, (input: any, frame: Frame) => unknown>(); // name → who answers it
  const waiting = new Map<string, Waiting>(); // ask id → the promise we owe
  const seen = new Set<string>(); // ids of frames already handled, so echoes and loops die here
  const onces = new Set<() => void>(); // how to fail each once() still waiting, should the port close
  const lost = new Set<Adapter>(); // adapters whose other side has left for good
  let count = 0;
  let closed = false;

  /** Show a frame to the tap. A tap only watches, so one that throws must not stop the frame. */
  const show = (f: Frame, direction: "in" | "out") => {
    try {
      options.tap?.(f, direction);
    } catch (error) {
      onError(error);
    }
  };

  /** Make a frame of ours, and show it to the tap. */
  const frame = (kind: Frame["kind"], name: string, rest: Partial<Frame>): Frame => {
    const made: Frame = { channel, id: `${key}#${++count}`, from: me, kind, name, ...rest };
    remember(made.id);
    show(made, "out");
    return made;
  };

  const remember = (id: string) => {
    seen.add(id);
    if (seen.size > 5000) seen.delete(seen.values().next().value as string); // forget the oldest
  };

  /**
   * Push a frame through one adapter, unless nobody is left on the other side
   * of it. Says whether the adapter took it; what it threw goes to `refused`.
   */
  const push = (link: Adapter, f: Frame, refused: (error: unknown) => void = onError): boolean => {
    if (lost.has(link)) return false;
    try {
      link.send(f);
      return true;
    } catch (error) {
      refused(error);
      return false;
    }
  };

  /** Push a frame through every adapter, except the one it came in on. */
  const out = (f: Frame, except?: Adapter) => {
    for (const link of links) if (link !== except) push(link, f);
  };

  /** Hand a message to everyone on this port listening for it. */
  const hear = (f: Frame) => {
    for (const listener of [...(listeners.get(f.name) ?? [])]) {
      try {
        const result = listener(f.data, f) as { then?: unknown } | undefined;
        if (typeof result?.then === "function") Promise.resolve(result).catch(onError);
      } catch (error) {
        onError(error);
      }
    }
  };

  /** Run an answer handler, then send back what it returned or what it threw. */
  const reply = async (question: Frame, handler: (input: any, frame: Frame) => unknown, link?: Adapter) => {
    let result: Partial<Frame>;
    try {
      result = { data: await handler(question.data, question) };
    } catch (error) {
      result = { error: describe(error, options.stacks ?? true) };
    }
    if (closed) return;
    const answer = frame("answer", question.name, { to: question.id, ...result });
    if (!link) return void settle(answer); // asked on this very port

    // Back the way the question came. An answer that can't make the trip must
    // not leave the asker waiting, so the reason goes back in its place.
    let why: unknown;
    if (push(link, answer, (error) => (why = error)) || lost.has(link)) return;
    onError(why);
    const { name, message } = describe(why, false);
    const sorry = { name, message: `the answer to "${question.name}" could not be sent: ${message}` };
    push(link, frame("answer", question.name, { to: question.id, error: sorry }), () => {});
  };

  /** An answer arrived: finish the ask that was waiting for it. */
  const settle = (answer: Frame): boolean => {
    const ask = waiting.get(answer.to ?? "");
    if (!ask) return false;
    waiting.delete(answer.to ?? "");
    clearTimeout(ask.timer);
    if (answer.error) ask.reject(revive(answer.error));
    else ask.resolve(answer.data);
    return true;
  };

  /** Something came in through an adapter. */
  const receive = (link: Adapter) => (raw: unknown) => {
    const f = read(raw);
    if (closed || !f || f.channel !== channel || seen.has(f.id)) return;
    remember(f.id);
    show(f, "in");

    if (f.kind === "send") hear(f);
    else if (f.kind === "ask") {
      const handler = answerers.get(f.name);
      if (handler) return void reply(f, handler, link).catch(onError); // ours to answer, so it stops here
    } else if (settle(f)) return; // the answer to our own ask, so it stops here

    if (options.relay) out(f, link);
  };

  /** An adapter says its other side has left. Once they all have, nothing can answer what we asked through them. */
  const lose = (link: Adapter) => () => {
    if (closed || lost.has(link)) return;
    lost.add(link);
    try {
      options.onDisconnect?.(link);
    } catch (error) {
      onError(error);
    }
    if (links.some((other) => !lost.has(other))) return; // an answer could still come another way
    for (const [id, ask] of waiting) {
      if (!ask.away) continue; // this port is answering it itself
      waiting.delete(id);
      clearTimeout(ask.timer);
      ask.reject(new PortError("disconnected", "the other side went away before an answer came"));
    }
  };

  const stops = links.map((link) => link.listen(receive(link), lose(link)));

  const port = {
    send(name: string, data?: unknown) {
      if (closed) return;
      const f = frame("send", name, { data });
      out(f);
      hear(f);
    },

    on(name: string, handler: (data: any, frame: Frame) => unknown) {
      const set = listeners.get(name) ?? new Set();
      const listener = (data: unknown, frame: Frame) => handler(data, frame); // one per call, so a handler can listen twice
      listeners.set(name, set.add(listener));
      return () => void set.delete(listener);
    },

    once(name: string) {
      return new Promise((resolve, reject) => {
        if (closed) return reject(new PortError("closed", `waited for "${name}" on a closed port`));
        const fail = () => reject(new PortError("closed", `the port closed before "${name}" came`));
        const stop = port.on(name, (data) => {
          stop();
          onces.delete(fail);
          resolve(data);
        });
        onces.add(fail);
      });
    },

    ask(name: string, input?: unknown, { timeout = patience }: { timeout?: number } = {}) {
      return new Promise((resolve, reject) => {
        if (closed) return reject(new PortError("closed", `asked "${name}" on a closed port`));
        const local = answerers.get(name);
        if (!local && !links.length) return reject(new PortError("unanswered", `nobody answers "${name}"`));
        if (!local && links.every((link) => lost.has(link))) {
          return reject(new PortError("disconnected", `asked "${name}" after the other side went away`));
        }

        const question = frame("ask", name, { data: input });
        const timer =
          timeout > 0 && timeout <= LONGEST_TIMER
            ? setTimeout(() => {
                waiting.delete(question.id);
                reject(new PortError("timeout", `no answer to "${name}" after ${timeout}ms`));
              }, timeout)
            : undefined;
        waiting.set(question.id, { resolve, reject, timer, away: !local });
        if (local) return void reply(question, local).catch(onError);

        // A question no adapter would take can never be answered: fail now, with the reason.
        const refused: unknown[] = [];
        let taken = 0;
        for (const link of links) if (push(link, question, (error) => refused.push(error))) taken++;
        if (taken) return refused.forEach(onError);
        if (!refused.length || !waiting.delete(question.id)) return; // the other side left as we asked, and the ask has been told
        clearTimeout(timer);
        reject(refused[0]);
      });
    },

    answer(name: string, handler: (input: any, frame: Frame) => unknown) {
      if (answerers.has(name)) throw new Error(`공항: "${name}" already has an answer on this port`);
      answerers.set(name, handler);
      return () => {
        if (answerers.get(name) === handler) answerers.delete(name);
      };
    },

    close() {
      if (closed) return;
      closed = true;
      for (const stop of stops) {
        try {
          if (typeof stop === "function") stop();
        } catch (error) {
          onError(error);
        }
      }
      for (const ask of waiting.values()) {
        clearTimeout(ask.timer);
        ask.reject(new PortError("closed", "the port closed before an answer came"));
      }
      waiting.clear();
      for (const fail of onces) fail();
      onces.clear();
      listeners.clear();
      answerers.clear();
    },
  };

  return port as Port<C>;
}

/** The longest a timer can run. Given more, it fires at once instead, which would fail an ask the moment it was made. */
const LONGEST_TIMER = 2 ** 31 - 1;

interface Waiting {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Whether the question went out through the adapters, rather than to an answerer on this port. */
  away: boolean;
}

/** Take a frame, or the JSON text of one. Anything else isn't ours. */
function read(raw: unknown): Frame | undefined {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  const f = raw as Frame | null;
  const isFrame =
    typeof f === "object" &&
    f !== null &&
    typeof f.channel === "string" &&
    typeof f.id === "string" &&
    typeof f.name === "string" &&
    (f.kind === "send" || f.kind === "ask" || f.kind === "answer");
  return isFrame ? f : undefined;
}

/** Turn whatever a handler threw into plain data that can travel. */
function describe(error: unknown, withStack: boolean): NonNullable<Frame["error"]> {
  if (!(error instanceof Error)) return { name: "Error", message: text(error) };
  const code = (error as { code?: unknown }).code;
  return {
    name: error.name,
    message: error.message,
    ...(withStack && error.stack ? { stack: error.stack } : {}),
    ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
  };
}

/** `String(value)`, for the values that refuse: an object with no prototype, say. */
function text(value: unknown): string {
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/** Turn it back into an Error on the asking side. */
function revive(described: NonNullable<Frame["error"]>): Error {
  const error = new Error(described.message) as Error & { code?: unknown };
  error.name = described.name;
  if (described.stack) error.stack = described.stack;
  if (described.code !== undefined) error.code = described.code;
  return error;
}

// ─── Adapters ────────────────────────────────────────────────────────────────

/**
 * A hub inside one process. Every port connected to the same one hears the
 * others. Handy for giving each component its own port, and for tests.
 *
 *   const hub = memory();
 *   const a = connect<App>(hub);
 *   const b = connect<App>(hub);
 */
export function memory(): Adapter {
  const receivers = new Set<(frame: unknown) => void>();
  return {
    send(frame) {
      for (const receive of [...receivers]) receive(frame);
    },
    listen(receive) {
      receivers.add(receive);
      return () => receivers.delete(receive);
    },
  };
}

/** Anything you can `postMessage` to. */
export interface Postable {
  postMessage(message: any): void;
  addEventListener?: (type: any, listener: (event: any) => void) => void;
  removeEventListener?: (type: any, listener: (event: any) => void) => void;
  on?: (type: any, listener: (message: any) => void) => unknown;
  off?: (type: any, listener: (message: any) => void) => unknown;
  start?: () => void;
}

/**
 * The other side of a `postMessage`: a Worker, `self` inside one, a
 * MessagePort, or `parentPort` and Worker from node's worker_threads.
 *
 *   const port = connect<App>(worker(new Worker("./worker.ts")));   // outside
 *   const port = connect<App>(worker(self));                        // inside
 */
export function worker(target: Postable): Adapter {
  return {
    send(frame) {
      target.postMessage(frame);
    },
    listen(receive, gone) {
      if (target.addEventListener) {
        const onMessage = (event: { data: unknown }) => receive(event.data);
        target.addEventListener("message", onMessage);
        target.addEventListener("close", gone); // a MessagePort or a bun Worker; in browsers and deno a Worker never says
        target.start?.(); // a MessagePort stays quiet until started
        return () => {
          target.removeEventListener?.("message", onMessage);
          target.removeEventListener?.("close", gone);
        };
      }
      target.on?.("message", receive);
      target.on?.("exit", gone); // a Worker from node's worker_threads
      target.on?.("close", gone);
      return () => {
        target.off?.("message", receive);
        target.off?.("exit", gone);
        target.off?.("close", gone);
      };
    },
  };
}

/**
 * Everything on the same BroadcastChannel name: other tabs, iframes and
 * workers in a browser, other worker threads in bun, node and deno.
 *
 *   const port = connect<App>(broadcast("my-app"));
 */
export function broadcast(name = "공항"): Adapter {
  const channel = new BroadcastChannel(name);
  return {
    send(frame) {
      channel.postMessage(frame);
    },
    listen(receive) {
      channel.addEventListener("message", (event: { data: unknown }) => receive(event.data));
      return () => channel.close();
    },
  };
}

/** A WebSocket, or anything shaped like one. */
export interface Socket {
  readyState: number;
  send(text: string): void;
  addEventListener(type: any, listener: (event: any) => void): void;
  removeEventListener(type: any, listener: (event: any) => void): void;
}

/**
 * The other end of a WebSocket. Frames travel as JSON text, and anything sent
 * before the socket opens waits for it.
 *
 *   const port = connect<App>(websocket(new WebSocket("ws://localhost:3000")));
 */
export function websocket(socket: Socket): Adapter {
  const early: string[] = [];
  return {
    send(frame) {
      const text = JSON.stringify(frame);
      if (socket.readyState === 0) early.push(text);
      else socket.send(text);
    },
    listen(receive, gone) {
      const onOpen = () => {
        for (const text of early.splice(0)) socket.send(text);
      };
      const onMessage = (event: { data: unknown }) => receive(event.data);
      socket.addEventListener("open", onOpen);
      socket.addEventListener("message", onMessage);
      socket.addEventListener("close", gone);
      if (socket.readyState === 3) gone(); // it had already closed when we got it
      return () => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("close", gone);
      };
    },
  };
}

/** Something to read text from: a node stream, or a web ReadableStream. */
export type Readable =
  | { on(event: any, listener: (chunk: any) => void): unknown; off(event: any, listener: (chunk: any) => void): unknown }
  | { getReader(): { read(): Promise<{ done: boolean; value?: any }>; releaseLock(): void } };

/** Something to write text to: a node stream, a bun FileSink, or a web WritableStream. */
export type Writable =
  | {
      write(text: string): unknown;
      flush?: () => unknown;
      on?: (event: any, listener: (error: any) => void) => unknown;
      off?: (event: any, listener: (error: any) => void) => unknown;
    }
  | { getWriter(): { write(chunk: Uint8Array): unknown } };

/**
 * One frame of JSON per line, over any pair of streams: a child process's
 * stdin and stdout, a TCP or unix socket, a pipe. Lines that aren't frames
 * (a stray log, say) are skipped, and the other side can be any language.
 *
 *   const port = connect<App>(lines(child.stdout, child.stdin));      // parent
 *   const port = connect<App>(lines(process.stdin, process.stdout));  // child
 *   const port = connect<App>(lines(socket));                         // both ways on one
 *
 * A line longer than `limit` characters is skipped as well, so a peer that
 * never ends its line cannot fill your memory. Default: 64 million.
 */
export function lines(
  input: Readable,
  output: Writable = input as unknown as Writable,
  { limit = 64 * 1024 * 1024 }: { limit?: number } = {},
): Adapter {
  const writer = "getWriter" in output ? output.getWriter() : undefined;
  const encoder = new TextEncoder();
  return {
    send(frame) {
      const line = JSON.stringify(frame) + "\n";
      if (writer) Promise.resolve(writer.write(encoder.encode(line))).catch(() => {}); // the stream closed under us
      else if ("write" in output) {
        output.write(line);
        if (typeof output.flush === "function") output.flush(); // a bun FileSink holds text until flushed
      }
    },
    listen(receive, gone) {
      const decoder = new TextDecoder();
      let rest = ""; // the line still arriving
      let outgrown = false; // it passed the limit, so what is left of it is dropped as it comes

      /** The line still arriving is complete: hand it over, unless it is blank or outgrew the limit. */
      const end = () => {
        if (!outgrown && /\S/.test(rest)) receive(rest);
        rest = "";
        outgrown = false;
      };

      // Only the new text is searched for line ends, so a long line costs no more per chunk than a short one.
      const feed = (chunk: string | Uint8Array) => {
        const parts = (typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })).split("\n");
        parts.forEach((part, index) => {
          if (index) end(); // every "\n" ends the line before it
          if (outgrown) return;
          rest += part;
          if (rest.length > limit) {
            rest = "";
            outgrown = true;
          }
        });
      };

      if ("getReader" in input) {
        const reader = input.getReader();
        let reading = true;
        (async () => {
          while (reading) {
            const { done, value } = await reader.read();
            if (done) break;
            feed(value);
          }
        })()
          .catch(() => {}) // a stream that breaks has ended just the same
          .then(() => {
            if (!reading) return;
            end(); // a last line with no newline after it still counts
            gone();
          });
        return () => {
          reading = false;
          try {
            reader.releaseLock();
          } catch {}
        };
      }

      // A node stream is over when it ends, closes or fails, and a broken pipe shows up on the writing side.
      let over = false;
      const ended = () => {
        over = true;
        end(); // a last line with no newline after it still counts
        gone();
      };
      const sink = "write" in output && output !== (input as unknown) ? output : undefined;
      input.on("data", feed);
      for (const event of ["end", "close", "error"]) input.on(event, ended);
      sink?.on?.("error", ended);
      return () => {
        input.off("data", feed);
        for (const event of ["end", "close"]) input.off(event, ended);
        if (over) return; // a stream that died can still fail a write made just before, and in node an unheard "error" ends the process
        input.off("error", ended);
        sink?.off?.("error", ended);
      };
    },
  };
}

/**
 * For transports that hand you messages somewhere you can't put a listener:
 * a server's message callback, an Electron IPC handler, a webhook. You say
 * how to send, and call `receive` yourself whenever something arrives, and
 * `gone` if the transport tells you the other side has left.
 *
 *   const link = custom((frame) => ws.send(JSON.stringify(frame)));
 *   const port = connect<App>(link);
 *   // ...later, wherever messages show up:
 *   link.receive(message);
 */
export function custom(send: (frame: Frame) => void): Adapter & { receive(frame: unknown): void; gone(): void } {
  const hub = memory();
  const told = new Set<() => void>(); // one per port listening: how to say the other side has left
  return {
    send,
    listen(receive, gone) {
      const stop = hub.listen(receive, gone) as Stop;
      told.add(gone);
      return () => {
        told.delete(gone);
        stop();
      };
    },
    receive: hub.send as (frame: unknown) => void,
    gone() {
      for (const gone of [...told]) gone();
    },
  };
}
