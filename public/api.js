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

function providerKeyName(pid) {
  return PROVIDERS[pid]?.keyName;
}

// The cheap default model to start a provider on (first in its catalog, which
// is ordered cheapest-first). The custom endpoint has no catalog → its sentinel.
function firstModelForProvider(pid) {
  if (pid === "compatible") return CUSTOM_MODEL_VALUE;
  return PROVIDERS[pid]?.models[0]?.id || "";
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
        "Teaching notes in English that add something the learner CANNOT already see from the before/after correction and the natural_message — do NOT restate what you changed or repeat the natural phrasing. Use it for the underlying rule or reason behind a fix (so they can generalize it next time), a genuinely useful tip, a common pitfall to avoid, or a usage/register/regional nuance. One or two short sentences. Empty string when the correction is self-explanatory and there's nothing new worth adding — prefer empty over filler. Follow the system prompt's policy on accents/punctuation.",
    },
    mistake_tags: {
      type: "array",
      items: { type: "string" },
      description:
        "Short kebab-case category tags, one per distinct grammar/vocab mistake, e.g. ser-vs-estar, gender-agreement, verb-conjugation, word-order, preposition-choice, missing-article, vocab-false-friend, regional-vocab-spain, vosotros-forms, reflexive-verbs, preterite-vs-imperfect. Empty array if no mistakes. For accent/punctuation/capitalization, follow the system prompt's policy. Reuse the same tag spelling for the same mistake type across turns.",
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

// String fields of a turn the UI reads directly — used to backfill responses
// from non-strict endpoints (mistake_tags, the lone array, is handled separately).
const TURN_STRING_FIELDS = [
  "learner_translation",
  "corrected_message",
  "natural_message",
  "notes",
  "reply_es",
  "reply_en",
];

const OPENING_SCHEMA = {
  type: "object",
  properties: {
    reply_es: { type: "string", description: "Your in-character opening line, in Spanish." },
    reply_en: { type: "string", description: "English translation of reply_es." },
  },
  required: ["reply_es", "reply_en"],
  additionalProperties: false,
};

// ---- Difficulty levels (CEFR A1–B2) ----
// One registry, three prompt fragments per level: `reply` shapes how the AI
// partner speaks, `scenario` how complex a generated situation is, `correction`
// how strict/deep the feedback is. Injected into the prompts below; the bare
// CEFR label is also named so the model leans on its own CEFR prior. Ordered
// easiest-first. Tune the calibration here — it's the only place it lives.
const LEVELS = {
  A1: {
    label: "A1 · Beginner",
    reply:
      "one short sentence (occasionally two), only high-frequency everyday vocabulary, and the present tense almost exclusively. No idioms or complex grammar",
    scenario:
      "a simple, concrete, transactional situation (ordering, greetings, basic shopping, asking directions) with a single clear goal",
    correction:
      "Correct only the most important errors that block meaning. Keep notes very brief and encouraging; don't overwhelm the beginner with minor nuance.",
  },
  A2: {
    label: "A2 · Elementary",
    reply:
      "one or two short, simple sentences using everyday vocabulary; you may use the past and near-future tenses. Keep idioms rare and obvious",
    scenario:
      "an everyday situation with a little more detail (making plans, a short errand with a small complication, simple small talk)",
    correction:
      "Correct the main grammar and vocabulary errors. Keep notes short and encouraging, with the occasional useful tip.",
  },
  B1: {
    label: "B1 · Intermediate",
    reply:
      "two or three natural but clear sentences at a conversational pace, using a normal range of tenses (including past, future, conditional), common connectors, and some common idioms",
    scenario:
      "a richer everyday or mildly unexpected situation (resolving a misunderstanding, giving opinions on plans, sorting out a minor problem)",
    correction:
      "Correct grammar, vocabulary, and word choice, and point out phrasing that sounds unnatural. Notes can be a bit more detailed.",
  },
  B2: {
    label: "B2 · Upper-intermediate",
    reply:
      "two to four sentences at a natural pace, close to how you'd speak with a native — the full range of tenses (including the subjunctive), idioms, and colloquial Spain expressions",
    scenario:
      "a complex or abstract situation (making a complaint, negotiating, defending an opinion, an interview, a nuanced social moment)",
    correction:
      "Correct subtle issues too — register, idiom, naturalness, and nuance — not just outright errors. Notes can be detailed and address style.",
  },
};

const DEFAULT_LEVEL = "A1";

// Resolve a stored level id to its definition, falling back to the default.
function getLevel(id) {
  return LEVELS[id] || LEVELS[DEFAULT_LEVEL];
}

// [{ value, label }] for building the level <select> (easiest-first).
function getLevelOptions() {
  return Object.entries(LEVELS).map(([value, l]) => ({ value, label: l.label }));
}

// ---- System prompts ----
// `strict` toggles how accents/inverted punctuation are judged (see the
// "Correct accents & punctuation" setting). Either way corrected_message is
// always written with proper accents; strict only decides whether the learner's
// omissions count as mistakes (tagged / noted) or are silently fixed.
// `level` (CEFR id) scales the partner's speech and the feedback depth.
function chatSystemPrompt(situation, strict = false, level = DEFAULT_LEVEL) {
  const lvl = getLevel(level);
  const accentPolicy = strict
    ? `Treat missing or incorrect accents/tildes, missing ¿/¡, and missing capitalization at the start of sentences as mistakes: fix them in the corrected version, and you may note the meaning-changing ones (e.g. sí vs si, tú vs tu) and tag them (accent, punctuation, capitalization). Don't belabor every trivial accent in notes — focus on what's most useful.`
    : `The learner has not set up their keyboard for Spanish accents or inverted punctuation, so never treat missing accents, missing tildes, missing ¿/¡, or missing capitalization at the start of sentences as mistakes. Always write the corrected version with proper accents and punctuation, but don't flag, tag, or comment on the learner's omissions of them.`;
  return `You are a friendly native Spanish speaker from Spain helping an English-speaking learner practice Spanish through roleplay. The learner is moving to Spain, so always use Castilian (Peninsular) Spanish: vosotros for informal plural you, Spain vocabulary and expressions (vale, coger, ordenador, movil, zumo, patatas, conducir, echar de menos, etc.), and Spain usage generally.

The learner is at CEFR level ${level}. Pitch the conversation to that level: ${lvl.reply}. Naturally include a question in each reply to keep the conversation going.

When correcting, prefer how it would naturally be said in Spain. If the learner uses a Latin American form that differs in Spain (e.g. ustedes for informal plural, jugo, computadora, manejar), correct it to the Spain form and briefly explain the regional difference in notes. ${lvl.correction}

Roleplay situation: ${situation}

Stay in character as a person who makes sense in this situation.

${accentPolicy}

The learner sees the before/after correction and the natural version on their own, so don't waste the notes field restating them. Use notes only to add something they can't already see: the rule or reason behind a fix so they can apply it next time, a quick tip, a common pitfall, or a usage nuance. If there's nothing worth adding, leave notes empty rather than narrating the obvious.

For every learner message, produce the structured turn data: your interpretation of their intent, the corrected version of their message (close to their attempt, errors fixed), the natural version (only when a native would phrase it noticeably differently), notes (only genuinely new teaching value — see above), mistake category tags, and your in-character reply with its English translation.`;
}

function tutorSystemPrompt(transcript, level = DEFAULT_LEVEL) {
  return `You are a patient, expert Spanish tutor answering questions from an English-speaking learner (CEFR level ${level}) who is moving to Spain. Pitch your explanations to that level — simpler and more concrete for A1/A2, more detailed and nuanced for B1/B2. Teach Castilian (Peninsular) Spanish: default to Spain vocabulary, usage, and the vosotros forms, and point out Spain-vs-Latin-America differences when they're relevant to the question. Answer in English, concisely and clearly, with short Spanish examples where helpful. Plain text only — no markdown headings or bullets unless genuinely useful.

The learner is currently having a Spanish practice conversation. Here is the transcript so far, so you can answer questions about it ("why was my last message wrong?", etc.):

<transcript>
${transcript || "(no conversation yet)"}
</transcript>`;
}

// The AI starts each new session in character (greeting + a question), so the
// learner doesn't face a blank chat. No correction fields — there's no learner
// message yet. app.js (seedOpeningHistory) reuses this same constant to seed the
// chat history, so later turns still start with a valid user message.
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

// Parse a structured-output response. An empty/invalid body usually means the
// model spent its whole token budget on thinking (common on Gemini 2.5 / GPT-5
// reasoning models) or the endpoint ignored the schema — surface that instead of
// a raw "Unexpected end of JSON input".
function parseStructured(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("The model didn't return a usable response (it may have run out of output budget). Please try again.");
  }
}

