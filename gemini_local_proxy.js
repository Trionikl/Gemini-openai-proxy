const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { Readable, Transform } = require("stream");
const { StringDecoder } = require("string_decoder");
const { SocksProxyAgent } = require("socks-proxy-agent");

// === Встроенный легковесный парсер .env ===
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
      console.log(
        "[Proxy Env] Файл .env успешно загружен и применен к process.env.",
      );
    } catch (e) {
      console.error("[Proxy Env] Ошибка разбора .env:", e.message);
    }
  } else {
    console.log(
      "[Proxy Env] Файл .env не найден, используются переменные окружения по умолчанию.",
    );
  }
}

// Загружаем переменные окружения перед инициализацией агента
loadEnv();

// Подключаемся к запущенному туннелю SOCKS5
const socksProxyUrl = process.env.SOCKS_PROXY || "socks5h://127.0.0.1:1080";
const agent = new SocksProxyAgent(socksProxyUrl);

// Путь к файлу персистентного кэша на диске
const CACHE_PATH = path.join(os.tmpdir(), "qwen_thought_signatures.json");
const thoughtSignaturesCache = new Map();

// Загрузка сохраненного кэша с диска при старте прокси-сервера
try {
  if (fs.existsSync(CACHE_PATH)) {
    const fileContent = fs.readFileSync(CACHE_PATH, "utf8");
    const data = JSON.parse(fileContent);
    for (const [key, val] of Object.entries(data)) {
      thoughtSignaturesCache.set(key, val);
    }
    console.log(
      `[Proxy Cache] Загружено ${thoughtSignaturesCache.size} подписей из локального файла на диске.`,
    );
  }
} catch (e) {
  console.error("[Proxy Cache] Ошибка инициализации кэша с диска:", e.message);
}

// Флаг и таймер для отложенной (не блокирующей) записи кэша на диск
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
      fs.writeFile(CACHE_PATH, JSON.stringify(obj), "utf8", () => {});
    } catch (e) {
      // Игнорируем ошибки записи
    }
  }, 10000); // Оптимизировано (Шаг 3): задержка увеличена до 10 секунд для сбережения ресурса SSD
}

// Безопасная функция записи в кэш с отложенным сохранением на диск
function safeCacheSet(key, value) {
  if (!key) return;
  if (thoughtSignaturesCache.size > 2000) {
    const firstKey = thoughtSignaturesCache.keys().next().value;
    thoughtSignaturesCache.delete(firstKey);
  }
  thoughtSignaturesCache.set(key, value);
  scheduleCacheFlush();
}

// === Функция для получения конфигурации контекста из settings.json ===
function getContextConfig(isGoose) {
  if (isGoose) {
    return { fileNames: [], includeDirectories: [] };
  }

  try {
    const settingsPath = path.join(os.homedir(), ".qwen", "settings.json");
    if (fs.existsSync(settingsPath)) {
      const content = fs.readFileSync(settingsPath, "utf8");
      const settings = JSON.parse(content);
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
  } catch (e) {
    console.error(
      "[Proxy] Ошибка чтения settings.json для получения конфигурации контекста:",
      e.message,
    );
  }

  return { fileNames: [], includeDirectories: [] };
}

// === Умная функция поиска и чтения файлов на диске ===
function findAndReadFile(fileName, includeDirs) {
  for (const dir of includeDirs) {
    const fullPath = path.join(dir, fileName);
    if (fs.existsSync(fullPath)) {
      try {
        return fs.readFileSync(fullPath, "utf8");
      } catch (err) {
        console.error(`[Proxy Loader] Ошибка чтения ${fullPath}:`, err.message);
      }
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

  const qwenDir = path.join(os.homedir(), ".qwen");
  const qwenFullPath = path.join(qwenDir, fileName);
  if (fs.existsSync(qwenFullPath)) {
    try {
      return fs.readFileSync(qwenFullPath, "utf8");
    } catch (err) {}
  }

  return null;
}

// Поиск имени функции в истории диалога по ID вызова инструмента
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

// Глубокое сохранение мысленных подписей из полученного ответа Google
function cacheThoughtSignatures(obj) {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) cacheThoughtSignatures(item);
  } else {
    let sig = null;
    if (
      obj.extra_content &&
      obj.extra_content.google &&
      obj.extra_content.google.thought_signature
    ) {
      sig = obj.extra_content.google.thought_signature;
    } else if (obj.thought_signature) {
      sig = obj.thought_signature;
    } else if (obj.thoughtSignature) {
      sig = obj.thoughtSignature;
    }

    if (obj.id && sig) {
      safeCacheSet(obj.id, sig);
      console.log(
        `[Proxy Cache] Сохранена подпись thought_signature для ID: ${obj.id}`,
      );

      if (obj.function && obj.function.name) {
        const argsText =
          typeof obj.function.arguments === "object"
            ? JSON.stringify(obj.function.arguments)
            : obj.function.arguments;
        console.log(
          `[Proxy Tool Call] -> Модель вызвала инструмент: "${obj.function.name}" с аргументами: ${argsText}`,
        );
      }
    }
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === "object") {
        cacheThoughtSignatures(obj[key]);
      }
    }
  }
}

