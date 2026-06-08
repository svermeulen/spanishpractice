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
- **Audio (optional)** — 🔊 buttons speak any line via ElevenLabs (⌥-click for
  slow), if you add an ElevenLabs key.
- **100 scenarios** — a shuffled deck; 🎲 (or ⌘K) jumps to a new one.
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

No build step and no dependencies are needed to *run* the app — it's static
files in `public/`.

```sh
npm start          # serves public/ at http://localhost:3000 (python3 http.server)
```

…or open `public/index.html` with any static file server.

> Local AI servers (Ollama / LM Studio) work only when the page itself is served
> over `http://` — a hosted `https` page can't call `http://localhost` (browser
> mixed-content block).

## Regenerate the scenario deck

The only thing that needs Node:

```sh
npm install
ANTHROPIC_API_KEY=sk-ant-... npm run generate-scenarios   # rewrites public/scenarios.json
```

## How it works

- `public/api.js` — provider-adapter layer: a `PROVIDERS` registry where each
  provider implements one `complete()` call. Roleplay turns use JSON-schema
  structured output (Anthropic `output_config`, OpenAI `response_format`, Gemini
  `responseSchema`). All calls go browser → provider directly with your key.
- `public/app.js` — vanilla-JS UI: chat/tutor panes, the correction diff,
  scenario deck, settings, and onboarding. No framework, no bundler.
- Deployed to GitHub Pages from `public/` via GitHub Actions on every push to
  `main` (see `.github/workflows/deploy.yml`).

See `CLAUDE.md` for a fuller architecture tour.

## License

MIT — see [LICENSE](LICENSE).
