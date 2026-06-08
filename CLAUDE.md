# Spanish Practice

Client-only web app for practicing Spanish through AI roleplay conversations. Fully static — there is no server. Each user supplies their own API keys (stored in their browser's localStorage) and the page calls the AI provider / ElevenLabs directly. Supports Anthropic, OpenAI, Google Gemini, and any OpenAI-compatible endpoint (OpenRouter, Groq, local servers, ...) — picked via the model dropdown. Deployed as a static site (GitHub Pages); also runnable locally as plain static files.

## Running

```sh
npm start            # serves public/ at http://localhost:3000 (python3 -m http.server)
```

No build step and no dependencies needed to run the app — `npm start` just serves the static `public/` folder. Open the app, click ⚙ Settings, pick a model, and paste the API key for that model's provider (Anthropic / OpenAI / Gemini, or a custom endpoint); optionally add an ElevenLabs key (enables 🔊 audio). Keys live only in the browser and are sent directly to the providers.

Deploy: pushing to `main` publishes `public/` to GitHub Pages via `.github/workflows/deploy.yml` (enable Pages once: Settings → Pages → Source: GitHub Actions). Served at the custom domain **spanishpractice.app** (the Pages `cname`, also asserted by `public/CNAME`); DNS is managed in Cloudflare (CNAME-flattened apex → `svermeulen.github.io`). The fallback Pages URL is `svermeulen.github.io/spanishpractice/`.

The app has **no dependencies and no build** — it's just static files in `public/`, servable by anything (`npm start` is a thin wrapper around `python3 -m http.server`; no `npm install` is ever needed). Scenarios are generated on the fly by the AI, so there's no Node tooling and no `scripts/` directory.

## Architecture

- `public/api.js` — the direct API layer (this is what used to be `server.js`). Multi-provider via a small adapter layer: the `PROVIDERS` registry (anthropic / openai / gemini / compatible) lists each provider's models with `$/Mtok` pricing, and every provider implements one `complete({ modelId, system, messages, schema, maxTokens })` → `{ text, usage }`. The neutral message shape is `[{role, content}]` with a string `system`; each adapter translates to its provider's request. `complete()` (provider-agnostic) plus `resolveModel` / `getModelOptions` / `hasKeyForModel` sit on top. The roleplay turns use JSON-schema structured output — Anthropic `output_config.format`, OpenAI `response_format` (strict), Gemini `responseSchema` (converted by `toGeminiSchema`: uppercased types, `additionalProperties` dropped, `propertyOrdering` set). All calls are direct browser→provider (Anthropic uses the `anthropic-dangerous-direct-browser-access: true` CORS opt-in; safe because it's the user's own key). Keys live in localStorage: `anthropicApiKey`, `openaiApiKey`, `geminiApiKey`, `elevenLabsApiKey`, plus `compatibleBaseUrl` / `compatibleApiKey` / `compatibleModel` for the custom endpoint (chosen via the `__custom__` dropdown sentinel; pricing unknown so its cost isn't tracked). Each result carries a `usage` payload (tokens + computed cost) shown as a session cost ticker. There is no default model — `model` starts as `""` (a disabled "Choose a model…" placeholder in the dropdown); `complete()` and `hasKeyForModel()` short-circuit on the empty value, so nothing runs until the user picks one. Pricing note: only the Anthropic numbers are authoritative; OpenAI/Gemini are approximate estimates — update them in `PROVIDERS` if they drift. Exposed functions, all called from `app.js`:
  - `apiChat({situation, history, message, model})` — one roleplay turn. Uses structured outputs (`output_config.format`) to return JSON: `learner_translation`, `corrected_message`, `natural_message` (how a native would phrase it — empty unless meaningfully different from the correction), `notes`, `mistake_tags`, `reply_es`, `reply_en`.
  - `apiOpening({situation, model})` — the AI's in-character first message for a new conversation (just `reply_es` / `reply_en`, no correction fields). Called on start so the learner doesn't face a blank chat.
  - `apiTutor({history, question, transcript, model})` — freeform grammar Q&A side-thread; receives the conversation transcript as context.
  - `apiScenario({model})` — generates one fresh `{learner, ai}` roleplay scenario (structured output) using a random theme from `SCENARIO_THEMES` for variety.
  - `apiTts({text, sessionId, slow})` + `ttsEnabled()` — phrase-level audio via ElevenLabs (`eleven_multilingual_v2`, premade voices — the Castilian library voices from spanish-words-deck-populator return 402 on the free plan). 🔊 buttons hidden when no ElevenLabs key (`ttsEnabled()`). One consistent voice per conversation (hash of a client-generated session id). Clips are cached in-memory per session (object URLs in `app.js`) — there is no disk cache, so replays within a session are free but a reload re-fetches.
- `public/` — vanilla JS frontend, no build step. `api.js` loads before `app.js`.
  - There is no start screen: once configured, each conversation begins with an **AI-generated scenario** (`apiScenario` in `api.js`, a cheap structured-output call on the chosen model with a random theme hint for variety), then opens in character. The 🎲 button (and `⌘K`) generates a fresh scenario; the ✎ button lets the learner type their own situation; the 🤖 button previews the hidden AI-facing prompt (on hover the header label flips from "Situation: …" to "AI Prompt: …" via `showingAiPrompt` / `renderSituationLabel`). Each scenario is a `{learner, ai}` pair: `learner` is the learner-facing description shown in the header (prefixed "Situation: "), `ai` is the AI partner's persona sent to the prompt (hidden from the UI). `normalizeScenario` in `app.js` also accepts a plain string (typed situations) by using it for both fields. Session setup is split into `resetSessionState()` (clears panes/state) + scenario application; `startRandomSession()` resets, shows a "Generating a situation…" placeholder, awaits `apiScenario`, then fires the opening.
  - 🔊 buttons (teacher replies, corrected sentence, "More natural" line) play TTS on demand; ⌥click plays at 0.8× speed. The client caches object URLs per text+speed; starting a clip stops the previous one.
  - The correction diff is computed client-side (`wordDiff` in `app.js`): accent-insensitive word-level LCS. Exact matches render plain, accent-only differences render as a soft amber highlight (learner's keyboard has no accents — not treated as errors), real changes render as red strikethrough / green insertion.
- Conversation state lives only in the browser for the duration of a session; nothing is persisted (no session files, no mistake log) — there is no server. Reloading or randomizing discards the current conversation. Assistant turns are sent in history as `reply_es` only (not the full JSON).
- First run shows the **onboarding modal** (`#onboarding` in `index.html`, wired in the "Onboarding modal" section of `app.js`): it explains the app + bring-your-own-key/client-side model, collects a provider + key, picks that provider's cheapest model (`firstModelForProvider` — Haiku / gpt-4o-mini / Gemini Flash / the custom sentinel), writes everything to localStorage + reflects it into the Settings inputs (`syncSettingsInputs`), and starts the conversation. Returning users (a usable model+key already stored) skip it. Closing the modal (×) drops into Settings as an escape hatch. The opening fires via `generateOpening()`, which self-guards on session+model+key+in-flight state (`openingInFlight`), so it runs exactly once and resumes automatically when config arrives (`maybeResumeOpening`).

## Keyboard shortcuts

Defined in the `KEYMAP` object in `public/app.js`; rebindable without code changes via localStorage key `keymap` (JSON, e.g. `{"toggleTranslations": "meta+t"}`).

- `Tab` — jump between the two text inputs
- `↑`/`↓` — shell-style recall of previously sent messages in either input (draft is preserved)
- `⌘K` — restart with a new random situation (same as the 🎲 button)
- `⌘E` — toggle auto-show translations (teacher EN + "Understood as"), `⌘I` — toggle auto-show notes; both flip the persisted settings (also exposed in the ⚙ settings popover)

## Settings popover

The ⚙ button in the header opens a popover with all per-user settings (persisted in localStorage, applied immediately): the model select (grouped by provider, built from `getModelOptions()`), per-provider API keys (Anthropic / OpenAI / Gemini, plus the optional ElevenLabs key that gates the 🔊 buttons), a collapsible "Custom OpenAI-compatible endpoint" section (base URL / key / model id), auto-show translations (`autoShowEn`), auto-show notes (`autoShowNotes`), and show session cost (`showCost`, default on — hides the header cost ticker when off). Only the key/endpoint block for the selected model's provider is shown — `applyProviderVisibility()` toggles the `#set-anthropic` / `#set-openai` / `#set-gemini` / `#set-compatible` blocks on load and on every model change (the model select and ElevenLabs key always stay visible; the custom-endpoint disclosure auto-opens when its provider is active). Only the key for the selected model's provider is needed to chat; supplying it (or switching to a model whose provider is already configured) auto-resumes the opening. `Esc` or an outside click closes it.

## Roadmap (discussed, not yet built)

1. Difficulty levels (A1–B2)
2. Voice input via SpeechRecognition (TTS output is done)

(Mistake logging and session persistence were intentionally removed as bloat — any future mistake-tracking / drill-mode features would need to reintroduce some storage.)
