// The other process. It could be written in anything that reads and writes
// lines of JSON; here it is the same library on the other end of the pipe.
import { connect, lines } from "../../src/index.ts";
import type { Kitchen } from "../contract.ts";

const port = connect<Kitchen>(lines(process.stdin, process.stdout));

const menu: Record<string, number> = { bibimbap: 12, kimbap: 6 };
port.answer("price", (dish) => menu[dish] ?? 0);

port.on("order.placed", (order) => {
  setTimeout(() => port.send("order.ready", order), 200);
});
