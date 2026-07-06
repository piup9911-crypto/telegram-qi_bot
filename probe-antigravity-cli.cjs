const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_AGY_PATH = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "agy",
  "bin",
  "agy.exe"
);
const AGY_PATH = process.env.AGY_PATH || DEFAULT_AGY_PATH;
const PROMPT = process.argv.slice(2).join(" ").trim() || "只回复 PONG";
const LOG_PATH = path.join(__dirname, "bridge-state", "agy-probe.log");

function runAgyPrint(prompt) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(
      AGY_PATH,
      [
        "--log-file",
        LOG_PATH,
        "--print-timeout",
        "60s",
        "--print",
        prompt
      ],
      {
        cwd: __dirname,
        windowsHide: true
      }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      child.kill();
    }, 75000);

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        elapsedMs: Date.now() - startedAt,
        stdout,
        stderr
      });
    });
  });
}

function readLogTail() {
  try {
    const content = fs.readFileSync(LOG_PATH, "utf8");
    return content.split(/\r?\n/).slice(-80).join("\n");
  } catch {
    return "";
  }
}

function classify(result, logTail) {
  const combined = `${result.stdout}\n${result.stderr}\n${logTail}`;
  if (/You are not logged into Antigravity|auth timed out|not authenticated/i.test(combined)) {
    return {
      ok: false,
      status: "needs_login",
      message: "Antigravity CLI is installed, but this Windows user is not logged into Antigravity CLI yet."
    };
  }
  if (result.stdout.trim()) {
    return {
      ok: true,
      status: "stdout_ok",
      message: "Antigravity CLI print mode produced stdout and can be adapted as a bridge backend."
    };
  }
  if (result.code === 0 && !result.stdout.trim()) {
    return {
      ok: false,
      status: "empty_stdout",
      message: "Antigravity CLI exited without stdout. This may be the known print-mode capture issue."
    };
  }
  return {
    ok: false,
    status: "failed",
    message: "Antigravity CLI print mode did not produce a usable response."
  };
}

async function main() {
  const exists = fs.existsSync(AGY_PATH);
  if (!exists) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: false,
          status: "missing",
          agyPath: AGY_PATH,
          message: "agy.exe was not found. Install Antigravity CLI first."
        },
        null,
        2
      )}\n`
    );
    return;
  }

  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  try {
    fs.rmSync(LOG_PATH, { force: true });
  } catch {
    // Best-effort cleanup only; the log file is for diagnosis.
  }

  const result = await runAgyPrint(PROMPT);
  const logTail = readLogTail();
  const classification = classify(result, logTail);
  process.stdout.write(
    `${JSON.stringify(
      {
        ...classification,
        agyPath: AGY_PATH,
        promptChars: PROMPT.length,
        exitCode: result.code,
        signal: result.signal,
        elapsedMs: result.elapsedMs,
        stdoutLength: result.stdout.length,
        stderrLength: result.stderr.length,
        stdoutPreview: result.stdout.trim().slice(0, 500),
        stderrPreview: result.stderr.trim().slice(0, 500),
        logPath: LOG_PATH,
        logTailPreview: logTail.slice(-1200)
      },
      null,
      2
    )}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
