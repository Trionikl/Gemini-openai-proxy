const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { Transform } = require("stream");
const { StringDecoder } = require("string_decoder");
const { SocksProxyAgent } = require("socks-proxy-agent");

// === Встроенный парсер .env ===
function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    try {
      const envContent = fs.readFileSync(envPath, "utf8");
      envContent.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return;
        const eqIndex = trimmed.indexOf("=");
        if (eqIndex === -1) return;
        const key = trimmed.substring(0, eqIndex).trim();
        const val = trimmed.substring(eqIndex + 1).trim();
        process.env[key] = val;
      });
      console.log("[Proxy Env] Файл .env успешно загружен.");
    } catch (e) {
      console.error("[Proxy Env] Ошибка разбора .env:", e.message);
    }
  }
}

loadEnv();

const socksProxyUrl = process.env.SOCKS_PROXY || "socks5h://127.0.0.1:1080";
const agent = new SocksProxyAgent(socksProxyUrl);

// === КЭШ ПОДПИСЕЙ МЫСЛЕЙ НА ДИСКЕ ===
const CACHE_PATH = path.join(os.tmpdir(), "qwen_thought_signatures.json");
const thoughtSignaturesCache = new Map();

try {
  if (fs.existsSync(CACHE_PATH)) {
    const fileContent = fs.readFileSync(CACHE_PATH, "utf8");
    const data = JSON.parse(fileContent);
    for (const [key, val] of Object.entries(data)) {
      thoughtSignaturesCache.set(key, val);
    }
    console.log(
      `[Proxy Cache] Загружено ${thoughtSignaturesCache.size} подписей мыслей из кэша.`,
    );
  }
} catch (e) {
  console.error("[Proxy Cache] Ошибка чтения кэша:", e.message);
}

let cacheDirty = false;
let cacheFlushTimer = null;
function scheduleCacheFlush() {
  cacheDirty = true;
  if (cacheFlushTimer) return;
  cacheFlushTimer = setTimeout(() => {
    cacheFlushTimer = null;
    if (!cacheDirty) return;
    cacheDirty = false;
    try {
      const obj = Object.fromEntries(thoughtSignaturesCache);
      fs.writeFileSync(CACHE_PATH, JSON.stringify(obj), "utf8");
    } catch (e) {}
  }, 10000);
}

function safeCacheSet(key, value) {
  if (!key) return;
  if (thoughtSignaturesCache.size > 2000) {
    const firstKey = thoughtSignaturesCache.keys().next().value;
    thoughtSignaturesCache.delete(firstKey);
  }
  thoughtSignaturesCache.set(key, value);
  scheduleCacheFlush();
}

// === УПРАВЛЕНИЕ ЛИМИТАМИ И ОЧЕРЕДЬЮ (ROLLING WINDOW THROTTLER) ===
const requestHistory = []; // { timestamp, tokens }

async function acquireThrottlingPermit(
  estimatedTokens = 10000,
  maxTpm = 220000,
  minDelayMs = 2500,
) {
  const now = Date.now();

  // Очистка истории старше 60 секунд
  while (
    requestHistory.length > 0 &&
    requestHistory[0].timestamp < now - 60000
  ) {
    requestHistory.shift();
  }

  let currentTokensInWindow = requestHistory.reduce(
    (sum, item) => sum + item.tokens,
    0,
  );
  let lastReqTime =
    requestHistory.length > 0
      ? requestHistory[requestHistory.length - 1].timestamp
      : 0;

  let delayNeeded = 0;

  if (currentTokensInWindow + estimatedTokens > maxTpm) {
    if (requestHistory.length > 0) {
      delayNeeded = Math.max(
        delayNeeded,
        requestHistory[0].timestamp + 60100 - now,
      );
    }
  }

  if (now - lastReqTime < minDelayMs) {
    delayNeeded = Math.max(delayNeeded, minDelayMs - (now - lastReqTime));
  }

  if (delayNeeded > 0) {
    console.log(
      `[Proxy Throttler] Удержание HTTP-сокета на ${Math.round(delayNeeded / 1000)}с для предотвращения 429 (TPM/RPM)...`,
    );
    await new Promise((resolve) => setTimeout(resolve, delayNeeded));
  }

  const actualNow = Date.now();
  requestHistory.push({ timestamp: actualNow, tokens: estimatedTokens });
}

