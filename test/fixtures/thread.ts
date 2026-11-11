// A node worker thread: talks to whoever made it through `parentPort`.
import { parentPort } from "node:worker_threads";
import { connect, worker } from "../../src/index.ts";
import type { App } from "../contract.ts";

const port = connect<App>(worker(parentPort!));
port.answer("sum", ({ a, b }) => a + b);
port.on("user.joined", ({ name }) => port.send("note", `welcome ${name}`));
