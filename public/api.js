// ---- Direct API layer (client-only) ----
// This file holds everything that used to live in server.js: the provider model
// catalog, cost computation, system prompts, structured-output schemas, and the
// calls to the AI providers / ElevenLabs. The app is fully static — each user
// supplies their own API keys (stored in localStorage, see Settings) and the
// browser calls the providers directly. No server, nothing persisted.
//
// Multiple providers are supported through a small adapter layer: every provider
// implements one `complete({ modelId, system, messages, schema, maxTokens })`
// function that returns `{ text, usage }`. The neutral message shape is
// `[{ role: "user"|"assistant", content: string }]` and `system` is a string;
// each adapter translates that into its provider's request format. The roleplay
// turns rely on JSON-schema structured output, which every provider here
// supports (Anthropic output_config, OpenAI response_format, Gemini
// responseSchema).

function getKey(name) {
  return (localStorage.getItem(name) || "").trim();
}
// Kept for the TTS helpers below.
function getElevenLabsKey() {
  return getKey("elevenLabsApiKey");
}

// Sentinel model value for the user-configured OpenAI-compatible endpoint
// (its real model id lives in a settings field, not in any fixed catalog).
const CUSTOM_MODEL_VALUE = "__custom__";

// Provider catalog. Pricing is $/Mtok. NOTE: only the Anthropic numbers are
// authoritative; the OpenAI/Gemini prices are approximate (as of 2026-06) and
// drive only the cost-ticker estimate — update them here if they drift. Model
// ids must be valid for the provider; add/remove freely.
const PROVIDERS = {
  anthropic: {
    label: "Anthropic",
    keyName: "anthropicApiKey",
    models: [
      { id: "claude-haiku-4-5", label: "Haiku 4.5", in: 1, out: 5 },
      { id: "claude-sonnet-4-6", label: "Sonnet 4.6", in: 3, out: 15 },
      { id: "claude-opus-4-8", label: "Opus 4.8", in: 5, out: 25 },
    ],
    complete: anthropicComplete,
  },
  openai: {
    label: "OpenAI",
    keyName: "openaiApiKey",
    models: [
      { id: "gpt-4o-mini", label: "GPT-4o mini", in: 0.15, out: 0.6 },
      { id: "gpt-4.1-mini", label: "GPT-4.1 mini", in: 0.4, out: 1.6 },
      { id: "gpt-4.1", label: "GPT-4.1", in: 2, out: 8 },
      { id: "gpt-5-mini", label: "GPT-5 mini", in: 0.25, out: 2 },
      { id: "gpt-5", label: "GPT-5", in: 1.25, out: 10 },
    ],
    complete: openaiComplete,
  },
  gemini: {
    label: "Google Gemini",
    keyName: "geminiApiKey",
    models: [
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", in: 0.3, out: 2.5 },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", in: 1.25, out: 10 },
    ],
    complete: geminiComplete,
  },
  compatible: {
    label: "OpenAI-compatible",
    keyName: "compatibleApiKey",
    models: [], // model id + base URL come from settings; see CUSTOM_MODEL_VALUE
    complete: compatibleComplete,
  },
};

const DEFAULT_MODEL = "claude-haiku-4-5";

// Resolve a dropdown value into { providerId, provider, modelId, pricing }.
// pricing is null for the custom endpoint (cost can't be known).
function resolveModel(selected) {
  if (selected === CUSTOM_MODEL_VALUE) {
    return {
      providerId: "compatible",
      provider: PROVIDERS.compatible,
      modelId: getKey("compatibleModel"),
      pricing: null,
    };
  }
  for (const [pid, p] of Object.entries(PROVIDERS)) {
    const m = p.models.find((x) => x.id === selected);
    if (m) {
      return { providerId: pid, provider: p, modelId: m.id, pricing: { in: m.in, out: m.out } };
    }
  }
  const p = PROVIDERS.anthropic;
  const m = p.models.find((x) => x.id === DEFAULT_MODEL);
  return { providerId: "anthropic", provider: p, modelId: DEFAULT_MODEL, pricing: { in: m.in, out: m.out } };
}

// Grouped options for building the model <select> (one <optgroup> per provider).
function getModelOptions() {
  return Object.entries(PROVIDERS).map(([pid, p]) => ({
    label: p.label,
    options:
      pid === "compatible"
        ? [{ value: CUSTOM_MODEL_VALUE, label: "Custom (OpenAI-compatible)" }]
        : p.models.map((m) => ({ value: m.id, label: m.label })),
  }));
}