async function apiChat({ situation, history = [], message, model, strict = false, level = DEFAULT_LEVEL }) {
  const { text, usage } = await complete({
    model,
    system: chatSystemPrompt(situation, strict, level),
    messages: [...history, { role: "user", content: message }],
    schema: TURN_SCHEMA,
    maxTokens: 16000,
  });
  const turn = parseStructured(text);
  // Custom OpenAI-compatible endpoints run non-strict, so a backend may omit or
  // mistype fields. Coerce everything the UI dereferences into a safe shape so
  // a sloppy endpoint degrades to blanks instead of crashing the renderer.
  for (const f of TURN_STRING_FIELDS) {
    if (typeof turn[f] !== "string") turn[f] = "";
  }
  if (!Array.isArray(turn.mistake_tags)) turn.mistake_tags = [];
  // The model occasionally emits stray backslash artifacts in notes
  // (e.g. "\\an'" or "\\\\" where an em-dash belongs). Backslashes are never
  // legitimate in notes text, so drop those tokens.
  if (turn.notes) {
    turn.notes = turn.notes.replace(/\\+\S*/g, "").replace(/ {2,}/g, " ").trim();
  }
  return { ...turn, usage };
}

async function apiOpening({ situation, model, level = DEFAULT_LEVEL }) {
  const { text, usage } = await complete({
    model,
    system: chatSystemPrompt(situation, false, level),
    messages: [{ role: "user", content: OPENING_INSTRUCTION }],
    schema: OPENING_SCHEMA,
    maxTokens: 6000,
  });
  const turn = parseStructured(text);
  if (typeof turn.reply_es !== "string") turn.reply_es = "";
  if (typeof turn.reply_en !== "string") turn.reply_en = "";
  return { ...turn, usage };
}

