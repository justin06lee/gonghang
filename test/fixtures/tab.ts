// A worker that never touches its parent: it only knows a BroadcastChannel name.
import { broadcast, connect } from "../../src/index.ts";
import type { App } from "../contract.ts";

const port = connect<App>(broadcast("공항-test"));
port.answer("sum", ({ a, b }) => a + b);
port.send("note", "tab is up");