// === МИНИФИКАЦИЯ SVG ДЛЯ ЭКОНОМИИ ТОКЕНОВ ===
function optimizeSvgContent(text) {
  if (typeof text !== "string" || !text.includes("<svg")) return text;
  return text.replace(/<svg[\s\S]*?<\/svg>/gi, (svgMatch) => {
    return svgMatch
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/>\s+</g, "><")
      .replace(/\s+/g, " ")
      .trim();
  });
}

// === ПОИСК ФАЙЛОВ И КОНТЕКСТА ===
function getContextConfig(isGoose) {
  if (isGoose) return { fileNames: [], includeDirectories: [] };
  try {
    const settingsPath = path.join(os.homedir(), ".qwen", "settings.json");
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      if (settings.context) {
        return {
          fileNames: Array.isArray(settings.context.fileName)
            ? settings.context.fileName
            : [],
          includeDirectories: Array.isArray(settings.context.includeDirectories)
            ? settings.context.includeDirectories
            : [],
        };
      }
    }
  } catch (e) {}
  return { fileNames: [], includeDirectories: [] };
}

function findAndReadFile(fileName, includeDirs) {
  for (const dir of includeDirs) {
    const fullPath = path.join(dir, fileName);
    if (fs.existsSync(fullPath)) {
      try {
        return fs.readFileSync(fullPath, "utf8");
      } catch (err) {}
    }
  }
  let currentDir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const fullPath = path.join(currentDir, fileName);
    if (fs.existsSync(fullPath)) {
      try {
        return fs.readFileSync(fullPath, "utf8");
      } catch (err) {}
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }
  return null;
}

function findFunctionNameById(messages, toolCallId) {
  if (!toolCallId) return null;
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc.id === toolCallId && tc.function && tc.function.name) {
          return tc.function.name;
        }
      }
    }
  }
  return null;
}

function cacheThoughtSignatures(obj) {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) cacheThoughtSignatures(item);
  } else {
    let sig =
      obj.extra_content?.google?.thought_signature ||
      obj.thought_signature ||
      obj.thoughtSignature;
    if (obj.id && sig) {
      safeCacheSet(obj.id, sig);
    }
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === "object") cacheThoughtSignatures(obj[key]);
    }
  }
}

function sanitizeResponseToolCalls(obj) {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (obj[i] && typeof obj[i] === "object") {
        if (obj[i].function) {
          if (obj[i].index === undefined) obj[i].index = i;
          if (!obj[i].type) obj[i].type = "function";
        }
        sanitizeResponseToolCalls(obj[i]);
      }
    }
  } else {
    if (
      obj.function &&
      obj.function.arguments &&
      typeof obj.function.arguments === "object"
    ) {
      obj.function.arguments = JSON.stringify(obj.function.arguments);
    }
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === "object") sanitizeResponseToolCalls(obj[key]);
    }
  }
}

function stripExtraContent(obj) {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) stripExtraContent(item);
  } else {
    delete obj["extra_content"];
    delete obj["thought_signature"];
    delete obj["thoughtSignature"];
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === "object") stripExtraContent(obj[key]);
    }
  }
}

function sanitizeSchema(obj) {
  if (obj === null || typeof obj !== "object") return;
  delete obj["$schema"];
  delete obj["additionalProperties"];
  delete obj["default"];
  delete obj["propertyNames"];
  delete obj["patternProperties"];
  delete obj["unevaluatedProperties"];

  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === "object" && obj[key] !== null) {
      sanitizeSchema(obj[key]);
    }
  }
}