async function apiTutor({ history = [], question, transcript = "", model, level = DEFAULT_LEVEL }) {
  const { text, usage } = await complete({
    model,
    system: tutorSystemPrompt(transcript, level),
    messages: [...history, { role: "user", content: question }],
    maxTokens: 16000,
  });
  return { answer: text, usage };
}

// ---- Scenario generation ----
// Each conversation starts from a freshly AI-generated scenario (replacing the
// old pre-generated deck). A random theme hint keeps the spread wide.
const SCENARIO_SCHEMA = {
  type: "object",
  properties: {
    learner: {
      type: "string",
      description:
        'What the learner sees in a small header, so keep it SHORT: one concise sentence (roughly 8–16 words) naming the situation and the learner\'s own role, addressed as "You". Do not describe the AI partner here.',
    },
    ai: {
      type: "string",
      description:
        'Hidden from the learner, used to instruct the model: the setting plus the AI roleplay partner\'s persona/role and any helpful detail, addressed as "You". As long as is genuinely helpful (1–3 sentences).',
    },
    voice_gender: {
      type: "string",
      enum: ["male", "female"],
      description:
        "The gender of the AI roleplay partner, so a matching voice can be chosen for audio. Pick whichever fits the persona; for an ambiguous role, just pick one.",
    },
  },
  required: ["learner", "ai", "voice_gender"],
  additionalProperties: false,
};

function scenarioSystemPrompt(level = DEFAULT_LEVEL) {
  const lvl = getLevel(level);
  return `You generate a single roleplay scenario for an English speaker practicing Spanish who is moving to Spain. Set it in Spain (vary the cities and regions) and assume Castilian Spanish. The learner is at CEFR level ${level}, so make it ${lvl.scenario}. Return these fields in English:
- "learner": shown to the learner in a small header, so keep it SHORT — one concise sentence (roughly 8–16 words) naming the situation and the LEARNER's own role, addressed as "You". Do not describe the AI partner.
- "ai": hidden from the learner, used to instruct the model — the setting plus the AI roleplay partner's persona/role, addressed as "You". This can be as long as is genuinely helpful (1–3 sentences). Match the complexity to the learner's level.
- "voice_gender": "male" or "female" — the AI partner's gender, so a matching voice can be picked for audio.

Example:
{"learner":"You're ordering lunch at a traditional restaurant in Madrid and asking the waiter for a recommendation.","ai":"A traditional restaurant in Madrid. You are the waiter taking the learner's order and recommending the house specialty. Speak slowly and simply.","voice_gender":"male"}`;
}

