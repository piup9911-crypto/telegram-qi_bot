const { getLmcStatus } = require("./lmc-memory-store.cjs");

process.stdout.write(`${JSON.stringify(getLmcStatus(), null, 2)}\n`);
