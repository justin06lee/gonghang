// A child process: frames on stdin and stdout, one per line.
import { connect, lines } from "../../src/index.ts";
import type { App } from "../contract.ts";

console.log("a stray log line, which the parent should skip");

const port = connect<App>(lines(process.stdin, process.stdout));
port.answer("sum", ({ a, b }) => a + b);
port.answer("shout", async (text) => text.toUpperCase());
port.on("user.joined", ({ name }) => port.send("note", `welcome ${name}`));
