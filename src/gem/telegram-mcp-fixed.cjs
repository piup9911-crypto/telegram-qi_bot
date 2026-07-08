const fs = require("fs");
const path = require("path");

const packageRoot = path.join(
  process.env.APPDATA || "",
  "npm",
  "node_modules",
  "mcp-communicator-telegram"
);

const requireFromTelegramPackage = (name) =>
  require(path.join(packageRoot, "node_modules", name));

const TelegramBot = requireFromTelegramPackage("node-telegram-bot-api");
const archiver = requireFromTelegramPackage("archiver");
const ignore = requireFromTelegramPackage("ignore");

const log = (...args) => {
  const line = args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
  process.stderr.write(line + "\n");
};

const loadEnvFile = () => {
  const envPath = path.join(
    process.env.USERPROFILE || process.env.HOME || "",
    ".gemini",
    ".env"
  );

  try {
    const content = fs.readFileSync(envPath, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eqIndex = line.indexOf("=");
      if (eqIndex === -1) continue;
      const key = line.slice(0, eqIndex).trim();
      let value = line.slice(eqIndex + 1).trim();
      value = value.replace(/(^['"]|['"]$)/g, "");
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    log("Failed to load env file:", error.message);
  }
};

loadEnvFile();

if (!process.env.TELEGRAM_TOKEN && process.env.TELEGRAM_BOT_TOKEN) {
  process.env.TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
}

if (!process.env.CHAT_ID && process.env.TELEGRAM_CHAT_ID) {
  process.env.CHAT_ID = process.env.TELEGRAM_CHAT_ID;
}

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

if (!TELEGRAM_TOKEN || !CHAT_ID) {
  log("Missing TELEGRAM_TOKEN or CHAT_ID");
  process.exit(1);
}

const validatedChatId = CHAT_ID;
let bot = null;
let lastQuestionId = null;
const pendingQuestions = new Map();

const sendResponse = (response) => {
  process.stdout.write(JSON.stringify(response) + "\n");
};

const sendSuccess = (id, result) => {
  if (id === undefined || id === null) return;
  sendResponse({ jsonrpc: "2.0", id, result });
};

const sendError = (id, code, message) => {
  if (id === undefined || id === null) return;
  sendResponse({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
};

const normalizeChatId = (chatId) => Number(chatId);

const addFilesFromDirectory = (archive, ig, workingDir, dirPath) => {
  const files = fs.readdirSync(dirPath);
  for (const file of files) {
    const fullPath = path.join(dirPath, file);
    const relativePath = path.relative(workingDir, fullPath);
    if (!relativePath || relativePath.startsWith(".git")) {
      continue;
    }

    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      addFilesFromDirectory(archive, ig, workingDir, fullPath);
      continue;
    }

    if (!ig.ignores(relativePath)) {
      archive.file(fullPath, { name: relativePath });
    }
  }
};

const zipProject = async (directory) => {
  const workingDir = directory || process.cwd();
  const projectName = path.basename(workingDir);
  const outputPath = path.join(workingDir, `${projectName}-project.zip`);
  const ig = ignore();
  const gitignorePath = path.join(workingDir, ".gitignore");

  if (fs.existsSync(gitignorePath)) {
    ig.add(fs.readFileSync(gitignorePath, "utf8"));
  }

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);
    archive.pipe(output);

    addFilesFromDirectory(archive, ig, workingDir, workingDir);
    archive.finalize();
  });

  return outputPath;
};

const waitForAnswer = (questionId) =>
  new Promise((resolve) => {
    pendingQuestions.set(questionId, resolve);
  });

const askUser = async ({ question }) => {
  if (!bot) throw new Error("Bot not initialized");
  if (!question) throw new Error("question is required");

  const questionId = Math.random().toString(36).slice(2, 8);
  lastQuestionId = questionId;

  await bot.sendMessage(normalizeChatId(validatedChatId), `#${questionId}\n${question}`, {
    reply_markup: {
      force_reply: true,
      selective: true,
    },
  });

  const answer = await waitForAnswer(questionId);
  pendingQuestions.delete(questionId);
  lastQuestionId = null;
  return answer;
};

const notifyUser = async ({ message }) => {
  if (!bot) throw new Error("Bot not initialized");
  if (!message) throw new Error("message is required");
  await bot.sendMessage(normalizeChatId(validatedChatId), message);
};

const sendFile = async ({ filePath }) => {
  if (!bot) throw new Error("Bot not initialized");
  if (!filePath) throw new Error("filePath is required");
  await bot.sendDocument(
    normalizeChatId(validatedChatId),
    fs.createReadStream(filePath),
    {},
    {
      contentType: "application/octet-stream",
      filename: path.basename(filePath),
    }
  );
};

const handleToolCall = async (name, args) => {
  switch (name) {
    case "ask_user": {
      const answer = await askUser(args || {});
      return { content: [{ type: "text", text: answer }] };
    }
    case "notify_user": {
      await notifyUser(args || {});
      return { content: [{ type: "text", text: "Notification sent successfully" }] };
    }
    case "send_file": {
      await sendFile(args || {});
      return { content: [{ type: "text", text: "File sent successfully" }] };
    }
    case "zip_project": {
      const workingDir = args?.directory || process.cwd();
      const zipFilePath = await zipProject(workingDir);
      try {
        await sendFile({ filePath: zipFilePath });
      } finally {
        if (fs.existsSync(zipFilePath)) {
          fs.unlinkSync(zipFilePath);
        }
      }
      return { content: [{ type: "text", text: "Project zipped and sent successfully" }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
};

const toolList = [
  {
    name: "ask_user",
    description: "Ask the user a question via Telegram and wait for their response",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question to ask the user",
        },
      },
      required: ["question"],
    },
  },
  {
    name: "notify_user",
    description: "Send a notification message to the user via Telegram (no response required)",
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "The message to send to the user",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "send_file",
    description: "Send a file to the user via Telegram",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "The path to the file to send",
        },
      },
      required: ["filePath"],
    },
  },
  {
    name: "zip_project",
    description: "Zip a project directory and send it to the user",
    inputSchema: {
      type: "object",
      properties: {
        directory: {
          type: "string",
          description: "Directory to zip (defaults to current working directory)",
        },
      },
      required: [],
    },
  },
];