// Санитайзер исходящих вызовов инструментов: приводит ответы Google к стандартам OpenAI (index, type, JSON arguments)
function sanitizeResponseToolCalls(obj) {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const item = obj[i];
      if (item && typeof item === "object") {
        if (item.function) {
          if (item.index === undefined) {
            item.index = i;
          }
          if (!item.type) {
            item.type = "function";
          }
        }
        sanitizeResponseToolCalls(item);
      }
    }
  } else {
    if (
      obj.function &&
      obj.function.arguments &&
      typeof obj.function.arguments === "object"
    ) {
      console.log(
        `[Proxy Sanitizer] Оцифрованы аргументы функции "${obj.function.name}" из объекта в строку JSON.`,
      );
      obj.function.arguments = JSON.stringify(obj.function.arguments);
    }
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === "object") {
        sanitizeResponseToolCalls(obj[key]);
      }
    }
  }
}

// Очистка нестандартных Google-полей перед отправкой ответа клиенту (Goose / Qwen), чтобы строгие Rust/OpenAI-парсеры не ломались
function stripExtraContent(obj) {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) stripExtraContent(item);
  } else {
    delete obj["extra_content"];
    delete obj["thought_signature"];
    delete obj["thoughtSignature"];
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === "object") {
        stripExtraContent(obj[key]);
      }
    }
  }
}

// === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ДЛЯ ОЧИСТКИ JSON SCHEMA ===
function sanitizeSchema(obj) {
  if (obj === null || typeof obj !== "object") return;

  delete obj["$schema"];
  delete obj["additionalProperties"];
  delete obj["default"];
  delete obj["propertyNames"];
  delete obj["patternProperties"];

  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === "object" && obj[key] !== null) {
      sanitizeSchema(obj[key]);
    }
  }
}

// Полная зачистка "отравленных" thought_signature из истории сообщений.
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