// Is the selected model usable — i.e. is its provider's key (and, for the custom
// endpoint, the base URL + model id) configured?
function hasKeyForModel(selected) {
  if (!selected) return false; // no model chosen yet
  const r = resolveModel(selected);
  if (r.providerId === "compatible") {
    return Boolean(getKey("compatibleBaseUrl") && getKey("compatibleModel"));
  }
  return Boolean(getKey(r.provider.keyName));
}

function computeCost(pricing, usage) {
  const inTok = usage.input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const outTok = usage.output_tokens ?? 0;
  return (
    (inTok * pricing.in + cacheRead * pricing.in * 0.1 + cacheWrite * pricing.in * 1.25 + outTok * pricing.out) / 1e6
  );
}

function usagePayload(modelId, pricing, usage) {
  return {
    model: modelId,
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    // Custom endpoints have no known pricing → cost stays 0 (untracked).
    cost: pricing ? computeCost(pricing, usage) : 0,
  };
}

// ---- Structured output schemas ----
const TURN_SCHEMA = {
  type: "object",
  properties: {
    learner_translation: {
      type: "string",
      description:
        "Your best interpretation of what the learner meant, in English.",
    },
    corrected_message: {
      type: "string",
      description:
        "The learner's message rewritten the way a native speaker would express that same intent. Stay close to their attempt — fix errors, don't restyle. Include proper accents and inverted punctuation.",
    },
    natural_message: {
      type: "string",
      description:
        "Only if a native speaker from Spain would typically express this intent noticeably differently from corrected_message — a set phrase, more idiomatic wording, or different structure — provide that natural version (matching register: informal tú unless the situation calls for usted). Empty string when corrected_message is already how a native would say it. Do not fill this with trivial variants.",
    },
    notes: {
      type: "string",
      description:
        "Brief explanation of the corrections and any useful tips, in English. Empty string if the message was already fine. If natural_message is provided, briefly say why it's the more natural phrasing. Never comment on missing accents, missing inverted punctuation, or missing capitalization at the start of sentences.",
    },
    mistake_tags: {
      type: "array",
      items: { type: "string" },
      description:
        "Short kebab-case category tags, one per distinct grammar/vocab mistake, e.g. ser-vs-estar, gender-agreement, verb-conjugation, word-order, preposition-choice, missing-article, vocab-false-friend, regional-vocab-spain, vosotros-forms, reflexive-verbs, preterite-vs-imperfect. Empty array if no mistakes. Do not tag accent, punctuation, or capitalization issues. Reuse the same tag spelling for the same mistake type across turns.",
    },
    reply_es: {
      type: "string",
      description: "Your in-character reply, in Spanish.",
    },
    reply_en: {
      type: "string",
      description: "English translation of reply_es.",
    },
  },
  required: [
    "learner_translation",
    "corrected_message",
    "natural_message",
    "notes",
    "mistake_tags",
    "reply_es",
    "reply_en",
  ],
  additionalProperties: false,
};

const OPENING_SCHEMA = {
  type: "object",
  properties: {
    reply_es: { type: "string", description: "Your in-character opening line, in Spanish." },
    reply_en: { type: "string", description: "English translation of reply_es." },
  },
  required: ["reply_es", "reply_en"],
  additionalProperties: false,
};

// ---- System prompts ----
function chatSystemPrompt(situation) {
  return `You are a friendly native Spanish speaker from Spain helping an English-speaking beginner practice Spanish through roleplay. The learner is moving to Spain, so always use Castilian (Peninsular) Spanish: vosotros for informal plural you, Spain vocabulary and expressions (vale, coger, ordenador, movil, zumo, patatas, conducir, echar de menos, etc.), and Spain usage generally.

When correcting, prefer how it would naturally be said in Spain. If the learner uses a Latin American form that differs in Spain (e.g. ustedes for informal plural, jugo, computadora, manejar), correct it to the Spain form and briefly explain the regional difference in notes.

Roleplay situation: ${situation}

Stay in character as a person who makes sense in this situation. Keep your replies very short and simple (1-2 sentences, beginner-friendly vocabulary) so the learner is likely to understand, and naturally include a question in each reply to keep the conversation going.

The learner has not set up their keyboard for Spanish accents or inverted punctuation, so never treat missing accents, missing tildes, missing ¿/¡, or missing capitalization at the start of sentences as mistakes.

For every learner message, produce the structured turn data: your interpretation of their intent, the corrected version of their message (close to their attempt, errors fixed), the natural version (only when a native would phrase it noticeably differently), correction notes, mistake category tags, and your in-character reply with its English translation.`;
}

