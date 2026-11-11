// A web-style worker: talks to whoever made it through `self`.
import { connect, worker } from "../../src/index.ts";
import type { App } from "../contract.ts";

const port = connect<App>(worker(self));
port.answer("sum", ({ a, b }) => a + b);
port.answer("fail", (reason) => {
  throw new RangeError(reason);
});
port.on("user.joined", ({ name }) => port.send("note", `welcome ${name}`));
