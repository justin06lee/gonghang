// A forked child: frames over node's process IPC, through a hand-written adapter.
import { connect, type Adapter } from "../../src/index.ts";
import type { App } from "../contract.ts";

const parent: Adapter = {
  send: (frame) => void process.send?.(frame),
  listen: (receive) => {
    process.on("message", receive);
    return () => process.off("message", receive);
  },
};

const port = connect<App>(parent);
port.answer("sum", ({ a, b }) => a + b);
port.on("user.joined", ({ name }) => port.send("note", `welcome ${name}`));