function stripThoughtSignaturesForRetry(reqJson) {
  const clone = JSON.parse(JSON.stringify(reqJson));
  if (Array.isArray(clone.messages)) {
    for (const msg of clone.messages) {
      if (msg.extra_content) delete msg.extra_content;
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (tc.extra_content) delete tc.extra_content;
        }
      }
    }
  }
  return clone;
}

// === СТРИМ-ТРАНСФОРМЕР С ПАРСИНГОМ МЫСЛЕЙ ===
class GeminiSSEResponseTransformer extends Transform {
  constructor(options) {
    super(options);
    this.lineBuffer = "";
    this.tagBuffer = "";
    this.isThinking = false;
    this.currentEndTag = "";
    this.decoder = new StringDecoder("utf8");
    this.accumulatedContent = "";
    this.accumulatedSignature = "";
  }

  _transform(chunk, encoding, callback) {
    this.lineBuffer += this.decoder.write(chunk);
    let lineEndIndex;
    while ((lineEndIndex = this.lineBuffer.indexOf("\n")) !== -1) {
      const line = this.lineBuffer.substring(0, lineEndIndex).trim();
      this.lineBuffer = this.lineBuffer.substring(lineEndIndex + 1);
      if (line) {
        const transformedLine = this.processLine(line);
        if (transformedLine !== null) this.push(transformedLine + "\n\n");
      }
    }
    callback();
  }

  _flush(callback) {
    this.lineBuffer += this.decoder.end();
    if (this.lineBuffer.trim()) {
      const transformedLine = this.processLine(this.lineBuffer.trim());
      if (transformedLine !== null) this.push(transformedLine + "\n\n");
    }
    const finalFlush = this.flushTagBuffer();
    if (finalFlush) this.push(finalFlush + "\n\n");

    if (this.accumulatedContent.trim() && this.accumulatedSignature) {
      safeCacheSet(this.accumulatedContent.trim(), this.accumulatedSignature);
    }
    callback();
  }

  processLine(line) {
    if (line.startsWith("data:")) {
      const dataStr = line.substring(5).trim();
      if (dataStr === "[DONE]") return line;
      try {
        const jsonObj = JSON.parse(dataStr);
        cacheThoughtSignatures(jsonObj);
        sanitizeResponseToolCalls(jsonObj);

        if (jsonObj.choices && jsonObj.choices.length > 0) {
          const choice = jsonObj.choices[0];
          if (choice.delta) {
            let sig = choice.delta.extra_content?.google?.thought_signature;
            if (sig) this.accumulatedSignature = sig;

            if (typeof choice.delta.content === "string") {
              const content = choice.delta.content;
              const { deltaContent, deltaReasoning } =
                this.processContent(content);
              if (deltaContent) this.accumulatedContent += deltaContent;

              choice.delta.content = deltaContent;
              if (deltaReasoning) {
                choice.delta.reasoning_content = deltaReasoning;
              } else {
                delete choice.delta.reasoning_content;
              }
            }
          }
        }
        stripExtraContent(jsonObj);
        return "data: " + JSON.stringify(jsonObj);
      } catch (e) {
        return line;
      }
    }
    return line;
  }

  processContent(content) {
    let deltaContent = "";
    let deltaReasoning = "";
    this.tagBuffer += content;

    while (this.tagBuffer.length > 0) {
      if (!this.isThinking) {
        const candidates = [
          {
            index: this.tagBuffer.indexOf("<thought>"),
            len: 9,
            tag: "thought",
          },
          {
            index: this.tagBuffer.indexOf("<thinking>"),
            len: 10,
            tag: "thinking",
          },
          { index: this.tagBuffer.indexOf("<think>"), len: 7, tag: "think" },
        ]
          .filter((c) => c.index !== -1)
          .sort((a, b) => a.index - b.index);

        if (candidates.length > 0) {
          const earliest = candidates[0];
          deltaContent += this.tagBuffer.substring(0, earliest.index);
          this.isThinking = true;
          this.currentEndTag = `</${earliest.tag}>`;
          this.tagBuffer = this.tagBuffer.substring(
            earliest.index + earliest.len,
          );
        } else {
          deltaContent += this.tagBuffer;
          this.tagBuffer = "";
        }
      } else {
        const index = this.tagBuffer.indexOf(this.currentEndTag);
        if (index !== -1) {
          deltaReasoning += this.tagBuffer.substring(0, index);
          this.isThinking = false;
          this.tagBuffer = this.tagBuffer.substring(
            index + this.currentEndTag.length,
          );
        } else {
          deltaReasoning += this.tagBuffer;
          this.tagBuffer = "";
        }
      }
    }
    return { deltaContent, deltaReasoning };
  }

