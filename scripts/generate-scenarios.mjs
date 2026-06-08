// One-off generator for public/scenarios.json — the "Surprise me" deck.
// Run from the project root: node scripts/generate-scenarios.mjs
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";

const client = new Anthropic();

const SCHEMA = {
  type: "object",
  properties: {
    scenarios: {
      type: "array",
      items: {
        type: "object",
        properties: {
          learner: {
            type: "string",
            description:
              "What the learner sees: the situation and the learner's own role, addressed as \"You\". 1-2 sentences in English. Do not describe the AI partner here.",
          },
          ai: {
            type: "string",
            description:
              "Hidden from the learner, used to instruct the model: the setting plus the AI roleplay partner's persona/role, addressed as \"You\". 1-2 sentences in English.",
          },
        },
        required: ["learner", "ai"],
        additionalProperties: false,
      },
    },
  },
  required: ["scenarios"],
  additionalProperties: false,
};

const PROMPT = `Generate exactly 100 roleplay scenarios for an English speaker practicing beginner Spanish. They are moving to Spain, so set the scenarios in Spain (vary the cities and regions) and assume Castilian Spanish.

Each scenario has two fields, both 1-2 sentences in English:
- "learner": shown to the learner. Describes the situation and the LEARNER's own role, addressed as "You". Does not describe the AI partner.
- "ai": hidden from the learner and used to instruct the model. Describes the setting plus the AI roleplay partner's persona/role, addressed as "You".

Example:
{
  "learner": "You're ordering lunch at a traditional restaurant in Madrid and asking the waiter for a recommendation.",
  "ai": "A traditional restaurant in Madrid. You are the waiter taking the learner's order and recommending the house specialty."
}

Mix:
- ~30 common practical situations: restaurants, bars, shops, pharmacy, public transport, taxis, housing/renting, bureaucracy (getting a NIE, registering at the ayuntamiento), doctor, bank, phone shop, hairdresser, gym...
- ~40 social and everyday life: neighbors, small talk, meeting friends of friends, hobbies, the weather, weekend plans, local festivals (San Fermin, Las Fallas, Semana Santa...), football chat, family gatherings...
- ~30 creative and unexpected but still beginner-friendly: a lost dog in the park, being a contestant on a Spanish game show, a flamenco class, a cooking class going slightly wrong, a medieval market, finding someone's wallet, a chatty taxi driver who is an ex-bullfighter, stargazing with an amateur astronomer...

Vary the AI personas widely (waiter, abuela, shopkeeper, kid, tour guide, taxi driver, street musician, market vendor, police officer, neighbor...). Keep every scenario simple enough for a beginner to navigate.`;

const res = await client.messages.create({
  model: "claude-opus-4-8",
  max_tokens: 16000,
  thinking: { type: "adaptive" },
  messages: [{ role: "user", content: PROMPT }],
  output_config: { format: { type: "json_schema", schema: SCHEMA } },
});

const text = res.content.find((b) => b.type === "text").text;
const { scenarios } = JSON.parse(text);
if (scenarios.length < 80) {
  throw new Error(`Expected ~100 scenarios, got ${scenarios.length}`);
}

const out = new URL("../public/scenarios.json", import.meta.url);
fs.writeFileSync(out, JSON.stringify(scenarios, null, 1));
console.log(`Wrote ${scenarios.length} scenarios to public/scenarios.json`);
