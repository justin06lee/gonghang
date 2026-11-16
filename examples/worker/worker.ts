import { connect, worker } from "../../src/index.ts";
import type { Kitchen } from "../contract.ts";

const port = connect<Kitchen>(worker(self));

const menu = new Map([["bibimbap", 12], ["kimbap", 6]]);
port.answer("price", (dish) => menu.get(dish) ?? 0);

port.on("order.placed", (order) => {
  setTimeout(() => port.send("order.ready", order), 200); // cooking takes a moment
});