const handleMessage = async (request) => {
  if (!request || typeof request !== "object") {
    return;
  }

  const { id, method } = request;

  if (!method) {
    sendError(id, -32600, "Invalid request");
    return;
  }

  if (method.startsWith("notifications/")) {
    return;
  }

  try {
    switch (method) {
      case "initialize":
        sendSuccess(id, {
          protocolVersion: "2024-11-05",
          serverInfo: {
            name: "telegram-mcp-fixed",
            version: "1.0.0",
          },
          capabilities: {
            tools: {
              
              
            },
          },
        });
        return;
      case "ping":
        sendSuccess(id, {});
        return;
      case "tools/list":
        sendSuccess(id, { tools: toolList });
        return;
      case "tools/call": {
        const result = await handleToolCall(request.params?.name, request.params?.arguments);
        sendSuccess(id, result);
        return;
      }
      case "resources/list":
        sendSuccess(id, { resources: [] });
        return;
      case "resources/templates/list":
        sendSuccess(id, { resourceTemplates: [] });
        return;
      case "prompts/list":
        sendSuccess(id, { prompts: [] });
        return;
      default:
        sendError(id, -32601, `Method not found: ${method}`);
        return;
    }
  } catch (error) {
    sendError(id, -32000, error?.message || "Unknown error");
  }
};

const startServer = () => {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    const messages = buffer.split("\n");
    buffer = messages.pop() || "";
    for (const message of messages) {
      const trimmed = message.trim();
      if (!trimmed) continue;
      try {
        const request = JSON.parse(trimmed);
        handleMessage(request);
      } catch (error) {
        log("Failed to parse request:", error.message);
      }
    }
  });
};

const initializeBot = async () => {
  bot = new TelegramBot(TELEGRAM_TOKEN, {
    polling: true,
    filepath: false,
  });

  bot.on("message", (msg) => {
    if (!msg?.text) return;
    if (String(msg.chat?.id) !== String(validatedChatId)) return;

    let questionId = null;
    const replyText = msg.reply_to_message?.text;
    if (replyText) {
      const match = replyText.match(/#([a-z0-9]+)\n/i);
      if (match) {
        questionId = match[1];
      }
    }

    if (!questionId) {
      questionId = lastQuestionId;
    }

    if (questionId && pendingQuestions.has(questionId)) {
      const resolve = pendingQuestions.get(questionId);
      resolve(msg.text);
    }
  });

  bot.on("polling_error", (error) => {
    const message = error?.message || "";
    if (message.includes("409 Conflict")) {
      log("Ignoring Telegram polling conflict");
      return;
    }
    log("Polling error:", message);
  });

  const botInfo = await bot.getMe();
  log("Bot initialized successfully:", botInfo.username);
};

process.on("SIGINT", async () => {
  if (bot) {
    try {
      await bot.stopPolling();
    } catch {}
  }
  process.exit(0);
});

process.on("SIGTERM", async () => {
  if (bot) {
    try {
      await bot.stopPolling();
    } catch {}
  }
  process.exit(0);
});

(async () => {
  await initializeBot();
  log("MCP Communicator server running...");
  startServer();
})();
