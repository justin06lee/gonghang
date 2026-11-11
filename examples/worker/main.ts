// bun examples/worker/main.ts
import { connect, worker } from "../../src/index.ts";
import type { Kitchen } from "../contract.ts";

const thread = new Worker(new URL("./worker.ts", import.meta.url));
const port = connect<Kitchen>(worker(thread));

port.on("order.ready", ({ table, dish }) => {
  console.log(`table ${table}: ${dish} is ready`);
  port.close();
  thread.terminate();
});

console.log("bibimbap costs", await port.ask("price", "bibimbap"));
port.send("order.placed", { table: 4, dish: "bibimbap" });
