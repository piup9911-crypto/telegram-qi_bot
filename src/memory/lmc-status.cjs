const { getLmcStatus } = require("../memory/lmc-memory-store.cjs");

process.stdout.write(`${JSON.stringify(getLmcStatus(), null, 2)}\n`);
