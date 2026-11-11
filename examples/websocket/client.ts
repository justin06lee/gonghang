// bun examples/websocket/client.ts
import { connect, websocket } from "../../src/index.ts";
import type { Kitchen } from "../contract.ts";

const socket = new WebSocket(`ws://localhost:${process.env.PORT ?? 4117}`);
const port = connect<Kitchen>(websocket(socket));

port.on("order.ready", ({ table, dish }) => {
  console.log(`table ${table}: ${dish} is ready`);
  port.close();
  socket.close();
});

// No need to wait for the socket to open: early frames wait for it.
console.log("bibimbap costs", await port.ask("price", "bibimbap"));
port.send("order.placed", { table: 2, dish: "bibimbap" });
