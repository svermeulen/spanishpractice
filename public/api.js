// ---- Direct API layer (client-only) ----
// This file holds everything that used to live in server.js: the model pricing
// table, cost computation, system prompts, structured-output schemas, and the
// calls to Anthropic / ElevenLabs. The app is fully static — each user supplies
// their own API keys (stored in localStorage, see Settings) and the browser
// calls the providers directly. No server, nothing persisted server-side.

// Allowed models with $/Mtok pricing and per-model thinking config
// (Haiku 4.5 doesn't support adaptive thinking).
const MODELS = {
  "claude-opus-4-8": { in: 5, out: 25, thinking: { type: "adaptive" } },
  "claude-sonnet-4-6": { in: 3, out: 15, thinking: { type: "adaptive" } },
  "claude-haiku-4-5": { in: 1, out: 5, thinking: null },
};
const DEFAULT_MODEL = "claude-haiku-4-5";

// ---- API keys (per-user, stored only in this browser) ----
function getAnthropicKey() {
  return (localStorage.getItem("anthropicApiKey") || "").trim();
}
function getElevenLabsKey() {
  return (localStorage.getItem("elevenLabsApiKey") || "").trim();
}

function resolveModel(name) {
  return MODELS[name] ? name : DEFAULT_MODEL;
}

function computeCost(model, usage) {
  const p = MODELS[model];
  const inTok = usage.input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const outTok = usage.output_tokens ?? 0;
  return (
    (inTok * p.in + cacheRead * p.in * 0.1 + cacheWrite * p.in * 1.25 + outTok * p.out) / 1e6
  );
}

function usagePayload(model, usage) {
  return {
    model,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cost: computeCost(model, usage),
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

// ---- Anthropic Messages API (direct browser call) ----
// `anthropic-dangerous-direct-browser-access` opts into CORS for browser
// requests. It's "dangerous" only when you ship YOUR key to browsers — here the
// key is the user's own, stored locally and sent only to api.anthropic.com.
class MissingKeyError extends Error {}

async function anthropicMessages({ model, max_tokens, system, messages, schema }) {
  const key = getAnthropicKey();
  if (!key) {
    throw new MissingKeyError("Add your Anthropic API key in Settings (⚙) to start practicing.");
  }
  const m = resolveModel(model);
  const body = { model: m, max_tokens, system, messages };
  if (MODELS[m].thinking) body.thinking = MODELS[m].thinking;
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
  if (!res.ok) {
    throw new Error(data?.error?.message || `Request failed (${res.status})`);
  }
  return data;
}

function extractText(data) {
  return data.content?.find((b) => b.type === "text")?.text ?? "";
}

async function apiChat({ situation, history = [], message, model }) {
  const data = await anthropicMessages({
    model,
    max_tokens: 16000,
    system: chatSystemPrompt(situation),
    messages: [...history, { role: "user", content: message }],
    schema: TURN_SCHEMA,
  });
  const turn = JSON.parse(extractText(data));
  // The model occasionally emits stray backslash artifacts in notes
  // (e.g. "\\an'" or "\\\\" where an em-dash belongs). Backslashes are never
  // legitimate in notes text, so drop those tokens.
  if (turn.notes) {
    turn.notes = turn.notes.replace(/\\+\S*/g, "").replace(/ {2,}/g, " ").trim();
  }
  return { ...turn, usage: usagePayload(resolveModel(model), data.usage) };
}

async function apiOpening({ situation, model }) {
  const data = await anthropicMessages({
    model,
    max_tokens: 4000,
    system: chatSystemPrompt(situation),
    messages: [{ role: "user", content: OPENING_INSTRUCTION }],
    schema: OPENING_SCHEMA,
  });
  const opening = JSON.parse(extractText(data));
  return { ...opening, usage: usagePayload(resolveModel(model), data.usage) };
}

async function apiTutor({ history = [], question, transcript = "", model }) {
  const data = await anthropicMessages({
    model,
    max_tokens: 16000,
    system: tutorSystemPrompt(transcript),
    messages: [...history, { role: "user", content: question }],
  });
  return { answer: extractText(data), usage: usagePayload(resolveModel(model), data.usage) };
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