function tutorSystemPrompt(transcript) {
  return `You are a patient, expert Spanish tutor answering questions from an English-speaking beginner who is moving to Spain. Teach Castilian (Peninsular) Spanish: default to Spain vocabulary, usage, and the vosotros forms, and point out Spain-vs-Latin-America differences when they're relevant to the question. Answer in English, concisely and clearly, with short Spanish examples where helpful. Plain text only — no markdown headings or bullets unless genuinely useful.

The learner is currently having a Spanish practice conversation. Here is the transcript so far, so you can answer questions about it ("why was my last message wrong?", etc.):

<transcript>
${transcript || "(no conversation yet)"}
</transcript>`;
}

// The AI starts each new session in character (greeting + a question), so the
// learner doesn't face a blank chat. No correction fields — there's no learner
// message yet. The client seeds its chat history with OPENING_HISTORY_SEED (in
// app.js, kept in sync with this) so later turns still start with a valid user
// message.
const OPENING_INSTRUCTION =
  "Start the roleplay yourself: greet the learner in character and say one short, simple opening line (1-2 sentences, beginner-friendly) that fits the situation, ending with a question to get the conversation going. Produce only your in-character Spanish line and its English translation.";

// ---- Provider-agnostic entry points ----
class MissingKeyError extends Error {}

async function complete({ model, system, messages, schema, maxTokens }) {
  if (!model) throw new MissingKeyError("Choose a model in Settings (⚙) to start practicing.");
  const r = resolveModel(model);
  const out = await r.provider.complete({ modelId: r.modelId, system, messages, schema, maxTokens });
  return { text: out.text, usage: usagePayload(r.modelId, r.pricing, out.usage) };
}

async function apiChat({ situation, history = [], message, model }) {
  const { text, usage } = await complete({
    model,
    system: chatSystemPrompt(situation),
    messages: [...history, { role: "user", content: message }],
    schema: TURN_SCHEMA,
    maxTokens: 16000,
  });
  const turn = JSON.parse(text);
  // The model occasionally emits stray backslash artifacts in notes
  // (e.g. "\\an'" or "\\\\" where an em-dash belongs). Backslashes are never
  // legitimate in notes text, so drop those tokens.
  if (turn.notes) {
    turn.notes = turn.notes.replace(/\\+\S*/g, "").replace(/ {2,}/g, " ").trim();
  }
  return { ...turn, usage };
}

async function apiOpening({ situation, model }) {
  const { text, usage } = await complete({
    model,
    system: chatSystemPrompt(situation),
    messages: [{ role: "user", content: OPENING_INSTRUCTION }],
    schema: OPENING_SCHEMA,
    maxTokens: 4000,
  });
  return { ...JSON.parse(text), usage };
}

async function apiTutor({ history = [], question, transcript = "", model }) {
  const { text, usage } = await complete({
    model,
    system: tutorSystemPrompt(transcript),
    messages: [...history, { role: "user", content: question }],
    maxTokens: 16000,
  });
  return { answer: text, usage };
}

// ---- Provider adapters ----
// Each returns { text, usage } with usage carrying { input_tokens, output_tokens }
// (Anthropic additionally carries cache_* fields, used by computeCost).

