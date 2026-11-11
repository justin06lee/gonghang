// bun examples/process/parent.ts
import { fileURLToPath } from "node:url";
import { connect, lines } from "../../src/index.ts";
import type { Kitchen } from "../contract.ts";

const child = Bun.spawn(["bun", fileURLToPath(new URL("./child.ts", import.meta.url))], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "inherit",
});
const port = connect<Kitchen>(lines(child.stdout, child.stdin));

port.on("order.ready", ({ table, dish }) => {
  console.log(`table ${table}: ${dish} is ready`);
  port.close();
  child.kill();
});

console.log("kimbap costs", await port.ask("price", "kimbap"));
port.send("order.placed", { table: 7, dish: "kimbap" });
