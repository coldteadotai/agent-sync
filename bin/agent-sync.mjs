#!/usr/bin/env node
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < 20 || (major === 20 && minor < 6)) {
  console.error(`agent-sync requires Node 20.6 or newer; you are running ${process.versions.node}.`);
  process.exit(2);
}

for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error) => {
    if (error && error.code === "EPIPE") {
      process.exit(typeof process.exitCode === "number" ? process.exitCode : 0);
    }
    throw error;
  });
}

const { runCli } = await import("../dist/main.js");
process.exitCode = await runCli(process.argv.slice(2));