  flushTagBuffer() {
    if (this.tagBuffer.length > 0) {
      const dummyJSON = { choices: [{ index: 0, delta: {} }] };
      if (this.isThinking) {
        dummyJSON.choices[0].delta.reasoning_content = this.tagBuffer;
      } else {
        dummyJSON.choices[0].delta.content = this.tagBuffer;
      }
      this.tagBuffer = "";
      return "data: " + JSON.stringify(dummyJSON);
    }
    return null;
  }
}

// === ПРЕОБРАЗОВАНИЕ ЗАПРОСА ===
function buildRequestBody(rawBodyPayload, isGoose) {
  let reqJson = JSON.parse(rawBodyPayload.toString("utf8"));
  let modelName = reqJson.model || "unknown";

  if (modelName.startsWith("models/")) {
    modelName = modelName.substring(7);
    reqJson.model = modelName;
  }

  // Чистая обработка моделей без подмены
  const isCerebras = modelName === "zai-glm-4.7";
  const isGemini = modelName.toLowerCase().includes("gemini");
  const isGemma4 =
    modelName.toLowerCase().includes("gemma-4") ||
    modelName.toLowerCase().includes("gemma 4");
  const isThinkingModel = isGemini || isGemma4;

  let shouldParseThoughts = false;
  let shouldOptimizePrompt = false;
  let targetHost = "generativelanguage.googleapis.com";

  if (isCerebras) {
    targetHost = "api.cerebras.ai";
  } else if (isThinkingModel) {
    shouldParseThoughts = true;
    shouldOptimizePrompt = !isGoose;

    let thinkingLevel =
      isGemma4 || modelName.toLowerCase().includes("pro") ? "high" : "medium";

    if (!reqJson.extra_body) reqJson.extra_body = {};
    if (!reqJson.extra_body.google) reqJson.extra_body.google = {};
    reqJson.extra_body.google.thinking_config = {
      thinking_level: thinkingLevel,
      include_thoughts: true,
    };
  }

  if (!isCerebras) {
    delete reqJson.store;
    delete reqJson.stream_options;
    delete reqJson.parallel_tool_calls;
    delete reqJson.service_tier;
    delete reqJson.reasoning_effort;

    const maxAllowedTokens = 8192;
    if (reqJson.max_tokens && reqJson.max_tokens > maxAllowedTokens)
      reqJson.max_tokens = maxAllowedTokens;
    if (
      reqJson.max_completion_tokens &&
      reqJson.max_completion_tokens > maxAllowedTokens
    )
      reqJson.max_completion_tokens = maxAllowedTokens;

    if (Array.isArray(reqJson.tools)) {
      for (const tool of reqJson.tools) {
        if (tool.type === "function" && tool.function?.parameters) {
          sanitizeSchema(tool.function.parameters);
        }
      }
    }

    if (reqJson.messages && Array.isArray(reqJson.messages)) {
      for (let msg of reqJson.messages) {
        if (msg.content === null || msg.content === undefined) msg.content = "";

        if (msg.role === "user") {
          if (typeof msg.content === "string") {
            msg.content = optimizeSvgContent(msg.content);
          } else if (Array.isArray(msg.content)) {
            for (let part of msg.content) {
              if (part && typeof part.text === "string") {
                part.text = optimizeSvgContent(part.text);
              }
            }
          }
        }

        if (
          msg.role === "assistant" &&
          Array.isArray(msg.tool_calls) &&
          (msg.content === "" || msg.content === null)
        ) {
          msg.content = "Calling tools...";
        }

        if (msg.role === "tool" && (!msg.name || msg.name === "")) {
          const reconstructedName = findFunctionNameById(
            reqJson.messages,
            msg.tool_call_id,
          );
          msg.name =
            reconstructedName ||
            reqJson.tools?.[0]?.function?.name ||
            "tool_function";
        }
      }

      for (let i = 0; i < reqJson.messages.length; i++) {
        const msg = reqJson.messages[i];
        if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
          let toolResponses = [];
          for (let j = i + 1; j < reqJson.messages.length; j++) {
            if (
              reqJson.messages[j].role === "assistant" ||
              reqJson.messages[j].role === "user"
            )
              break;
            if (reqJson.messages[j].role === "tool")
              toolResponses.push(reqJson.messages[j]);
          }

          for (let k = 0; k < msg.tool_calls.length; k++) {
            const tc = msg.tool_calls[k];
            const resp = toolResponses[k];
            if (resp) {
              const sharedId =
                tc.id && tc.id !== "null"
                  ? tc.id
                  : resp.tool_call_id && resp.tool_call_id !== "null"
                    ? resp.tool_call_id
                    : `call_sync_${k}_` +
                      Math.random().toString(36).substring(2, 7);
              tc.id = sharedId;
              resp.tool_call_id = sharedId;
            }
          }
        }
      }

      for (const msg of reqJson.messages) {
        if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            let signatureToInject =
              thoughtSignaturesCache.get(tc.id) ||
              "skip_thought_signature_validator";
            tc.extra_content = {
              google: { thought_signature: signatureToInject },
            };
          }
        }
      }

      if (shouldOptimizePrompt) {
        const config = getContextConfig(isGoose);
        let systemMessages = [];
        let otherMessages = [];
        let agentRulesText = "";
        const filesMap = new Map();

        for (const fileName of config.fileNames) {
          const fileContent = findAndReadFile(
            fileName,
            config.includeDirectories,
          );
          if (fileContent) {
            filesMap.set(fileName, fileContent);
            agentRulesText += `\n\n=== FILE: ${fileName} ===\n${fileContent}`;
          }
        }

        for (let msg of reqJson.messages) {
          let msgContentStr =
            typeof msg.content === "string"
              ? msg.content
              : Array.isArray(msg.content)
                ? msg.content.map((p) => p.text || "").join(" ")
                : "";
          if (msg.role === "system") {
            systemMessages.push(msgContentStr);
          } else {
            otherMessages.push(msg);
          }
        }

        let finalSystemContent = `<system_role>
Ты — автономный ИИ-агент разработчик (Qwen Code Agent). Выполняй команды и выдавай только готовый код.
</system_role>`;

        if (systemMessages.length > 0)
          finalSystemContent += `\n\n<agent_environment_rules>\n${systemMessages.join("\n\n")}\n</agent_environment_rules>`;
        if (agentRulesText)
          finalSystemContent += `\n\n<agent_rules>\n${agentRulesText.trim()}\n</agent_rules>`;

        reqJson.messages = [
          { role: "system", content: finalSystemContent },
          ...otherMessages,
        ];
      }
    }
  }

  const estimatedTokens = Math.ceil(JSON.stringify(reqJson).length / 3.5);

  return {
    reqJson,
    modelName,
    targetHost,
    isCerebras,
    shouldParseThoughts,
    estimatedTokens,
  };
}