// Anthropic Messages API. `anthropic-dangerous-direct-browser-access` opts into
// CORS for browser requests — safe here because it's the user's own key. Sonnet
// and Opus use adaptive thinking; Haiku doesn't support it.
async function anthropicComplete({ modelId, system, messages, schema, maxTokens }) {
  const key = getKey("anthropicApiKey");
  if (!key) throw new MissingKeyError("Add your Anthropic API key in Settings (⚙) to use this model.");
  const body = { model: modelId, max_tokens: maxTokens, system, messages };
  if (modelId !== "claude-haiku-4-5") body.thinking = { type: "adaptive" };
  if (schema) body.output_config = { format: { type: "json_schema", schema } };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Anthropic request failed (${res.status})`);
  return { text: data.content?.find((b) => b.type === "text")?.text ?? "", usage: data.usage ?? {} };
}

// OpenAI Chat Completions. Structured output via response_format json_schema
// (strict). api.openai.com allows direct browser calls with a user key.
async function openaiComplete({ modelId, system, messages, schema, maxTokens }) {
  const key = getKey("openaiApiKey");
  if (!key) throw new MissingKeyError("Add your OpenAI API key in Settings (⚙) to use this model.");
  return openaiStyleCall({
    url: "https://api.openai.com/v1/chat/completions",
    key,
    modelId,
    system,
    messages,
    schema,
    maxTokens,
    tokenParam: "max_completion_tokens",
    strict: true,
    label: "OpenAI",
  });
}

// Any OpenAI-compatible endpoint (OpenRouter, Groq, Together, vLLM, Ollama, ...).
// Base URL + model id come from Settings; the key is optional (local servers
// often need none). Uses max_tokens (broadest compatibility) and non-strict
// json_schema since support varies by backend.
async function compatibleComplete({ modelId, system, messages, schema, maxTokens }) {
  const base = getKey("compatibleBaseUrl");
  if (!base) throw new MissingKeyError("Set the custom endpoint's Base URL in Settings (⚙).");
  if (!modelId) throw new MissingKeyError("Set the custom endpoint's Model id in Settings (⚙).");
  const url = base.replace(/\/+$/, "") + "/chat/completions";
  return openaiStyleCall({
    url,
    key: getKey("compatibleApiKey"), // optional
    modelId,
    system,
    messages,
    schema,
    maxTokens,
    tokenParam: "max_tokens",
    strict: false,
    label: "Endpoint",
  });
}

// Shared request/response handling for OpenAI-shaped chat APIs.
async function openaiStyleCall({ url, key, modelId, system, messages, schema, maxTokens, tokenParam, strict, label }) {
  const body = {
    model: modelId,
    messages: [{ role: "system", content: system }, ...messages],
    [tokenParam]: maxTokens,
  };
  if (schema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "response", ...(strict ? { strict: true } : {}), schema },
    };
  }
  const headers = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `${label} request failed (${res.status})`);
  const u = data.usage ?? {};
  return {
    text: data.choices?.[0]?.message?.content ?? "",
    usage: { input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0 },
  };
}

// Google Gemini generateContent. Auth via x-goog-api-key header. Structured
// output via responseMimeType + responseSchema (Gemini's OpenAPI-subset schema).
async function geminiComplete({ modelId, system, messages, schema, maxTokens }) {
  const key = getKey("geminiApiKey");
  if (!key) throw new MissingKeyError("Add your Google Gemini API key in Settings (⚙) to use this model.");
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    generationConfig: { maxOutputTokens: maxTokens },
  };
  if (schema) {
    body.generationConfig.responseMimeType = "application/json";
    body.generationConfig.responseSchema = toGeminiSchema(schema);
  }
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Gemini request failed (${res.status})`);
  const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
  const u = data.usageMetadata ?? {};
  return { text, usage: { input_tokens: u.promptTokenCount ?? 0, output_tokens: u.candidatesTokenCount ?? 0 } };
}

// Convert our JSON Schema to Gemini's schema dialect: uppercase type enums, drop
// additionalProperties (unsupported), and pin field order via propertyOrdering.
function toGeminiSchema(s) {
  const TYPE = {
    object: "OBJECT", string: "STRING", number: "NUMBER",
    integer: "INTEGER", boolean: "BOOLEAN", array: "ARRAY",
  };
  const out = {};
  if (s.type) out.type = TYPE[s.type] || String(s.type).toUpperCase();
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum;
  if (s.properties) {
    out.properties = {};
    for (const k of Object.keys(s.properties)) out.properties[k] = toGeminiSchema(s.properties[k]);
    out.propertyOrdering = Object.keys(s.properties);
  }
  if (s.required) out.required = s.required;
  if (s.items) out.items = toGeminiSchema(s.items);
  return out;
}

// ---- Text-to-speech (ElevenLabs, direct browser call) ----
const TTS_MODEL = "eleven_multilingual_v2";

// ElevenLabs premade voices (work on the free plan). The multilingual model
// speaks good Spanish with any of these.
const TTS_VOICES = [
  ["onwK4e9ZLuTAKqWW03F9", "Daniel"],
  ["JBFqnCBsd6RMkjVDRZzb", "George"],
  ["EXAVITQu4vr4xnSDxMaL", "Sarah"],
  ["XB0fDUnXU5powFXDhCwa", "Charlotte"],
  ["cjVigY5qzO86Huf0OWal", "Eric"],
  ["pFZP5JQG7iQjIQuC4Bku", "Lily"],
];

// One consistent voice per session (so the roleplay partner doesn't change
// voice mid-conversation), varying across sessions.
function ttsVoiceForSession(sessionId) {
  let h = 0;
  for (const ch of String(sessionId || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TTS_VOICES[h % TTS_VOICES.length];
}

function ttsEnabled() {
  return Boolean(getElevenLabsKey());
}

async function apiTts({ text, sessionId, slow }) {
  const key = getElevenLabsKey();
  if (!key) throw new Error("TTS not configured — add an ElevenLabs API key in Settings.");
  if (!text || typeof text !== "string" || text.length > 600) {
    throw new Error("text is required (max 600 chars)");
  }
  const speed = slow ? 0.8 : 1.0;
  const [voiceId] = ttsVoiceForSession(sessionId);
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: TTS_MODEL, voice_settings: { speed } }),
    }
  );
  if (!res.ok) {
    let detail = `TTS failed (${res.status})`;
    try {
      detail = (await res.json())?.detail?.message || detail;
    } catch {}
    throw new Error(detail);
  }
  return await res.blob();
}
