const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const repoRoot = path.resolve(__dirname, '..', '..');
const { askAntigravity } = require(path.join(
  repoRoot,
  'src',
  'adapters',
  'antigravity-cli-adapter.cjs'
));
const { askAntigravitySidecar } = require(path.join(
  repoRoot,
  'src',
  'adapters',
  'antigravity-sidecar-adapter.cjs'
));

function extractJson(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('Model returned empty content.');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch (firstError) {
    const objectStart = candidate.indexOf('{');
    const objectEnd = candidate.lastIndexOf('}');
    const arrayStart = candidate.indexOf('[');
    const arrayEnd = candidate.lastIndexOf(']');
    const slices = [];
    if (objectStart >= 0 && objectEnd > objectStart) slices.push(candidate.slice(objectStart, objectEnd + 1));
    if (arrayStart >= 0 && arrayEnd > arrayStart) slices.push(candidate.slice(arrayStart, arrayEnd + 1));
    for (const slice of slices) {
      try {
        return JSON.parse(slice);
      } catch {}
    }
    throw new Error(`Invalid JSON: ${firstError.message}; preview=${candidate.slice(0, 300)}`);
  }
}

async function callJson(prompt, options = {}) {
  const provider = options.provider || process.env.AQI_PIPELINE_PROVIDER || 'codex';
  if (provider === 'codex') return callCodexJson(prompt, options);
  if (provider === 'antigravity-sidecar') return callAntigravitySidecarJson(prompt, options);
  if (provider !== 'antigravity') throw new Error(`Unsupported provider: ${provider}`);
  const startedAt = Date.now();
  const configuredModel = options.model || process.env.AQI_PIPELINE_MODEL || '';
  const requestOptions = {
    cwd: options.cwd || repoRoot,
    timeoutMs: options.timeoutMs || 180000,
    printPrompt: 'Read the task from stdin. Return only valid JSON with no markdown fences.'
  };
  if (configuredModel) requestOptions.modelName = configuredModel;
  if (options.conversationId) requestOptions.conversationId = options.conversationId;
  const result = await askAntigravity(prompt, requestOptions);
  if (!result.ok) {
    throw new Error(result.message || result.status || 'Antigravity request failed.');
  }
  return {
    data: extractJson(result.content),
    elapsedMs: result.elapsedMs || Date.now() - startedAt,
    status: result.status,
    model: configuredModel || 'Antigravity current model',
    conversationId: result.conversationId || options.conversationId || null,
    transcriptPath: result.transcriptPath || null
  };
}

async function callAntigravitySidecarJson(prompt, options = {}) {
  const startedAt = Date.now();
  const cwd = options.cwd || repoRoot;
  const configuredModel = options.model || process.env.AQI_PIPELINE_MODEL || '';
  const result = await askAntigravitySidecar(prompt, {
    conversationId: options.conversationId || '',
    workspaceUris: [pathToFileURL(cwd).href],
    modelName: configuredModel,
    timeoutMs: options.timeoutMs || 180000
  });
  if (!result.ok) throw new Error(result.message || result.status || 'Antigravity sidecar request failed.');
  return {
    data: extractJson(result.content),
    elapsedMs: result.elapsedMs || Date.now() - startedAt,
    status: result.status,
    model: configuredModel || result.planModel || 'Antigravity sidecar current model',
    conversationId: result.conversationId || options.conversationId || null,
    transcriptPath: null,
    created: Boolean(result.created)
  };
}

function callCodexJson(prompt, options = {}) {
  const startedAt = Date.now();
  const args = [
    'exec',
    '--ephemeral',
    '--sandbox', 'read-only',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '-C', repoRoot,
    '--json',
    '-'
  ];
  if (options.model || process.env.AQI_PIPELINE_MODEL) {
    args.splice(args.length - 2, 0, '--model', options.model || process.env.AQI_PIPELINE_MODEL);
  }
  return new Promise((resolve, reject) => {
    const codexCandidates = [
      path.join(repoRoot, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'),
      path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe')
    ];
    const codexExecutable = codexCandidates.find((candidate) => fs.existsSync(candidate));
    if (!codexExecutable) {
      reject(new Error('Cannot locate codex.exe for the Codex experiment provider.'));
      return;
    }
    const child = spawn(codexExecutable, args, {
      cwd: repoRoot,
      windowsHide: true,
      env: process.env
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Codex provider timed out.'));
    }, options.timeoutMs || 240000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Codex provider exited ${code}: ${stderr.slice(-1000)}`));
        return;
      }
      let message = '';
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
            message = event.item.text || message;
          }
        } catch {}
      }
      if (!message) {
        reject(new Error(`Codex provider returned no agent message: ${stdout.slice(-1000)}`));
        return;
      }
      try {
        resolve({
          data: extractJson(message),
          elapsedMs: Date.now() - startedAt,
          status: 'codex_exec_ok',
          model: options.model || process.env.AQI_PIPELINE_MODEL || 'Codex default model'
        });
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(`${prompt}\n`);
  });
}

module.exports = { callJson, callCodexJson, extractJson, repoRoot };
