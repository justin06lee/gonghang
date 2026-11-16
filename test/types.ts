// Not run: `bun run typecheck` compiles this, and that is the whole test.
// Each @ts-expect-error line fails the build if the mistake under it stops being one.

import { connect, type Port } from "../src/index.ts";
import type { App } from "./contract.ts";

type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const same = <A, B>(_: Same<A, B>) => {};

export async function typed(port: Port<App>) {
  // Messages carry exactly the data the contract says.
  port.send("user.joined", { name: "justin" });
  port.send("tick");
  port.send("note");
  port.send("note", "optional data may be given");
  // @ts-expect-error the data is required
  port.send("user.joined");
  // @ts-expect-error the data has the wrong shape
  port.send("user.joined", { nome: "justin" });
  // @ts-expect-error not in the contract
  port.send("user.left", { name: "justin" });
  // @ts-expect-error a question is asked, not sent
  port.send("sum", { a: 1, b: 2 });

  port.on("user.joined", (data) => same<typeof data, { name: string }>(true));
  port.on("note", (data) => same<typeof data, string | undefined>(true));
  // @ts-expect-error a question is answered, not listened to
  port.on("sum", () => {});
  same<Awaited<ReturnType<typeof port.once<"user.joined">>>, { name: string }>(true);

  // Questions take the contract's input and give back its output.
  same<Awaited<ReturnType<typeof port.ask<"sum">>>, number>(true);
  same<Awaited<ReturnType<typeof port.ask<"shout">>>, string>(true); // the promise is unwrapped
  await port.ask("sum", { a: 1, b: 2 });
  await port.ask("sum", { a: 1, b: 2 }, { timeout: 100 });
  await port.ask("now");
  await port.ask("now", undefined, { timeout: 100 });
  // @ts-expect-error the input is required
  await port.ask("sum");
  // @ts-expect-error the input has the wrong shape
  await port.ask("sum", { a: 1 });
  // @ts-expect-error a message is sent, not asked
  await port.ask("tick");

  port.answer("sum", (input) => {
    same<typeof input, { a: number; b: number }>(true);
    return input.a + input.b;
  });
  port.answer("shout", (text) => text.toUpperCase()); // an async question may be answered plainly
  port.answer("shout", async (text) => text.toUpperCase());
  // @ts-expect-error the answer has the wrong type
  port.answer("sum", () => "three");
  // @ts-expect-error a message is listened to, not answered
  port.answer("tick", () => {});
}

// A contract can be an interface as well as a type alias.
interface Shop {
  "order.placed": { id: string };
  price: (sku: string) => number;
}

export async function withInterface() {
  const port = connect<Shop>();
  port.send("order.placed", { id: "a1" });
  same<Awaited<ReturnType<typeof port.ask<"price">>>, number>(true);
  // @ts-expect-error not in the contract
  port.send("order.cancelled", { id: "a1" });
}

// A question takes one input. A contract that gives one several is caught wherever it is used.
interface Crowded {
  add: (a: number, b: number) => number;
  join: (...parts: string[]) => string;
}

export async function oneInput(port: Port<Crowded>) {
  // @ts-expect-error only the first parameter would ever travel
  await port.ask("add", 1);
  // @ts-expect-error a rest parameter is several inputs too
  await port.ask("join", "a");
  // @ts-expect-error the answerer is told as well
  port.answer("add", (a) => a + 1);
}

// With no contract, every name and every shape is allowed.
export async function loose() {
  const port = connect();
  port.send("anything");
  port.send("anything", { at: "all" });
  port.on("anything", (data) => data.whatever);
  port.answer("double", (n) => n * 2);
  const result = await port.ask("double", 21);
  await port.ask("double");
  await port.ask("double", 21, { timeout: 100 });
  result.toFixed();
}