const SCENARIO_THEMES = [
  "ordering at a restaurant, bar, or café",
  "shopping — market, bakery, pharmacy, phone shop, or clothes",
  "public transport, a taxi, or asking for directions",
  "housing & bureaucracy — renting, the NIE, the ayuntamiento, or the bank",
  "the doctor, dentist, hairdresser, or gym",
  "meeting neighbours or friends of friends; small talk",
  "weekend plans, hobbies, the weather, or football",
  "a local festival — San Fermín, Las Fallas, Semana Santa, a verbena",
  "a family gathering or a meal at someone's home",
  "something creative and a bit playful — a lost dog in the park, a cooking class going slightly wrong, a chatty taxi driver who used to be a bullfighter, a flamenco class, finding a wallet, a game-show contestant",
];

async function apiScenario({ model, level = DEFAULT_LEVEL }) {
  const theme = SCENARIO_THEMES[Math.floor(Math.random() * SCENARIO_THEMES.length)];
  const { text, usage } = await complete({
    model,
    system: scenarioSystemPrompt(level),
    messages: [
      {
        role: "user",
        content: `Invent one fresh scenario. Setting/theme to use: ${theme}. Make it specific and avoid the most obvious cliché.`,
      },
    ],
    schema: SCENARIO_SCHEMA,
    maxTokens: 6000,
  });
  return { ...parseStructured(text), usage };
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
  // Gemini 2.5 models always "think", and thinking tokens count against
  // maxOutputTokens — so an answer budget can be entirely consumed by reasoning,
  // leaving an empty response. Cap the thinking budget (these are simple
  // structured tasks) and add matching headroom on top of the answer budget.
  const thinkBudget = 1024;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    generationConfig: {
      maxOutputTokens: maxTokens + thinkBudget,
      thinkingConfig: { thinkingBudget: thinkBudget },
    },
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

// ElevenLabs premade voices (work on the free plan), split by gender so the
// roleplay partner's voice can match the scenario. The multilingual model
// speaks good Spanish with any of these.
const TTS_VOICES = {
  male: [
    ["onwK4e9ZLuTAKqWW03F9", "Daniel"],
    ["JBFqnCBsd6RMkjVDRZzb", "George"],
    ["cjVigY5qzO86Huf0OWal", "Eric"],
  ],
  female: [
    ["EXAVITQu4vr4xnSDxMaL", "Sarah"],
    ["XB0fDUnXU5powFXDhCwa", "Charlotte"],
    ["pFZP5JQG7iQjIQuC4Bku", "Lily"],
  ],
};

// One consistent voice per session (so the partner doesn't change voice
// mid-conversation), from the gender pool when known, else the whole set.
function ttsVoiceForSession(sessionId, gender) {
  const pool = TTS_VOICES[gender] || [...TTS_VOICES.male, ...TTS_VOICES.female];
  let h = 0;
  for (const ch of String(sessionId || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return pool[h % pool.length];
}

// The TTS backend is an explicit user choice (Audio settings): "none" (off),
// "browser" (free built-in speech synthesis), or "elevenlabs" (premium, needs a
// key). Default is "none" — but existing ElevenLabs users (a key already set,
// no explicit choice yet) keep their audio. Returns the effective backend.
function ttsBackend() {
  const stored = localStorage.getItem("ttsBackend");
  if (stored === "none" || stored === "browser" || stored === "elevenlabs") return stored;
  return getElevenLabsKey() ? "elevenlabs" : "none";
}
function ttsHasElevenLabs() {
  return Boolean(getElevenLabsKey());
}
// Audio is available when the chosen backend can actually play.
function ttsAvailable() {
  const b = ttsBackend();
  if (b === "browser") return typeof speechSynthesis !== "undefined";
  if (b === "elevenlabs") return ttsHasElevenLabs();
  return false; // none
}

async function apiTts({ text, sessionId, slow, gender }) {
  const key = getElevenLabsKey();
  if (!key) throw new Error("TTS not configured — add an ElevenLabs API key in Settings.");
  if (!text || typeof text !== "string" || text.length > 600) {
    throw new Error("text is required (max 600 chars)");
  }
  const speed = slow ? 0.8 : 1.0;
  const [voiceId] = ttsVoiceForSession(sessionId, gender);
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
