#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const STATE_DIR = path.join(ROOT, "bridge-state");
const CHAT_DIR = path.join(STATE_DIR, "chats");
const ARCHIVE_DIR = path.join(STATE_DIR, "chat-archives");
const BACKUP_DIR = path.join(STATE_DIR, "thought-cleanup-backups");

const APPLY = process.argv.includes("--apply");
const PREVIEW = process.argv.includes("--preview") || !APPLY;

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
    "-",
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds())
  ].join("");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function listJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...listJsonFiles(full));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".json") &&
      !entry.name.includes("backup")
    ) {
      result.push(full);
    }
  }
  return result;
}

function hasChinese(text) {
  return /[\u3400-\u9fff]/.test(String(text || ""));
}

function countChinese(text) {
  return (String(text || "").match(/[\u3400-\u9fff]/g) || []).length;
}

function countEnglishWords(text) {
  return (String(text || "").match(/[A-Za-z][A-Za-z'’-]*/g) || []).length;
}

function countMojibakeSignals(text) {
  return (String(text || "").match(/[�]|[ÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞß]|[銆鐨鍦浠涓绋鏄鍚杩妗淇寮潰鍏彛璁綍姝湪殑佃剳琛鏈槸浣粈涔庝柟瀛尯鍔瀹繖噷兘悗欏潃闂堕噺鳳紝]/g) || []).length;
}

function looksLikeThoughtEnglish(block) {
  const text = String(block || "");
  const lower = text.toLowerCase();
  const englishWords = countEnglishWords(text);
  if (englishWords < 30) return false;

  const keywordHits = [
    "analyzing",
    "interpreting",
    "formulating",
    "crafting",
    "strategy",
    "goal",
    "persona",
    "user's message",
    "my response",
    "i need to",
    "i will",
    "the user",
    "response strategy",
    "plan of action",
    "thought",
    "reasoning"
  ].filter((word) => lower.includes(word)).length;

  const chinese = countChinese(text);
  const mostlyEnglish = englishWords >= 45 && chinese <= 20;
  const markdownThoughtHeading = /^\s*(?:[-*]\s*)?\*\*[A-Z][^*\n]{4,80}\*\*/.test(text);
  return keywordHits >= 2 || (markdownThoughtHeading && mostlyEnglish);
}

function looksLikeBrokenArtifact(block) {
  const text = String(block || "");
  if (!text.trim()) return false;
  const mojibake = countMojibakeSignals(text);
  const chinese = countChinese(text);
  const englishWords = countEnglishWords(text);
  return mojibake >= 10 && englishWords >= 10 && chinese <= mojibake * 2;
}

function findReplyStartAfterMarker(tail) {
  const value = String(tail || "");
  const paragraphMatch = value.match(/(?:^|\n\s*\n|\n)\s*(?=[（\u3400-\u9fff])/);
  if (paragraphMatch && typeof paragraphMatch.index === "number") {
    return paragraphMatch.index + paragraphMatch[0].length;
  }
  const charMatch = value.match(/[（\u3400-\u9fff]/);
  if (charMatch && typeof charMatch.index === "number") {
    return charMatch.index;
  }
  return -1;
}

function removeThoughtMarkerPrefix(text, removals) {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  const markerRegex = /\[(?:Thought|Thinking)\s*:\s*(?:true|ture)\]/gi;
  const matches = Array.from(normalized.matchAll(markerRegex));
  if (matches.length === 0) return normalized;

  const last = matches[matches.length - 1];
  const markerEnd = (last.index || 0) + last[0].length;
  const tail = normalized.slice(markerEnd);
  const replyStart = findReplyStartAfterMarker(tail);

  if (replyStart >= 0 && hasChinese(tail.slice(replyStart))) {
    const removed = normalized.slice(0, markerEnd + replyStart);
    const kept = tail.slice(replyStart);
    if (removed.trim().length >= 20 && kept.trim()) {
      removals.push({
        reason: "thought-marker-prefix",
        chars: removed.length,
        preview: removed.trim().slice(0, 180)
      });
      return kept.trim();
    }
  }

  const markerOnlyCleaned = normalized.replace(markerRegex, "").trim();
  if (markerOnlyCleaned !== normalized.trim()) {
    removals.push({
      reason: "thought-marker-only",
      chars: normalized.length - markerOnlyCleaned.length,
      preview: matches.map((m) => m[0]).join(" ")
    });
  }
  return markerOnlyCleaned;
}

function removeLeadingThoughtPrefix(text, removals) {
  const value = String(text || "");
  if (!hasChinese(value)) return value;
  const firstChinese = value.search(/[（\u3400-\u9fff]/);
  if (firstChinese <= 0) return value;

  const prefix = value.slice(0, firstChinese);
  if (!looksLikeThoughtEnglish(prefix) && !looksLikeBrokenArtifact(prefix)) {
    return value;
  }

  removals.push({
    reason: "leading-english-thought-prefix",
    chars: prefix.length,
    preview: prefix.trim().slice(0, 180)
  });
  return value.slice(firstChinese).trim();
}

function splitBlocksWithPositions(text) {
  const value = String(text || "");
  const blocks = [];
  const regex = /(?:^|\n{2,})([\s\S]*?)(?=\n{2,}|$)/g;
  let match;
  while ((match = regex.exec(value))) {
    const raw = match[0];
    const content = match[1];
    const leading = raw.indexOf(content);
    const start = (match.index || 0) + (leading >= 0 ? leading : 0);
    blocks.push({ start, end: start + content.length, content });
    if (regex.lastIndex === match.index) regex.lastIndex += 1;
  }
  return blocks;
}

function removeSuspiciousBlocks(text, removals) {
  let value = String(text || "");
  const blocks = splitBlocksWithPositions(value);
  const deleteRanges = [];

  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    const content = block.content.trim();
    if (!content) continue;
    const shouldDelete =
      looksLikeThoughtEnglish(content) || looksLikeBrokenArtifact(content);
    if (!shouldDelete) continue;

    deleteRanges.push({ start: block.start, end: block.end, content });
    removals.push({
      reason: looksLikeBrokenArtifact(content)
        ? "broken-artifact-block"
        : "long-english-thought-block",
      chars: block.end - block.start,
      preview: content.slice(0, 180)
    });
  }

  for (const range of deleteRanges) {
    value = `${value.slice(0, range.start)}${value.slice(range.end)}`;
  }
  return value.replace(/\n{3,}/g, "\n\n").trim();
}

function cleanAssistantContent(content) {
  const removals = [];
  let cleaned = String(content || "");
  cleaned = removeThoughtMarkerPrefix(cleaned, removals);
  cleaned = removeLeadingThoughtPrefix(cleaned, removals);
  cleaned = removeSuspiciousBlocks(cleaned, removals);
  cleaned = cleaned.replace(/[ \t]+\n/g, "\n").trim();
  if (
    cleaned &&
    !hasChinese(cleaned) &&
    /\[(?:Thought|Thinking)\s*:\s*(?:true|ture)\]/i.test(String(content || "")) &&
    looksLikeThoughtEnglish(cleaned)
  ) {
    removals.push({
      reason: "pure-assistant-thought-message",
      chars: cleaned.length,
      preview: cleaned.slice(0, 180)
    });
    cleaned = "";
  }
  return { cleaned, removals };
}

function cleanChatFile(file) {
  const data = readJson(file);
  const history = Array.isArray(data.history) ? data.history : [];
  const changes = [];
  const nextHistory = [];

  for (let i = 0; i < history.length; i += 1) {
    const item = history[i];
    if (!item || item.role !== "assistant" || typeof item.content !== "string") {
      nextHistory.push(item);
      continue;
    }
    const before = item.content;
    const { cleaned, removals } = cleanAssistantContent(before);
    if (cleaned !== before && removals.length > 0) {
      if (!cleaned) {
        changes.push({
          index: i,
          beforeChars: before.length,
          afterChars: 0,
          removedMessage: true,
          removals
        });
        continue;
      }
      item.content = cleaned;
      changes.push({
        index: i,
        beforeChars: before.length,
        afterChars: cleaned.length,
        removals
      });
    }
    nextHistory.push(item);
  }

  if (changes.length > 0) {
    data.history = nextHistory;
    if (typeof data.lastAssistantMessage === "string") {
      const { cleaned } = cleanAssistantContent(data.lastAssistantMessage);
      data.lastAssistantMessage = cleaned || "";
    }
    if (Object.prototype.hasOwnProperty.call(data, "sessionId")) {
      data.sessionId = null;
    }
    data.updatedAt = new Date().toISOString();
  }

  return { data, changes };
}

function backupFile(file, stamp) {
  const relative = path.relative(STATE_DIR, file);
  const target = path.join(BACKUP_DIR, stamp, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(file, target);
  return target;
}

function main() {
  const files = [
    ...listJsonFiles(CHAT_DIR),
    ...listJsonFiles(ARCHIVE_DIR)
  ];
  const stamp = timestamp();
  const report = [];

  for (const file of files) {
    const { data, changes } = cleanChatFile(file);
    if (changes.length === 0) continue;

    report.push({
      file: path.relative(ROOT, file),
      changedMessages: changes.length,
      removedChars: changes.reduce(
        (sum, change) => sum + change.beforeChars - change.afterChars,
        0
      ),
      changes
    });

    if (APPLY) {
      backupFile(file, stamp);
      writeJson(file, data);
    }
  }

  const totals = report.reduce(
    (acc, item) => {
      acc.files += 1;
      acc.messages += item.changedMessages;
      acc.removedChars += item.removedChars;
      return acc;
    },
    { files: 0, messages: 0, removedChars: 0 }
  );

  console.log(
    JSON.stringify(
      {
        mode: APPLY ? "apply" : "preview",
        totals,
        backupDir: APPLY ? path.relative(ROOT, path.join(BACKUP_DIR, stamp)) : null,
        report: report.map((item) => ({
          file: item.file,
          changedMessages: item.changedMessages,
          removedChars: item.removedChars,
          samples: item.changes.slice(0, 8).map((change) => ({
            index: change.index,
            beforeChars: change.beforeChars,
            afterChars: change.afterChars,
            reasons: change.removals.map((r) => r.reason),
            preview: change.removals[0] ? change.removals[0].preview : ""
          }))
        }))
      },
      null,
      2
    )
  );

  if (PREVIEW && totals.messages > 0) {
    console.log("\nPreview only. Run with --apply to back up and write changes.");
  }
}

main();