// === КЛАСС-ТРАНСФОРМЕР (Разделение мыслей - адаптировано под Gemma-4 и Gemini) ===
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
        if (transformedLine !== null) {
          this.push(transformedLine + "\n\n");
        }
      }
    }
    callback();
  }

  _flush(callback) {
    this.lineBuffer += this.decoder.end();

    if (this.lineBuffer.trim()) {
      const transformedLine = this.processLine(this.lineBuffer.trim());
      if (transformedLine !== null) {
        this.push(transformedLine + "\n\n");
      }
    }

    const finalFlush = this.flushTagBuffer();
    if (finalFlush) {
      this.push(finalFlush + "\n\n");
    }

    if (this.accumulatedContent.trim() && this.accumulatedSignature) {
      safeCacheSet(this.accumulatedContent.trim(), this.accumulatedSignature);
      console.log(
        `[Proxy Cache] [Stream End] Сохранена подпись для текста: "${this.accumulatedContent.trim().substring(0, 40)}..."`,
      );
    }

    callback();
  }

  processLine(line) {
    if (line.startsWith("data:")) {
      const dataStr = line.substring(5).trim();
      if (dataStr === "[DONE]") {
        return line;
      }

      try {
        const jsonObj = JSON.parse(dataStr);

        cacheThoughtSignatures(jsonObj);
        sanitizeResponseToolCalls(jsonObj); // Конвертируем аргументы в строку и добавляем index при стриминге

        if (jsonObj.choices && jsonObj.choices.length > 0) {
          const choice = jsonObj.choices[0];
          if (choice.delta) {
            let sig = null;
            if (
              choice.delta.extra_content &&
              choice.delta.extra_content.google &&
              choice.delta.extra_content.google.thought_signature
            ) {
              sig = choice.delta.extra_content.google.thought_signature;
            }
            if (sig) {
              this.accumulatedSignature = sig;
            }

            if (typeof choice.delta.content === "string") {
              const content = choice.delta.content;
              const { deltaContent, deltaReasoning } =
                this.processContent(content);

              if (deltaContent) {
                this.accumulatedContent += deltaContent;
              }

              choice.delta.content = deltaContent;
              if (deltaReasoning) {
                choice.delta.reasoning_content = deltaReasoning;
              } else {
                delete choice.delta.reasoning_content;
              }
            }
          }
        }

        // ИСПРАВЛЕНО (Шаг 1): Стираем лишний Google-контент строго после того, как кэшировали подпись
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
        const indexThought = this.tagBuffer.indexOf("<thought>");
        const indexThinking = this.tagBuffer.indexOf("<thinking>");
        const indexThink = this.tagBuffer.indexOf("<think>");

        let index = -1;
        let tagLen = 0;
        let activeTag = "";

        let candidates = [
          { index: indexThought, len: "<thought>".length, tag: "thought" },
          { index: indexThinking, len: "<thinking>".length, tag: "thinking" },
          { index: indexThink, len: "<think>".length, tag: "think" },
        ].filter((c) => c.index !== -1);

        candidates.sort((a, b) => a.index - b.index);

        if (candidates.length > 0) {
          const earliest = candidates[0];
          index = earliest.index;
          tagLen = earliest.len;
          activeTag = earliest.tag;
        }

        if (index !== -1) {
          deltaContent += this.tagBuffer.substring(0, index);
          this.isThinking = true;
          if (activeTag === "thought") this.currentEndTag = "</thought>";
          else if (activeTag === "thinking") this.currentEndTag = "</thinking>";
          else if (activeTag === "think") this.currentEndTag = "</think>";

          this.tagBuffer = this.tagBuffer.substring(index + tagLen);
        } else {
          const partialThought = this.getPartialMatch(
            this.tagBuffer,
            "<thought>",
          );
          const partialThinking = this.getPartialMatch(
            this.tagBuffer,
            "<thinking>",
          );
          const partialThink = this.getPartialMatch(this.tagBuffer, "<think>");

          let partialIndex = -1;
          let partials = [partialThought, partialThinking, partialThink].filter(
            (p) => p !== -1,
          );
          if (partials.length > 0) {
            partialIndex = Math.min(...partials);
          }

          if (partialIndex !== -1) {
            deltaContent += this.tagBuffer.substring(0, partialIndex);
            this.tagBuffer = this.tagBuffer.substring(partialIndex);
            break;
          } else {
            deltaContent += this.tagBuffer;
            this.tagBuffer = "";
          }
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
          const partialIndex = this.getPartialMatch(
            this.tagBuffer,
            this.currentEndTag,
          );
          if (partialIndex !== -1) {
            deltaReasoning += this.tagBuffer.substring(0, partialIndex);
            this.tagBuffer = this.tagBuffer.substring(partialIndex);
            break;
          } else {
            deltaReasoning += this.tagBuffer;
            this.tagBuffer = "";
          }
        }
      }
    }

    return { deltaContent, deltaReasoning };
  }

  getPartialMatch(str, target) {
    const maxLen = Math.min(str.length, target.length - 1);
    for (let len = maxLen; len >= 1; len--) {
      const prefix = target.substring(0, len);
      if (str.endsWith(prefix)) {
        return str.length - len;
      }
    }
    return -1;
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

// === ПРЕОБРАЗОВАНИЕ ВХОДЯЩЕГО ЗАПРОСА ===
function buildRequestBody(rawBodyPayload, isGoose) {
  let reqJson = JSON.parse(rawBodyPayload.toString("utf8"));
  let modelName = reqJson.model || "unknown";

  if (modelName.startsWith("models/")) {
    modelName = modelName.substring(7);
    reqJson.model = modelName;
    console.log(
      `[Proxy Router] Стрипнут префикс 'models/'. Модель приведена к чистому виду: ${modelName}`,
    );
  }

  const isSpoofedGemini = modelName === "deepseek-reasoner";
  if (isSpoofedGemini) {
    modelName = "gemini-3.1-flash-lite";
    reqJson.model = "gemini-3.1-flash-lite";
  }

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
    shouldParseThoughts = false;
    shouldOptimizePrompt = false;
    console.log(
      `[Proxy Router] Обнаружена модель Cerebras: ${modelName}. Перенаправляем трафик на api.cerebras.ai`,
    );
  } else if (isThinkingModel) {
    shouldParseThoughts = true;
    shouldOptimizePrompt = !isGoose;

    let thinkingLevel = "medium";
    if (isGemma4) {
      thinkingLevel = "high";
    } else if (modelName.toLowerCase().includes("pro")) {
      thinkingLevel = "high";
    }

    // РАЗРЕШАЕМ THINKING_CONFIG ДЛЯ ВСЕХ КЛИЕНТОВ (Включая Goose!)
    if (!reqJson.extra_body) reqJson.extra_body = {};
    if (!reqJson.extra_body.google) reqJson.extra_body.google = {};
    reqJson.extra_body.google.thinking_config = {
      thinking_level: thinkingLevel,
      include_thoughts: true,
    };

    console.log(
      `[Proxy Router] Обнаружена модель с рассуждениями: ${modelName}. Клиент: ${isGoose ? "Goose" : "Qwen CLI"}. Уровень мышления: ${thinkingLevel.toUpperCase()}. Thinking_config включен.`,
    );
  } else {
    shouldParseThoughts = false;
    shouldOptimizePrompt = false;
    console.log(
      `[Proxy Router] Модель: ${modelName}. Режим сквозной передачи (Bypass) через Google.`,
    );
  }

  if (!isCerebras) {
    delete reqJson.store;
    delete reqJson.stream_options;
    delete reqJson.parallel_tool_calls;
    delete reqJson.service_tier;
    delete reqJson.reasoning_effort;

    const maxAllowedTokens = 8192;
    if (reqJson.max_tokens && reqJson.max_tokens > maxAllowedTokens) {
      reqJson.max_tokens = maxAllowedTokens;
    }
    if (
      reqJson.max_completion_tokens &&
      reqJson.max_completion_tokens > maxAllowedTokens
    ) {
      reqJson.max_completion_tokens = maxAllowedTokens;
    }

    if (Array.isArray(reqJson.tools)) {
      for (const tool of reqJson.tools) {
        if (
          tool.type === "function" &&
          tool.function &&
          tool.function.parameters
        ) {
          sanitizeSchema(tool.function.parameters);
        }
      }
    }

    if (reqJson.messages && Array.isArray(reqJson.messages)) {
      for (let i = 0; i < reqJson.messages.length; i++) {
        const msg = reqJson.messages[i];

        if (msg.content === null || msg.content === undefined) {
          msg.content = "";
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
          if (reconstructedName) {
            msg.name = reconstructedName;
          } else if (
            reqJson.tools &&
            reqJson.tools[0] &&
            reqJson.tools[0].function
          ) {
            msg.name = reqJson.tools[0].function.name;
          } else {
            msg.name = "tool_function";
          }
        }
      }

      let stubCount = 0;

      for (let i = 0; i < reqJson.messages.length; i++) {
        const msg = reqJson.messages[i];
        if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
          let toolResponses = [];
          for (let j = i + 1; j < reqJson.messages.length; j++) {
            if (
              reqJson.messages[j].role === "assistant" ||
              reqJson.messages[j].role === "user"
            ) {
              break;
            }
            if (reqJson.messages[j].role === "tool") {
              toolResponses.push(reqJson.messages[j]);
            }
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
            } else if (!tc.id || tc.id === "" || tc.id === "null") {
              tc.id =
                `call_sync_${k}_` + Math.random().toString(36).substring(2, 7);
            }
          }

          for (let k = msg.tool_calls.length; k < toolResponses.length; k++) {
            const resp = toolResponses[k];
            if (
              !resp.tool_call_id ||
              resp.tool_call_id === "" ||
              resp.tool_call_id === "null"
            ) {
              resp.tool_call_id =
                `call_orphaned_${k}_` +
                Math.random().toString(36).substring(2, 7);
            }
          }

          const responseIds = new Set(toolResponses.map((r) => r.tool_call_id));
          const originalToolCalls = msg.tool_calls;
          msg.tool_calls = originalToolCalls.filter((tc) =>
            responseIds.has(tc.id),
          );

          const currentCallIds = new Set(msg.tool_calls.map((tc) => tc.id));
          for (const resp of toolResponses) {
            const callId = resp.tool_call_id;
            if (!currentCallIds.has(callId)) {
              msg.tool_calls.push({
                id: callId,
                type: "function",
                function: {
                  name:
                    resp.name ||
                    (reqJson.tools &&
                    reqJson.tools[0] &&
                    reqJson.tools[0].function
                      ? reqJson.tools[0].function.name
                      : "tool_function"),
                  arguments: "{}",
                },
              });
            }
          }

          if (msg.tool_calls.length === 0) {
            delete msg.tool_calls;
          }
        }
      }

      for (const msg of reqJson.messages) {
        if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            if (
              tc.extra_content &&
              tc.extra_content.google &&
              tc.extra_content.google.thought_signature
            ) {
              continue;
            }

            let signatureToInject = "skip_thought_signature_validator";
            if (thoughtSignaturesCache.has(tc.id)) {
              signatureToInject = thoughtSignaturesCache.get(tc.id);
            } else {
              stubCount++;
            }

            tc.extra_content = {
              google: { thought_signature: signatureToInject },
            };
          }
        }

        if (
          msg.role === "assistant" &&
          (!msg.tool_calls || msg.tool_calls.length === 0)
        ) {
          if (msg.content && typeof msg.content === "string") {
            const cleanContent = msg.content.trim();
            if (thoughtSignaturesCache.has(cleanContent)) {
              msg.extra_content = {
                google: {
                  thought_signature: thoughtSignaturesCache.get(cleanContent),
                },
              };
            }
          }
        }
      }

      if (stubCount >= 3) {
        console.warn(
          `[Proxy Warning] В запросе ${stubCount} сообщений с заглушкой skip_thought_signature_validator. ` +
            `Это частая причина стабильной ошибки 500 INTERNAL у Google. Если ошибка повторится, прокси автоматически повторит запрос без строгой валидации подписей.`,
        );
      }
    }

    if (
      shouldOptimizePrompt &&
      reqJson.messages &&
      Array.isArray(reqJson.messages)
    ) {
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
          console.log(`[Proxy Loader] Успешно загружен файл: ${fileName}`);
        }
      }

      for (let msg of reqJson.messages) {
        let msgContentStr = "";
        if (typeof msg.content === "string") {
          msgContentStr = msg.content;
        } else if (Array.isArray(msg.content)) {
          msgContentStr = msg.content
            .map((part) =>
              part && typeof part === "object" && typeof part.text === "string"
                ? part.text
                : "",
            )
            .join(" ");
        }

        if (msg.role === "system") {
          systemMessages.push(msgContentStr);
        } else {
          const isDuplicateFileMsg =
            msg.role === "user" &&
            config.fileNames.some((fileName) => {
              const fileContent = filesMap.get(fileName);
              if (!fileContent) return false;
              if (msgContentStr.length < 200) return false;
              const cleanFileHead = fileContent
                .replace(/\s+/g, "")
                .substring(0, 150)
                .toLowerCase();
              const cleanMsg = msgContentStr.replace(/\s+/g, "").toLowerCase();
              return (
                cleanFileHead.length > 50 && cleanMsg.includes(cleanFileHead)
              );
            });

          if (!isDuplicateFileMsg) {
            otherMessages.push(msg);
          }
        }
      }

      if (otherMessages.length === 0) {
        otherMessages.push({
          role: "user",
          content:
            "Инициализация сессии. Файлы правил проекта успешно загружены.",
        });
      }

      let finalSystemContent = `<system_role>
Ты — автономный, бескомпромиссный ИИ-агент разработчик (Qwen Code Agent). Твоя задача — мгновенное выполнение команд и написание кода.
</system_role>

<critical_instructions>
1. Не задавай вопросов формата "делать мне это или нет". Делай молча и сразу.
2. Не пиши вежливых приветствий, не извиняйся и не размышляй вслух в основном ответе.
3. Полностью и безоговорочно подчиняйся правилам из файлов инструкций, переданных ниже.
4. Выдавай только готовый код или результат работы утилит.
</critical_instructions>`;

      if (systemMessages.length > 0) {
        finalSystemContent += `\n\n<agent_environment_rules>\n${systemMessages.join("\n\n")}\n</agent_environment_rules>`;
      }
      if (agentRulesText) {
        finalSystemContent += `\n\n<agent_rules_do_not_ignore>\n${agentRulesText.trim()}\n</agent_rules_do_not_ignore>`;
      }

      reqJson.messages = [
        { role: "system", content: finalSystemContent },
        ...otherMessages,
      ];
    }
  }

  return {
    reqJson,
    modelName,
    targetHost,
    isCerebras,
    shouldParseThoughts,
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

  let bodyChunks = [];
  req.on("data", (chunk) => bodyChunks.push(chunk));

  req.on("end", () => {
    const rawBodyPayload =
      bodyChunks.length > 0 ? Buffer.concat(bodyChunks) : Buffer.alloc(0);

    let targetHost = "generativelanguage.googleapis.com";
    let targetPath = req.url;

    const userAgent = (req.headers["user-agent"] || "").toLowerCase();
    const originalPath = req.url || "";
    const isGoose =
      userAgent.includes("goose") ||
      userAgent.includes("reqwest") ||
      originalPath.includes("/v1beta/openai/v1/");

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
      } catch (e) {
        console.error(
          "[Proxy] Ошибка при разборе/перегруппировке запроса:",
          e.message,
        );
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

      if (!isCerebras) {
        let apiKey = "";
        if (req.headers["x-goog-api-key"]) {
          apiKey = req.headers["x-goog-api-key"];
        } else if (req.headers["authorization"]) {
          const authHeader = req.headers["authorization"];
          apiKey = authHeader.startsWith("Bearer ")
            ? authHeader.substring(7).trim()
            : authHeader.trim();
        }
        if (!apiKey) {
          apiKey = process.env.GEMINI_API_KEY;
        }
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
        timeout: 180000, // 180 секунд (3 минуты) — согласовано с settings.json
      };

      const targetUrl = `https://${targetHost}${targetPath}`;
      console.log(
        `[Proxy] Направление запроса${isRetryAttempt ? " (ПОВТОР без thought_signature)" : ""}: ${req.method} -> ${targetUrl}`,
      );

      const gReq = https.request(options, (gRes) => {
        console.log(
          `[Proxy] Ответ сервера (${targetHost}): статус ${gRes.statusCode}`,
        );

        if (gRes.statusCode === 200 || gRes.statusCode === 201) {
          try {
            const statePath = path.join(os.tmpdir(), "qwen_limits_state.json");
            let modelKey = "other";
            let dailyLimit = 1500;
            const lowerModel = modelName.toLowerCase();

            if (lowerModel.includes("gemini-3.1-flash-lite")) {
              modelKey = "gemini-lite";
              dailyLimit = 500;
            } else if (lowerModel.includes("gemma")) {
              modelKey = "gemma";
              dailyLimit = 1500;
            } else if (lowerModel.includes("pro")) {
              modelKey = "pro";
              dailyLimit = 50;
            } else if (
              lowerModel.includes("flash") ||
              lowerModel.includes("lite")
            ) {
              modelKey = "other-flash";
              dailyLimit = 20;
            }

            const todayStr = new Date().toDateString();
            let fileData = {
              models: {
                "gemini-lite": 500,
                gemma: 1500,
                pro: 50,
                "other-flash": 20,
                other: 1500,
              },
              lastResetDate: todayStr,
              remaining: dailyLimit,
              limit: dailyLimit,
              updatedAt: Date.now(),
            };

            if (fs.existsSync(statePath)) {
              try {
                const existing = JSON.parse(fs.readFileSync(statePath, "utf8"));
                if (existing.lastResetDate === todayStr) {
                  fileData.models = existing.models || fileData.models;
                  fileData.lastResetDate = existing.lastResetDate;
                }
              } catch (err) {}
            }

            const currentRemaining =
              fileData.models[modelKey] !== undefined
                ? fileData.models[modelKey]
                : dailyLimit;
            fileData.models[modelKey] = Math.max(0, currentRemaining - 1);
            fileData.remaining = fileData.models[modelKey];
            fileData.limit = dailyLimit;
            fileData.updatedAt = Date.now();

            fs.writeFile(statePath, JSON.stringify(fileData), "utf8", () => {});
          } catch (err) {}
        }

        if (gRes.statusCode !== 200 && gRes.statusCode !== 201) {
          let errBody = "";
          gRes.on("data", (c) => (errBody += c));
          gRes.on("end", () => {
            console.error(`[API Error Body from ${targetHost}]: ${errBody}`);

            try {
              const debugPath = path.join(
                os.tmpdir(),
                "qwen_failed_request.json",
              );
              fs.writeFileSync(debugPath, payload, "utf8");
              console.error(
                `[Proxy Debug] Сбойный JSON-запрос сохранен в: ${debugPath}`,
              );
            } catch (err) {}

            // ИСПРАВЛЕНО (Шаги 2 и 4): Безопасно парсим и маппим ошибку превышения лимита токенов в формат OpenAI context_length_exceeded
            let parsedErr = null;
            try {
              parsedErr = JSON.parse(errBody);
            } catch (e) {}

            const isContextLimitExceeded =
              (parsedErr &&
                parsedErr.error &&
                typeof parsedErr.error.message === "string" &&
                (parsedErr.error.message.includes(
                  "exceeds the maximum number of tokens allowed",
                ) ||
                  parsedErr.error.message.includes("token count exceeds"))) ||
              errBody.includes(
                "exceeds the maximum number of tokens allowed",
              ) ||
              errBody.includes("token count exceeds");

            if (isContextLimitExceeded) {
              console.warn(
                "[Proxy] Обнаружено превышение лимита токенов Google. Транслируем ошибку в формат OpenAI context_length_exceeded.",
              );
              const openAiError = {
                error: {
                  message:
                    parsedErr?.error?.message ||
                    "The input token count exceeds the maximum number of tokens allowed 262144.",
                  type: "invalid_request_error",
                  param: "messages",
                  code: "context_length_exceeded",
                },
              };
              errBody = JSON.stringify(openAiError);
            }

            const isInternalError =
              gRes.statusCode === 500 && /internal/i.test(errBody);

            if (isInternalError && !isRetryAttempt && parsed) {
              console.warn(
                "[Proxy Auto-Retry] Google вернул 500 INTERNAL. Вероятная причина: накопленные заглушки " +
                  "thought_signature в истории диалога. Повторяю запрос без thinking_config и без старых подписей...",
              );
              const safeReqJson = stripThoughtSignaturesForRetry(
                parsed.reqJson,
              );
              const safePayload = Buffer.from(
                JSON.stringify(safeReqJson),
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

        // ИСПРАВЛЕНО (Шаг 5): Предотвращаем конфликты HTTP-заголовков при повторном запросе
        if (res.headersSent) return;

        res.statusCode = gRes.statusCode;
        Object.keys(gRes.headers).forEach((key) => {
          const lowerKey = key.toLowerCase();
          if (
            [
              "content-length",
              "connection",
              "keep-alive",
              "transfer-encoding",
              "content-encoding",
            ].includes(lowerKey)
          ) {
            return;
          }
          res.setHeader(key, gRes.headers[key]);
        });

        const contentType = gRes.headers["content-type"] || "";

        if (contentType.includes("event-stream")) {
          if (shouldParseThoughts) {
            const transformer = new GeminiSSEResponseTransformer();
            gRes.pipe(transformer).pipe(res);
            gRes.on("error", (err) => {
              console.error(`[Proxy gRes Error]: ${err.message}`);
              transformer.destroy(err);
              res.destroy(err);
            });
            transformer.on("error", (err) => {
              console.error(`[Proxy Transformer Error]: ${err.message}`);
              res.destroy(err);
            });
          } else {
            gRes.pipe(res);
            gRes.on("error", (err) => {
              console.error(`[Proxy gRes Error]: ${err.message}`);
              res.destroy(err);
            });
          }
        } else if (contentType.includes("json")) {
          let responseBody = "";
          gRes.on("data", (chunk) => (responseBody += chunk));
          gRes.on("end", () => {
            // ИСПРАВЛЕНО (Шаги 1 и 4): Безопасно парсим JSON, сохраняем подписи, санитизируем, и только перед отправкой вызываем stripExtraContent
            let jsonObj = null;
            try {
              jsonObj = JSON.parse(responseBody);
              cacheThoughtSignatures(jsonObj);
              sanitizeResponseToolCalls(jsonObj);
            } catch (err) {
              console.error(
                "[Proxy] Ошибка безопасного парсинга JSON ответа:",
                err.message,
              );
            }

            if (jsonObj && shouldParseThoughts) {
              try {
                if (
                  jsonObj.choices &&
                  jsonObj.choices.length > 0 &&
                  jsonObj.choices[0].message
                ) {
                  const message = jsonObj.choices[0].message;
                  let content = message.content || "";

                  let startTag = "";
                  let endTag = "";
                  if (
                    content.includes("<thought>") &&
                    content.includes("</thought>")
                  ) {
                    startTag = "<thought>";
                    endTag = "</thought>";
                  } else if (
                    content.includes("<thinking>") &&
                    content.includes("</thinking>")
                  ) {
                    startTag = "<thinking>";
                    endTag = "</thinking>";
                  } else if (
                    content.includes("<think>") &&
                    content.includes("</think>")
                  ) {
                    startTag = "<think>";
                    endTag = "</think>";
                  }

                  if (startTag && endTag) {
                    const start = content.indexOf(startTag);
                    const end = content.indexOf(endTag);
                    const reasoning = content.substring(
                      start + startTag.length,
                      end,
                    );
                    const newContent =
                      content.substring(0, start) +
                      content.substring(end + endTag.length);

                    message.content = newContent;
                    message.reasoning_content = reasoning;

                    let sig =
                      message.extra_content &&
                      message.extra_content.google &&
                      message.extra_content.google.thought_signature;
                    if (sig) safeCacheSet(newContent.trim(), sig);
                  } else {
                    let sig =
                      message.extra_content &&
                      message.extra_content.google &&
                      message.extra_content.google.thought_signature;
                    if (sig && content) safeCacheSet(content.trim(), sig);
                  }
                }
              } catch (processingError) {
                console.error(
                  "[Proxy] Ошибка постобработки JSON:",
                  processingError.message,
                );
              }
            }

            if (jsonObj) {
              stripExtraContent(jsonObj); // Вырезаем Google-поля строго перед отправкой клиенту
              res.end(JSON.stringify(jsonObj));
            } else {
              res.end(responseBody);
            }
          });
        } else {
          gRes.pipe(res);
        }
      });

      gReq.on("timeout", () => {
        console.error(
          `[Proxy Timeout] Исходящее соединение через SOCKS-туннель зависло (таймаут 180 сек). Принудительный разрыв сокета.`,
        );
        gReq.destroy(new Error("Upstream request timed out"));
      });

      gReq.on("error", (error) => {
        console.error(`[Proxy Connection Error]: ${error.message}`);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error_type: "LOCAL_PROXY_CRASH",
              message: `Proxy timeout or connection lost: ${error.message}`,
              attempted_url: targetUrl,
            }),
          );
        } else {
          console.error(
            `[Proxy Streaming Error] Aborting client stream response due to error.`,
          );
          res.destroy(error);
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

server.listen(PORT, HOST, () => {
  console.log(
    `Intellectual Multi-Model Local Proxy running on http://${HOST}:${PORT}`,
  );
  console.log(`Routing all outbound traffic via SOCKS5 on ${socksProxyUrl}`);
});
