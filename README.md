# Spanish Practice

Practice Spanish through AI roleplay conversations — chat in Spanish, get gentle
inline corrections, and ask a built-in tutor anything.

**▶ Live: [spanishpractice.app](https://spanishpractice.app)**

It's free and runs **entirely in your browser** — there's no server. You bring
your own AI API key; it's stored only on your device and sent straight to the
provider you choose. Nothing is logged or proxied.

## Features

- **Roleplay chat** — the AI plays a scenario partner (waiter, shopkeeper, new
  neighbour, ...) and keeps the conversation going in simple Castilian Spanish.
- **Inline corrections** — your message is diffed word-by-word against a native
  rewrite: real fixes show as strikethrough/insertion, accent-only differences
  are softly highlighted (a missing accent isn't treated as an error), and a
  "more natural" phrasing is offered when it differs meaningfully.
- **Tutor side-panel** — ask grammar/vocabulary questions in English at any
  time; it has the conversation transcript as context.
- **Audio** — optional text-to-speech for any line (🔊 buttons, ⌥-click for
  slower; replies can auto-play). Choose a voice backend in Settings → Audio:
  free browser voices, or higher-quality **OpenAI / Google Gemini / ElevenLabs**
  — the first two reuse the same key as chat, so no extra signup. Voices are
  gender-matched to the scenario.
- **Voice input** — where the browser supports it, flip the composer into voice
  mode and tap to talk: speak your reply in Spanish, tap again to stop, and it
  transcribes and sends automatically (`⌘⇧M` toggles recording).
- **Gentle on accents** — missing accents (á, ñ) and inverted punctuation
  (¿ ¡) are forgiven by default (your keyboard may not have them); flip on
  "Correct accents & punctuation" in Settings to have them checked too.
- **Fresh scenarios** — every conversation starts from an AI-generated
  situation; 🎲 (or ⌘K) rolls a new one, ✎ lets you type your own, and 🤖
  previews the hidden AI-facing prompt.
- **Difficulty levels** — pick your CEFR level (A1–B2) in onboarding or
  Settings; it scales how the partner speaks, how complex the scenarios are,
  and how thorough the corrections get.
- **Session cost ticker** — live token cost estimate per provider.

## Providers

Pick any of these in Settings (you only need a key for the one you use):

| Provider | Models | Get a key |
|---|---|---|
| Anthropic | Claude Haiku / Sonnet / Opus | <https://console.anthropic.com/settings/keys> |
| OpenAI | GPT-4o / 4.1 / 5 families | <https://platform.openai.com/api-keys> |
| Google Gemini | Gemini 2.5 Flash / Pro | <https://aistudio.google.com/apikey> |
| OpenAI-compatible | any (OpenRouter, Groq, Together, local …) | per-endpoint |

On first load a welcome modal walks you through picking a provider and pasting a
key, then starts you on that provider's cheapest model. **Tip:** create a key
with a spending limit.

## Run it locally

No build step, no dependencies, and **no Node/npm required** — it's just static
files in `public/`. You only need to *serve* them over `http://` (rather than
opening the file directly): a `file://` page sends `Origin: null`, which the
provider APIs' CORS can reject, and browsers treat its `localStorage`
inconsistently. Any static web server works — for example:

```sh
python3 -m http.server 3000 --directory public   # then open http://localhost:3000
```

There's also an `npm start` shortcut that runs exactly that command (purely for
convenience — there are no packages to install).

> Local AI servers (Ollama / LM Studio) work only when the page itself is served
> over `http://` — a hosted `https` page can't call `http://localhost` (browser
> mixed-content block).

## How it works

- `public/api.js` — provider-adapter layer: a `PROVIDERS` registry where each
  provider implements one `complete()` call. Roleplay turns use JSON-schema
  structured output (Anthropic `output_config`, OpenAI `response_format`, Gemini
  `responseSchema`). All calls go browser → provider directly with your key.
- `public/app.js` — vanilla-JS UI: chat/tutor panes, the correction diff,
  scenario generation, settings, and onboarding. No framework, no bundler.
- Deployed to GitHub Pages from `public/` via GitHub Actions on every push to
  `main` (see `.github/workflows/deploy.yml`).
- Installable as a PWA (`manifest.json`) — add it to your phone's home screen
  and it launches like an app. (No service worker / offline mode: conversations
  need the network to reach the AI.)

See `CLAUDE.md` for a fuller architecture tour.

## License

MIT — see [LICENSE](LICENSE).