// === ЛОКАЛЬНЫЙ СЕРВЕР ===
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-goog-api-key",
  );
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Cache-Control", "no-cache, no-transform");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  let targetPath = req.url || "";

  // Чисный эндпоинт списка моделей без фантомных записей
  if (
    req.method === "GET" &&
    (targetPath === "/v1/models" || targetPath === "/v1beta/openai/models")
  ) {
    const modelsResponse = {
      object: "list",
      data: [
        {
          id: "gemini-3.5-flash-lite",
          object: "model",
          created: 1700000000,
          owned_by: "google",
        },
        {
          id: "gemini-3.1-flash-lite",
          object: "model",
          created: 1700000000,
          owned_by: "google",
        },
        {
          id: "gemma-4-31b-it",
          object: "model",
          created: 1700000000,
          owned_by: "google",
        },
      ],
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(modelsResponse));
    return;
  }

  let bodyChunks = [];
  req.on("data", (chunk) => bodyChunks.push(chunk));

  req.on("end", async () => {
    const rawBodyPayload =
      bodyChunks.length > 0 ? Buffer.concat(bodyChunks) : Buffer.alloc(0);
    let targetHost = "generativelanguage.googleapis.com";

    const userAgent = (req.headers["user-agent"] || "").toLowerCase();
    const isGoose =
      userAgent.includes("goose") ||
      userAgent.includes("reqwest") ||
      targetPath.includes("/v1beta/openai/v1/");

    if (targetPath.includes("/v1beta/openai/v1/")) {
      targetPath = targetPath.replace("/v1beta/openai/v1/", "/v1beta/openai/");
    }

    let parsed = null;
    let bodyPayload = rawBodyPayload;

    if (req.method === "POST" && targetPath.includes("/chat/completions")) {
      try {
        parsed = buildRequestBody(rawBodyPayload, isGoose);
        targetHost = parsed.targetHost;
        bodyPayload = Buffer.from(JSON.stringify(parsed.reqJson), "utf8");

        await acquireThrottlingPermit(parsed.estimatedTokens, 220000, 2500);
      } catch (e) {
        console.error("[Proxy] Ошибка разбора запроса:", e.message);
        parsed = null;
      }
    }

    const isCerebras = parsed ? parsed.isCerebras : false;
    const shouldParseThoughts = parsed ? parsed.shouldParseThoughts : false;
    const modelName = parsed ? parsed.modelName : "unknown";

    function buildHeaders(payload) {
      const headers = {};
      if (req.headers["content-type"])
        headers["content-type"] = req.headers["content-type"];
      headers["connection"] = "close";

      if (!isCerebras) {
        let apiKey = req.headers["x-goog-api-key"];
        if (!apiKey && req.headers["authorization"]) {
          const authHeader = req.headers["authorization"];
          apiKey = authHeader.startsWith("Bearer ")
            ? authHeader.substring(7).trim()
            : authHeader.trim();
        }
        if (!apiKey) apiKey = process.env.GEMINI_API_KEY;
        if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;
      } else if (req.headers["authorization"]) {
        headers["authorization"] = req.headers["authorization"];
      }

      headers["content-length"] = payload.length;
      return headers;
    }

    function sendToGoogle(payload, isRetryAttempt) {
      const options = {
        hostname: targetHost,
        port: 443,
        path: targetPath,
        method: req.method,
        headers: buildHeaders(payload),
        agent: agent,
        timeout: 180000,
      };

      const gReq = https.request(options, (gRes) => {
        if (gRes.statusCode === 200 || gRes.statusCode === 201) {
          try {
            const statePath = path.join(os.tmpdir(), "qwen_limits_state.json");
            let modelKey = "other";
            let dailyLimit = 1500;
            const lowerModel = modelName.toLowerCase();

            if (lowerModel.includes("gemini-3.5-flash-lite")) {
              modelKey = "gemini-3.5-lite";
              dailyLimit = 500;
            } else if (lowerModel.includes("gemini-3.1-flash-lite")) {
              modelKey = "gemini-3.1-lite";
              dailyLimit = 500;
            } else if (lowerModel.includes("gemma")) {
              modelKey = "gemma";
              dailyLimit = 1500;
            }

            const todayStr = new Date().toDateString();
            let fileData = {
              models: {},
              lastResetDate: todayStr,
              remaining: dailyLimit,
              limit: dailyLimit,
              updatedAt: Date.now(),
            };

            if (fs.existsSync(statePath)) {
              try {
                const existing = JSON.parse(fs.readFileSync(statePath, "utf8"));
                if (existing.lastResetDate === todayStr)
                  fileData.models = existing.models || {};
              } catch (err) {}
            }

            const currentRemaining =
              fileData.models[modelKey] !== undefined
                ? fileData.models[modelKey]
                : dailyLimit;
            fileData.models[modelKey] = Math.max(0, currentRemaining - 1);
            fileData.remaining = fileData.models[modelKey];
            fileData.updatedAt = Date.now();

            fs.writeFileSync(
              statePath,
              JSON.stringify(fileData, null, 2),
              "utf8",
            );
          } catch (err) {}
        }

        if (gRes.statusCode !== 200 && gRes.statusCode !== 201) {
          let errBody = "";
          gRes.on("data", (c) => (errBody += c));
          gRes.on("end", () => {
            let parsedErr = null;
            try {
              parsedErr = JSON.parse(errBody);
            } catch (e) {}

            if (
              gRes.statusCode === 429 ||
              parsedErr?.error?.status === "RESOURCE_EXHAUSTED"
            ) {
              errBody = JSON.stringify({
                error: {
                  message:
                    parsedErr?.error?.message ||
                    "Rate limit exceeded. Please try again later.",
                  type: "requests",
                  param: null,
                  code: "rate_limit_exceeded",
                },
              });
            }

            if (
              gRes.statusCode !== 429 &&
              (errBody.includes("exceeds the maximum number of tokens") ||
                errBody.includes("token count exceeds"))
            ) {
              errBody = JSON.stringify({
                error: {
                  message:
                    parsedErr?.error?.message || "Context length exceeded.",
                  type: "invalid_request_error",
                  param: "messages",
                  code: "context_length_exceeded",
                },
              });
            }

            if (gRes.statusCode === 500 && !isRetryAttempt && parsed) {
              console.warn(
                "[Proxy Auto-Retry] Ошибка 500 INTERNAL от Google. Повтор без устаревших подписей...",
              );
              const safePayload = Buffer.from(
                JSON.stringify(stripThoughtSignaturesForRetry(parsed.reqJson)),
                "utf8",
              );
              sendToGoogle(safePayload, true);
              return;
            }

            if (!res.headersSent) {
              res.writeHead(gRes.statusCode, {
                "Content-Type": "application/json",
              });
              res.end(errBody);
            }
          });
          return;
        }

        if (res.headersSent) return;

        res.statusCode = gRes.statusCode;
        Object.keys(gRes.headers).forEach((key) => {
          if (
            !["content-length", "connection", "transfer-encoding"].includes(
              key.toLowerCase(),
            )
          ) {
            res.setHeader(key, gRes.headers[key]);
          }
        });

        const contentType = gRes.headers["content-type"] || "";

        if (contentType.includes("event-stream")) {
          if (shouldParseThoughts) {
            const transformer = new GeminiSSEResponseTransformer();
            gRes.pipe(transformer).pipe(res);
          } else {
            gRes.pipe(res);
          }
        } else if (contentType.includes("json")) {
          let responseBody = "";
          gRes.on("data", (chunk) => (responseBody += chunk));
          gRes.on("end", () => {
            let jsonObj = null;
            try {
              jsonObj = JSON.parse(responseBody);
              cacheThoughtSignatures(jsonObj);
              sanitizeResponseToolCalls(jsonObj);
              stripExtraContent(jsonObj);
              res.end(JSON.stringify(jsonObj));
            } catch (err) {
              res.end(responseBody);
            }
          });
        } else {
          gRes.pipe(res);
        }
      });

      gReq.on("timeout", () =>
        gReq.destroy(new Error("Upstream request timed out")),
      );
      gReq.on("error", (error) => {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: { message: error.message, code: "LOCAL_PROXY_ERROR" },
            }),
          );
        }
      });

      if (payload.length > 0) gReq.write(payload);
      gReq.end();
    }

    sendToGoogle(bodyPayload, false);
  });
});

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || "127.0.0.1";

server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;

server.listen(PORT, HOST, () => {
  console.log(
    `Intellectual Multi-Model Local Proxy running on http://${HOST}:${PORT}`,
  );
  console.log(`Routing via SOCKS5: ${socksProxyUrl}`);
});
