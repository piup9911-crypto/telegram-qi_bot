const { spawn } = require("child_process");

const customTarget = process.argv.find((arg) => arg.startsWith("--target="));
const wrapperPath = customTarget
  ? customTarget.slice("--target=".length)
  : "C:\\Users\\yx\\Documents\\New project\\telegram-mcp-wrapper.cjs";

const child = spawn("node", [wrapperPath], {
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
});

const stdoutLines = [];
const stderrLines = [];
let stdoutBuffer = "";
let stderrBuffer = "";
let sent = false;

const flushLines = (buffer, target) => {
  const parts = buffer.split(/\r?\n/);
  const trailing = parts.pop() ?? "";
  for (const part of parts) {
    if (part.length > 0) {
      target.push(part);
    }
  }
  return trailing;
};

child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");

child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk;
  stdoutBuffer = flushLines(stdoutBuffer, stdoutLines);
});

child.stderr.on("data", (chunk) => {
  stderrBuffer += chunk;
  stderrBuffer = flushLines(stderrBuffer, stderrLines);
  if (!sent && stderrLines.some((line) => line.includes("MCP Communicator server running"))) {
    sent = true;
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "probe", version: "1.0.0" },
      },
    });

    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });

    if (process.argv.includes("--notify")) {
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "notify_user",
          arguments: {
            message: "Telegram MCP probe from Codex.",
          },
        },
      });
    }
  }
});

child.on("error", (error) => {
  console.error(JSON.stringify({ event: "spawn_error", error: error.message }));
});

const send = (payload) => {
  child.stdin.write(JSON.stringify(payload) + "\n");
};

setTimeout(() => {
  if (stdoutBuffer.length > 0) {
    stdoutLines.push(stdoutBuffer);
  }
  if (stderrBuffer.length > 0) {
    stderrLines.push(stderrBuffer);
  }

  console.log(
    JSON.stringify(
      {
        stdoutLines,
        stderrLines,
        exitCode: child.exitCode,
        pid: child.pid,
      },
      null,
      2
    )
  );

  child.kill("SIGTERM");
}, 8000);
