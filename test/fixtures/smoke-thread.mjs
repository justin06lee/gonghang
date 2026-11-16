// The far end of the worker-thread check in ../smoke.mjs.
import { parentPort } from "node:worker_threads";
import { connect, worker } from "../../dist/index.js";

const port = connect(worker(parentPort));
port.answer("sum", ({ a, b }) => a + b);
