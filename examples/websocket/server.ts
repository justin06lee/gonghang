// bun examples/websocket/server.ts      (then run client.ts in another terminal)
import { connect, custom, type Port } from "../../src/index.ts";
import type { Kitchen } from "../contract.ts";

type Seat = { link: ReturnType<typeof custom>; port: Port<Kitchen> };
const menu: Record<string, number> = { bibimbap: 12, kimbap: 6 };

const server = Bun.serve<Seat>({
  port: Number(process.env.PORT ?? 4117),
  fetch(request, server) {
    return server.upgrade(request, { data: {} as Seat }) ? undefined : new Response("this is a websocket", { status: 426 });
  },
  websocket: {
    // One port per connection: whatever this port sends goes to this client only.
    open(ws) {
      const link = custom((frame) => ws.send(JSON.stringify(frame)));
      const port = connect<Kitchen>(link);
      port.answer("price", (dish) => menu[dish] ?? 0);
      port.on("order.placed", (order) => {
        setTimeout(() => port.send("order.ready", order), 200);
      });
      ws.data = { link, port };
    },
    message(ws, message) {
      ws.data.link.receive(message);
    },
    close(ws) {
      ws.data.port.close();
    },
  },
});

console.log(`kitchen open on ws://localhost:${server.port}`);
