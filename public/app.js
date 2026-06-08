// ---- State ----
const isDemo = new URLSearchParams(location.search).has("demo");
let autoShowEn = localStorage.getItem("autoShowEn") === "true";
let autoShowNotes = localStorage.getItem("autoShowNotes") === "true";
let showCost = localStorage.getItem("showCost") !== "false"; // shown by default
let autoPlayAudio = localStorage.getItem("autoPlayAudio") !== "false"; // on by default
let model = localStorage.getItem("model") || ""; // "" = no model chosen yet
let voiceGender = null; // "male"|"female" from the scenario — matches the TTS voice
let sessionCost = 0;
let sessionTokens = { in: 0, out: 0 };
let situation = ""; // AI-facing role/persona — sent to the prompt, hidden from the UI
let situationDisplay = ""; // learner-facing description shown in the header
let sessionId = null; // per-conversation id — only used to pick a consistent TTS voice
let turns = []; // [{message, turn}] — in-memory conversation state (not persisted)
let tutorTurns = []; // [{question, answer}]
let opening = null; // {reply_es, reply_en} — the AI's in-character first message
let openingInFlight = false; // true while the opening request is running
let chatHistory = []; // [{role, content}] — assistant entries are reply_es only
let tutorHistory = [];
let transcript = []; // ["Learner: ...", "Teacher: ..."] for tutor context

// ---- Elements ----
const $ = (id) => document.getElementById(id);
const chatMessagesEl = $("chatMessages");
const tutorMessagesEl = $("tutorMessages");

// ---- Diff: accent-aware word-level LCS ----
// Returns ops: {type:'same'|'soft'|'del'|'ins', orig?, corr?, word?}
// 'soft' = words match ignoring accents/punctuation/case (gentle highlight, not an error).
function normalizeWord(w) {
  return w
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/[¿¡?!.,;:"'()«»]/g, "")
    .toLowerCase();
}

// Differences we fully forgive (rendered as plain text, not even soft-highlighted):
// missing inverted punctuation (¿ ¡), capitalization at the start of a sentence,
// and trailing . , ; : changes (e.g. the model merging two sentences with a comma).
// Trailing ? and ! still count as soft — statement vs question is meaningful.
function stripInverted(w) {
  return w.replace(/[¿¡]/g, "").replace(/[.,;:]+$/, "");
}

function isSentenceStart(words, j) {
  return j === 0 || /[.!?…]$/.test(words[j - 1]);
}

function forgivenEqual(orig, corr, sentenceStart) {
  let o = stripInverted(orig);
  let c = stripInverted(corr);
  if (sentenceStart && o && c) {
    o = o[0].toLowerCase() + o.slice(1);
    c = c[0].toLowerCase() + c.slice(1);
  }
  return o === c;
}

function normalizeSentence(s) {
  return (s || "").trim().split(/\s+/).map(normalizeWord).filter(Boolean).join(" ");
}

function wordDiff(original, corrected) {
  const a = original.trim().split(/\s+/).filter(Boolean);
  const b = corrected.trim().split(/\s+/).filter(Boolean);
  const eq = (x, y) => normalizeWord(x) === normalizeWord(y);

  // LCS table
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = eq(a[i], b[j])
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  // Backtrack
  const ops = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (eq(a[i], b[j])) {
      if (a[i] === b[j] || forgivenEqual(a[i], b[j], isSentenceStart(b, j))) {
        ops.push({ type: "same", word: b[j] });
      } else {
        ops.push({ type: "soft", orig: a[i], corr: b[j] });
      }
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", word: a[i] }); i++;
    } else {
      ops.push({ type: "ins", word: b[j] }); j++;
    }
  }
  while (i < m) { ops.push({ type: "del", word: a[i++] }); }
  while (j < n) { ops.push({ type: "ins", word: b[j++] }); }
  return ops;
}

function renderDiff(original, corrected) {
  const ops = wordDiff(original, corrected);
  const frag = document.createDocumentFragment();
  let hardChanges = false;
  ops.forEach((op, idx) => {
    if (idx > 0) frag.appendChild(document.createTextNode(" "));
    let el;
    if (op.type === "same") {
      el = document.createTextNode(op.word);
    } else if (op.type === "soft") {
      el = document.createElement("span");
      el.className = "soft-fix";
      el.title = `You wrote: ${op.orig}`;
      el.textContent = op.corr;
    } else if (op.type === "del") {
      el = document.createElement("del");
      el.textContent = op.word;
      hardChanges = true;
    } else {
      el = document.createElement("ins");
      el.textContent = op.word;
      hardChanges = true;
    }
    frag.appendChild(el);
  });
  return { frag, hardChanges };
}

// ---- Audio (TTS) ----
// Two backends: ElevenLabs (premium, needs a key) when one is set, otherwise the
// browser's built-in speech synthesis (free). Buttons hide (body.no-tts) only
// when neither is available. Voice tries to match the scenario's voiceGender.
const SPEAK_TITLE = "Play audio — ⌥click for slow";

function applyTtsVisibility() {
  document.body.classList.toggle("no-tts", !ttsAvailable());
}
applyTtsVisibility();

const audioCache = new Map(); // `${gender}|${slow}|${text}` -> object URL (ElevenLabs)
let currentAudio = null; // { btn, audio } | { btn, browser: true, utterance }

function stopAudio() {
  if (!currentAudio) return;
  if (currentAudio.browser) speechSynthesis.cancel();
  else currentAudio.audio.pause();
  currentAudio.btn.classList.remove("playing");
  currentAudio.btn.textContent = "🔊";
  currentAudio = null;
}

// Clips are voiced per-session, so the cache must not survive a session switch —
// otherwise a phrase shared between sessions would replay the previous voice.
function resetAudio() {
  stopAudio();
  for (const url of audioCache.values()) URL.revokeObjectURL(url);
  audioCache.clear();
}

// Browsers populate the voice list asynchronously: getVoices() is often empty
// until a `voiceschanged` event fires shortly after load. Kick the load early
// and expose a promise so the first clip can wait for voices instead of falling
// back to the default voice (and missing the gender match). Resolves anyway
// after a short timeout — some browsers never fire the event.
function speechVoicesReady() {
  if (typeof speechSynthesis === "undefined") return Promise.resolve();
  if (speechSynthesis.getVoices().length) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => resolve();
    speechSynthesis.addEventListener("voiceschanged", done, { once: true });
    setTimeout(done, 1000);
  });
}
if (typeof speechSynthesis !== "undefined") speechSynthesis.getVoices(); // warm up

// Best-effort browser voice: a Castilian (es-ES) voice, preferring one whose
// name matches the partner's gender, consistent per session. Browsers don't
// expose voice gender, so this is a name heuristic that degrades gracefully.
const VOICE_NAMES_FEMALE = ["mónica", "monica", "marisol", "paulina", "laura", "esperanza", "helena", "lucía", "lucia", "female", "mujer"];
const VOICE_NAMES_MALE = ["jorge", "diego", "carlos", "enrique", "pablo", "juan", "male", "hombre"];
function pickBrowserVoice(gender) {
  const all = (typeof speechSynthesis !== "undefined" && speechSynthesis.getVoices()) || [];
  const es = all.filter((v) => /^es(-|_|$)/i.test(v.lang));
  if (!es.length) return null;
  const esES = es.filter((v) => /es[-_]es/i.test(v.lang));
  let pool = esES.length ? esES : es;
  const names = gender === "female" ? VOICE_NAMES_FEMALE : gender === "male" ? VOICE_NAMES_MALE : null;
  if (names) {
    const matched = pool.filter((v) => names.some((n) => v.name.toLowerCase().includes(n)));
    if (matched.length) pool = matched;
  }
  let h = 0;
  for (const ch of String(sessionId || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return pool[h % pool.length];
}

function speakBrowser(text, slow, btn) {
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "es-ES";
  u.rate = slow ? 0.7 : 1.0;
  currentAudio = { btn, browser: true, utterance: u };
  btn.classList.add("playing");
  btn.textContent = "⏹";
  u.onend = u.onerror = () => {
    if (currentAudio?.utterance === u) stopAudio();
  };
  const speak = () => {
    if (currentAudio?.utterance !== u) return; // stopped/superseded while waiting
    const v = pickBrowserVoice(voiceGender);
    if (v) u.voice = v;
    speechSynthesis.speak(u);
  };
  // Voices are usually loaded already (resolves synchronously → speak this same
  // tick, preserving the user gesture for click-initiated playback); on a cold
  // first clip we wait for the voice list so the gender match still applies.
  if (speechSynthesis.getVoices().length) speak();
  else speechVoicesReady().then(speak);
}

// `auto` = autoplay-initiated: fail silently (don't flash ⚠ if a browser blocks
// playback before the first user gesture).
async function playTts(text, slow, btn, auto = false) {
  if (btn.classList.contains("loading")) return;
  if (currentAudio?.btn === btn) {
    stopAudio();
    return;
  }
  stopAudio();

  // Free path: browser speech synthesis (no ElevenLabs key).
  if (!ttsHasElevenLabs()) {
    if (typeof speechSynthesis !== "undefined") speakBrowser(text, slow, btn);
    return;
  }

  // Premium path: ElevenLabs — fetch the mp3 (cached as object URLs).
  const cacheKey = `${voiceGender}|${slow}|${text}`;
  btn.classList.add("loading");
  try {
    let url = audioCache.get(cacheKey);
    if (!url) {
      const blob = await apiTts({ text, sessionId, slow, gender: voiceGender });
      url = URL.createObjectURL(blob);
      audioCache.set(cacheKey, url);
    }
    const audio = new Audio(url);
    currentAudio = { btn, audio };
    btn.classList.add("playing");
    btn.textContent = "⏹";
    audio.addEventListener("ended", () => {
      if (currentAudio?.audio === audio) stopAudio();
    });
    await audio.play();
  } catch (err) {
    if (auto) {
      btn.textContent = "🔊";
    } else {
      btn.textContent = "⚠";
      btn.title = err.message;
      setTimeout(() => {
        btn.textContent = "🔊";
        btn.title = SPEAK_TITLE;
      }, 2500);
    }
  } finally {
    btn.classList.remove("loading");
  }
}

function addSpeakButton(parent, getText) {
  const btn = addEl(parent, "button", "speak-btn", "🔊");
  btn.type = "button";
  btn.title = SPEAK_TITLE;
  btn.addEventListener("click", (e) => playTts(getText(), e.altKey, btn));
  return btn;
}

// ---- Rendering helpers ----
function addEl(parent, tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  parent.appendChild(el);
  return el;
}

function scrollToBottom(el) {
  el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
}

function isNearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

// Reveal a just-expanded toggle body without clipping it off-screen.
function revealBody(body, nowHidden) {
  if (!nowHidden) body.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function addToggle(parent, label, bodyText, bodyClass, visible = false) {
  const toggle = addEl(parent, "span", "notes-toggle", label);
  const body = addEl(parent, "div", bodyClass, bodyText);
  if (!visible) body.classList.add("hidden");
  toggle.addEventListener("click", () => {
    revealBody(body, body.classList.toggle("hidden"));
  });
}

function addUserChatMessage(text) {
  const msg = addEl(chatMessagesEl, "div", "msg user");
  addEl(msg, "div", "bubble", text);
  scrollToBottom(chatMessagesEl);
  return msg;
}

function addCorrectionBlock(msg, originalText, turn) {
  const block = addEl(msg, "div", "correction");
  const { frag, hardChanges } = renderDiff(originalText, turn.corrected_message);
  const diffLine = addEl(block, "div", "diff-line");
  diffLine.appendChild(frag);
  addSpeakButton(diffLine, () => turn.corrected_message);
  if (!hardChanges && turn.mistake_tags.length === 0) {
    addEl(block, "div", "ok", "✓ Nice — no corrections");
  }
  // How a native would actually phrase it — only when meaningfully different
  // from the correction (guard against the model echoing trivial variants).
  const natural = turn.natural_message?.trim();
  if (natural && normalizeSentence(natural) !== normalizeSentence(turn.corrected_message)) {
    const div = addEl(block, "div", "natural");
    addEl(div, "span", "natural-label", "More natural: ");
    div.appendChild(document.createTextNode(natural));
    addSpeakButton(div, () => natural);
  }
  // English translation of what the learner wrote (no label, just the text),
  // following the auto-show-translations setting like teacher messages.
  const wrap = addEl(block, "div");
  const enToggle = addEl(wrap, "span", "en-toggle", "EN ▾");
  const enBody = addEl(wrap, "div", "en-body", turn.learner_translation);
  if (!autoShowEn) enBody.classList.add("hidden");
  enToggle.addEventListener("click", () => revealBody(enBody, enBody.classList.toggle("hidden")));
  if (turn.notes) {
    addToggle(block, "Notes ▾", turn.notes, "notes-body", autoShowNotes);
  }
}

function addTeacherMessage(turn) {
  const msg = addEl(chatMessagesEl, "div", "msg teacher");
  const bubble = addEl(msg, "div", "bubble", turn.reply_es);
  const speakBtn = addSpeakButton(bubble, () => turn.reply_es);
  const wrap = addEl(msg, "div");
  const toggle = addEl(wrap, "span", "en-toggle", "EN ▾");
  const body = addEl(wrap, "div", "en-body", turn.reply_en);
  if (!autoShowEn) body.classList.add("hidden");
  toggle.addEventListener("click", () => revealBody(body, body.classList.toggle("hidden")));
  scrollToBottom(chatMessagesEl);
  // Auto-play the reply (listening practice) when enabled and audio is available.
  if (autoPlayAudio && ttsAvailable() && !isDemo) {
    playTts(turn.reply_es, false, speakBtn, true);
  }
}

function addThinking(parent) {
  const el = addEl(parent, "div", "typing");
  for (let k = 0; k < 3; k++) addEl(el, "span", "dot");
  return el;
}

function addError(parent, text, onRetry) {
  const el = addEl(parent, "div", "error-msg");
  addEl(el, "span", null, text);
  if (onRetry) {
    const retry = addEl(el, "span", "retry-link", "Retry");
    retry.addEventListener("click", () => {
      el.remove();
      onRetry();
    });
  }
  scrollToBottom(parent);
}

// ---- Usage tracking ----
function applyCostVisibility() {
  $("costTicker").classList.toggle("hidden", !showCost);
}

function updateTicker() {
  const ticker = $("costTicker");
  ticker.textContent = `$${sessionCost.toFixed(sessionCost < 0.1 ? 3 : 2)}`;
  ticker.title = `Session cost so far\n${sessionTokens.in.toLocaleString()} tokens in, ${sessionTokens.out.toLocaleString()} out`;
  applyCostVisibility();
}

function trackUsage(usage) {
  if (!usage) return;
  sessionCost += usage.cost;
  sessionTokens.in += usage.input_tokens;
  sessionTokens.out += usage.output_tokens;
  updateTicker();
}

function resetUsage() {
  sessionCost = 0;
  sessionTokens = { in: 0, out: 0 };
  updateTicker();
}

// ---- Conversation flow ----
// The AI opens each new session. We seed chatHistory with the same instruction
// the opening call used (OPENING_INSTRUCTION, a global from api.js, which loads
// first) so the history sent on later turns starts with a valid user message.
function seedOpeningHistory() {
  chatHistory.push({ role: "user", content: OPENING_INSTRUCTION });
  chatHistory.push({ role: "assistant", content: opening.reply_es });
  transcript.push(`Teacher: ${opening.reply_es}`);
}

async function generateOpening() {
  // One opening per session, only once a usable model+key exists and a session
  // is set up. Guards against double-firing (boot + onboarding + key changes).
  if (!situation || opening || openingInFlight || !hasKeyForModel(model)) return;
  openingInFlight = true;
  const mySession = sessionId; // bail if a newer session supersedes us mid-flight
  const input = $("chatInput");
  const button = $("chatForm").querySelector("button");
  input.disabled = true;
  button.disabled = true;
  const thinking = addThinking(chatMessagesEl);
  scrollToBottom(chatMessagesEl);
  try {
    const turn = await apiOpening({ situation, model });
    if (mySession !== sessionId) return; // session reset while we awaited — discard
    thinking.remove();
    trackUsage(turn.usage);
    opening = { reply_es: turn.reply_es, reply_en: turn.reply_en };
    addTeacherMessage(opening);
    seedOpeningHistory();
  } catch (err) {
    if (mySession !== sessionId) return;
    thinking.remove();
    addError(chatMessagesEl, err.message, generateOpening);
  } finally {
    // Only the current session owns the shared UI/lock state; a superseded call
    // must leave the new session's input state and openingInFlight untouched.
    if (mySession === sessionId) {
      openingInFlight = false;
      input.disabled = false;
      button.disabled = false;
      input.focus();
      scrollToBottom(chatMessagesEl);
    }
  }
}

async function sendChatMessage(text, existingMsg = null) {
  const input = $("chatInput");
  const button = $("chatForm").querySelector("button");
  input.disabled = true;
  button.disabled = true;

  const mySession = sessionId; // bail if a newer session supersedes us mid-flight
  const msg = existingMsg ?? addUserChatMessage(text);
  const thinking = addThinking(chatMessagesEl);
  scrollToBottom(chatMessagesEl);

  try {
    const turn = await apiChat({
      situation,
      history: chatHistory,
      message: text,
      model,
    });
    if (mySession !== sessionId) return; // session reset while we awaited — discard
    thinking.remove();
    trackUsage(turn.usage);
    addCorrectionBlock(msg, text, turn);
    addTeacherMessage(turn);
    chatHistory.push({ role: "user", content: text });
    chatHistory.push({ role: "assistant", content: turn.reply_es });
    transcript.push(`Learner: ${text}`);
    transcript.push(`(corrected: ${turn.corrected_message})`);
    transcript.push(`Teacher: ${turn.reply_es}`);
    turns.push({ message: text, turn });
  } catch (err) {
    if (mySession !== sessionId) return;
    thinking.remove();
    addError(chatMessagesEl, err.message, () => sendChatMessage(text, msg));
  } finally {
    if (mySession === sessionId) {
      input.disabled = false;
      button.disabled = false;
      input.focus();
      scrollToBottom(chatMessagesEl);
    }
  }
}

async function sendTutorQuestion(text, existingMsg = null) {
  const input = $("tutorInput");
  const button = $("tutorForm").querySelector("button");
  input.disabled = true;
  button.disabled = true;

  const mySession = sessionId; // bail if a newer session supersedes us mid-flight
  let msg = existingMsg;
  if (!msg) {
    msg = addEl(tutorMessagesEl, "div", "msg user");
    addEl(msg, "div", "bubble", text);
  }
  const thinking = addThinking(tutorMessagesEl);
  scrollToBottom(tutorMessagesEl);

  try {
    const { answer, usage } = await apiTutor({
      history: tutorHistory,
      question: text,
      transcript: transcript.join("\n"),
      model,
    });
    if (mySession !== sessionId) return; // session reset while we awaited — discard
    thinking.remove();
    trackUsage(usage);
    const reply = addEl(tutorMessagesEl, "div", "msg teacher");
    addEl(reply, "div", "bubble", answer);
    tutorHistory.push({ role: "user", content: text });
    tutorHistory.push({ role: "assistant", content: answer });
    tutorTurns.push({ question: text, answer });
  } catch (err) {
    if (mySession !== sessionId) return;
    thinking.remove();
    addError(tutorMessagesEl, err.message, () => sendTutorQuestion(text, msg));
  } finally {
    if (mySession === sessionId) {
      input.disabled = false;
      button.disabled = false;
      input.focus();
      scrollToBottom(tutorMessagesEl);
    }
  }
}

// ---- Session setup ----
// The 🤖 button previews the hidden AI-facing prompt: while hovered, the header
// label flips from "Situation: <learner text>" to "AI Prompt: <ai persona>".
let showingAiPrompt = false;
function renderSituationLabel() {
  $("situationLabel").textContent =
    showingAiPrompt && situation
      ? `AI Prompt: ${situation}`
      : `Situation: ${situationDisplay}`;
}
function showMain() {
  renderSituationLabel();
  $("chatInput").focus();
}

// A scenario is either an {learner, ai} object (AI-generated) or a plain string
// (a custom situation typed via ✎, used for both fields).
// learner = what's shown to the user; ai = the persona fed to the prompt.
function normalizeScenario(scenario) {
  if (typeof scenario === "string") return { learner: scenario, ai: scenario };
  return { learner: scenario.learner || scenario.ai, ai: scenario.ai || scenario.learner };
}

// Static intro shown at the top of the tutor pane each session — purely visual,
// so it's never added to tutorHistory/tutorTurns (not sent to the API or saved).
const TUTOR_INTRO =
  "👋 This side panel is your tutor. Ask me anything in English — grammar, vocabulary, or about the conversation itself (e.g. \"why was my last message wrong?\" or \"when do I use ser vs estar?\").";

function addTutorIntro() {
  const msg = addEl(tutorMessagesEl, "div", "msg teacher");
  addEl(msg, "div", "bubble", TUTOR_INTRO);
}

// Clear all per-session state and the panes. Does not set a scenario or fire
// the opening — callers do that (synchronously for a typed/known scenario, or
// after an async generation for a random one).
function resetSessionState() {
  sessionId = crypto.randomUUID();
  voiceGender = null;
  turns = [];
  tutorTurns = [];
  opening = null;
  openingInFlight = false;
  chatHistory = [];
  tutorHistory = [];
  transcript = [];
  resetUsage();
  resetAudio();
  chatMessagesEl.innerHTML = "";
  tutorMessagesEl.innerHTML = "";
  addTutorIntro();
}

// Start a session from a known scenario (typed situation or demo).
function startSession(scenario) {
  resetSessionState();
  const sc = normalizeScenario(scenario);
  situation = sc.ai;
  situationDisplay = sc.learner;
  showMain();
  // Have the AI open the conversation in character (skipped in demo mode, and
  // a no-op until a model+key is configured — generateOpening guards on that).
  if (!isDemo) generateOpening();
}

// ---- Dynamic scenarios ----
// Each new conversation generates a fresh scenario via the AI (cheap call on the
// configured model), then opens in character. Replaces the old pre-generated
// public/scenarios.json deck.
let scenarioInFlight = false;
async function startRandomSession() {
  if (scenarioInFlight) return;
  if (!hasKeyForModel(model)) {
    showOnboarding();
    return;
  }
  resetSessionState();
  situation = "";
  situationDisplay = "Generating a situation…";
  showMain();

  const input = $("chatInput");
  const button = $("chatForm").querySelector("button");
  input.disabled = true;
  button.disabled = true;
  const thinking = addThinking(chatMessagesEl);
  scrollToBottom(chatMessagesEl);
  scenarioInFlight = true;
  const mySession = sessionId; // bail if a newer session supersedes us mid-flight
  try {
    const sc = await apiScenario({ model });
    if (mySession !== sessionId) return; // session reset while we awaited — discard
    trackUsage(sc.usage);
    thinking.remove();
    situation = sc.ai;
    situationDisplay = sc.learner;
    voiceGender = sc.voice_gender || null;
    renderSituationLabel();
    generateOpening(); // manages input enabled-state from here
  } catch (err) {
    if (mySession !== sessionId) return;
    thinking.remove();
    situationDisplay = "Couldn't generate a situation";
    renderSituationLabel();
    input.disabled = false;
    button.disabled = false;
    addError(chatMessagesEl, err.message, startRandomSession);
  } finally {
    // scenarioInFlight is a re-entry lock for this function (only one runs at a
    // time), so always release it — even when superseded.
    scenarioInFlight = false;
  }
}

$("randomizeBtn").addEventListener("click", startRandomSession);

// 🤖 preview: while hovered/focused, show the hidden AI-facing prompt.
const aiPromptBtn = $("aiPromptBtn");
function setAiPromptPreview(on) {
  showingAiPrompt = on;
  renderSituationLabel();
}
aiPromptBtn.addEventListener("mouseenter", () => setAiPromptPreview(true));
aiPromptBtn.addEventListener("mouseleave", () => setAiPromptPreview(false));
aiPromptBtn.addEventListener("focus", () => setAiPromptPreview(true));
aiPromptBtn.addEventListener("blur", () => setAiPromptPreview(false));

// Edit (✎) → type an explicit situation inline. The typed text is used as both
// the header description and the AI prompt (via normalizeScenario's string path).
function showSituationEditor() {
  const input = $("situationInput");
  input.value = situationDisplay;
  $("situationLabel").classList.add("hidden");
  input.classList.remove("hidden");
  input.focus();
  input.select();
}

function hideSituationEditor() {
  $("situationInput").classList.add("hidden");
  $("situationLabel").classList.remove("hidden");
}

$("editBtn").addEventListener("click", showSituationEditor);
$("situationInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const val = $("situationInput").value.trim();
    hideSituationEditor();
    if (val) startSession(val);
  } else if (e.key === "Escape") {
    hideSituationEditor();
  }
});
$("situationInput").addEventListener("blur", hideSituationEditor);

// ---- Keyboard shortcuts ----
// Defaults below. Rebind without code changes by setting localStorage key
// "keymap" to a JSON object, e.g. {"toggleTranslations": "meta+t"}.
// Combo format: modifiers in the order meta+ctrl+alt+shift, then the key.
const KEYMAP = {
  swapFocus: "tab", // jump between the two text inputs
  randomize: "meta+k", // restart with a new random situation
  toggleTranslations: "meta+e",
  toggleNotes: "meta+i", // expand/collapse all correction notes
};
try {
  Object.assign(KEYMAP, JSON.parse(localStorage.getItem("keymap")) || {});
} catch {}

const SHORTCUT_ACTIONS = {
  swapFocus() {
    const chatInput = $("chatInput");
    if (document.activeElement === chatInput) $("tutorInput").focus();
    else chatInput.focus();
  },
  randomize() {
    startRandomSession();
  },
  toggleTranslations() {
    const box = $("autoShowEn");
    box.checked = !box.checked;
    box.dispatchEvent(new Event("change"));
  },
  toggleNotes() {
    const box = $("autoShowNotes");
    box.checked = !box.checked;
    box.dispatchEvent(new Event("change"));
  },
};

function keyCombo(e) {
  let combo = "";
  if (e.metaKey) combo += "meta+";
  if (e.ctrlKey) combo += "ctrl+";
  if (e.altKey) combo += "alt+";
  if (e.shiftKey) combo += "shift+";
  return combo + e.key.toLowerCase();
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("settingsPopup").classList.contains("hidden")) {
    toggleSettings(false);
    return;
  }
  const combo = keyCombo(e);
  for (const [action, binding] of Object.entries(KEYMAP)) {
    if (combo === binding) {
      e.preventDefault();
      SHORTCUT_ACTIONS[action]();
      return;
    }
  }
});

// API keys — persisted in localStorage, sent directly to the providers.
// Changing the Anthropic key while a doomed request is showing lets a Retry
// succeed; changing the ElevenLabs key toggles the 🔊 buttons immediately.
function bindKeyInput(id, storageKey, onChange) {
  const el = $(id);
  el.value = localStorage.getItem(storageKey) || "";
  el.addEventListener("input", () => {
    const v = el.value.trim();
    if (v) localStorage.setItem(storageKey, v);
    else localStorage.removeItem(storageKey);
    if (onChange) onChange();
  });
}
// Supplying a key/endpoint (or switching to an already-configured provider)
// gets a conversation going: generate a scenario if none exists yet, otherwise
// (re)try a pending opening. Both downstream calls self-guard, so this is safe
// to call freely from input/model change handlers.
function maybeResumeOpening() {
  if (!hasKeyForModel(model)) return;
  if (!situation) startRandomSession();
  else generateOpening();
}

// Settings input id ↔ localStorage key. Used for binding and for reflecting
// onboarding's writes back into the popover.
const KEY_INPUTS = [
  ["anthropicKey", "anthropicApiKey"],
  ["openaiKey", "openaiApiKey"],
  ["geminiKey", "geminiApiKey"],
  ["compatBaseUrl", "compatibleBaseUrl"],
  ["compatKey", "compatibleApiKey"],
  ["compatModel", "compatibleModel"],
  ["elevenLabsKey", "elevenLabsApiKey"],
];
for (const [id, k] of KEY_INPUTS) {
  bindKeyInput(id, k, k === "elevenLabsApiKey" ? applyTtsVisibility : maybeResumeOpening);
}
function syncSettingsInputs() {
  for (const [id, k] of KEY_INPUTS) $(id).value = localStorage.getItem(k) || "";
}

// Build the model dropdown grouped by provider (options come from api.js).
// There is no default model: a disabled "Choose a model…" placeholder is the
// initial selection, and the user must pick one (+ supply that provider's key)
// to start.
const modelSelectEl = $("modelSelect");
const placeholderOpt = document.createElement("option");
placeholderOpt.value = "";
placeholderOpt.textContent = "Choose a model…";
placeholderOpt.disabled = true;
modelSelectEl.appendChild(placeholderOpt);
for (const group of getModelOptions()) {
  const og = document.createElement("optgroup");
  og.label = group.label;
  for (const opt of group.options) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    og.appendChild(o);
  }
  modelSelectEl.appendChild(og);
}
modelSelectEl.value = model;
if (modelSelectEl.selectedIndex === -1) {
  // No stored model, or a stored value no longer in the catalog → no default.
  model = "";
  localStorage.removeItem("model");
}
if (!model) modelSelectEl.selectedIndex = 0; // show the placeholder

// Show only the key/endpoint settings for the selected model's provider; the
// model select and ElevenLabs key always stay visible. Re-run on model change.
const PROVIDER_SETTING_IDS = {
  anthropic: "set-anthropic",
  openai: "set-openai",
  gemini: "set-gemini",
  compatible: "set-compatible",
};
function applyProviderVisibility() {
  // No model chosen yet → show no provider block (just the model picker).
  const active = model ? resolveModel(model).providerId : null;
  for (const [pid, id] of Object.entries(PROVIDER_SETTING_IDS)) {
    const show = pid === active;
    $(id).classList.toggle("hidden", !show);
    // Expand the custom-endpoint disclosure when it's the active provider.
    if (id === "set-compatible") $(id).open = show;
  }
}
applyProviderVisibility();

modelSelectEl.addEventListener("change", () => {
  model = modelSelectEl.value;
  localStorage.setItem("model", model);
  applyProviderVisibility();
  maybeResumeOpening();
});

const autoShowEnEl = $("autoShowEn");
autoShowEnEl.checked = autoShowEn;
autoShowEnEl.addEventListener("change", () => {
  autoShowEn = autoShowEnEl.checked;
  localStorage.setItem("autoShowEn", String(autoShowEn));
  // Apply to translations already on screen too (teacher EN + "Understood as"),
  // keeping panes pinned to the bottom if they were there.
  const pinned = [chatMessagesEl, tutorMessagesEl].filter(isNearBottom);
  document.querySelectorAll(".en-body").forEach((el) => {
    el.classList.toggle("hidden", !autoShowEn);
  });
  pinned.forEach(scrollToBottom);
});

const autoShowNotesEl = $("autoShowNotes");
autoShowNotesEl.checked = autoShowNotes;
autoShowNotesEl.addEventListener("change", () => {
  autoShowNotes = autoShowNotesEl.checked;
  localStorage.setItem("autoShowNotes", String(autoShowNotes));
  // Apply to notes already on screen too, keeping the pane pinned to the
  // bottom if it was there.
  const pinned = [chatMessagesEl].filter(isNearBottom);
  document.querySelectorAll(".notes-body").forEach((el) => {
    el.classList.toggle("hidden", !autoShowNotes);
  });
  pinned.forEach(scrollToBottom);
});

const showCostEl = $("showCost");
showCostEl.checked = showCost;
applyCostVisibility();
showCostEl.addEventListener("change", () => {
  showCost = showCostEl.checked;
  localStorage.setItem("showCost", String(showCost));
  applyCostVisibility();
});

const autoPlayAudioEl = $("autoPlayAudio");
autoPlayAudioEl.checked = autoPlayAudio;
autoPlayAudioEl.addEventListener("change", () => {
  autoPlayAudio = autoPlayAudioEl.checked;
  localStorage.setItem("autoPlayAudio", String(autoPlayAudio));
});

// ---- Settings popover ----
const settingsBtn = $("settingsBtn");
const settingsPopup = $("settingsPopup");
function toggleSettings(show) {
  const willShow = show ?? settingsPopup.classList.contains("hidden");
  settingsPopup.classList.toggle("hidden", !willShow);
  settingsBtn.setAttribute("aria-expanded", String(willShow));
}
settingsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleSettings();
});
// Clicks inside the popup shouldn't close it; clicks anywhere else should.
settingsPopup.addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", () => toggleSettings(false));

// ---- Input history (shell-style Up/Down recall) ----
// Up fills the input with previous sent messages (useful for re-typing the
// corrected version of your last attempt); Down walks back toward your draft.
function attachInputHistory(input, getHistory) {
  let cursor = -1; // -1 = live draft (not navigating)
  let draft = "";
  input.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    const history = getHistory();
    if (!history.length) return;
    e.preventDefault();
    if (e.key === "ArrowUp") {
      if (cursor === -1) draft = input.value;
      cursor = Math.min(cursor + 1, history.length - 1);
    } else if (cursor >= 0) {
      cursor--;
    } else {
      return;
    }
    input.value = cursor === -1 ? draft : history[history.length - 1 - cursor];
    const end = input.value.length;
    input.setSelectionRange(end, end);
  });
  // Typing makes the current content a new draft, not a history entry.
  input.addEventListener("input", () => {
    cursor = -1;
  });
  return function reset() {
    cursor = -1;
    draft = "";
  };
}

const resetChatInputHistory = attachInputHistory($("chatInput"), () =>
  turns.map((t) => t.message)
);
const resetTutorInputHistory = attachInputHistory($("tutorInput"), () =>
  tutorTurns.map((t) => t.question)
);

$("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("chatInput").value.trim();
  if (!text) return;
  $("chatInput").value = "";
  resetChatInputHistory();
  sendChatMessage(text);
});

$("tutorForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("tutorInput").value.trim();
  if (!text) return;
  $("tutorInput").value = "";
  resetTutorInputHistory();
  sendTutorQuestion(text);
});

// ---- Onboarding modal ----
// First run shows a welcome modal explaining the app + the bring-your-own-key
// model, collects a provider + key, picks that provider's cheapest model, and
// starts the conversation. Returning users (model+key already configured) skip
// it entirely.
const ONB_PROVIDERS = [
  { id: "anthropic", label: "Anthropic — Claude", short: "Anthropic", placeholder: "sk-ant-...", keyUrl: "https://console.anthropic.com/settings/keys" },
  { id: "openai", label: "OpenAI — GPT", short: "OpenAI", placeholder: "sk-...", keyUrl: "https://platform.openai.com/api-keys" },
  { id: "gemini", label: "Google — Gemini", short: "Gemini", placeholder: "AIza...", keyUrl: "https://aistudio.google.com/apikey" },
  { id: "compatible", label: "Custom (OpenAI-compatible)", short: "", placeholder: "", keyUrl: "" },
];

const onbOverlay = $("onboarding");
const onbProviderEl = $("onbProvider");
const onbFieldsEl = $("onbFields");
const onbStartEl = $("onbStart");

for (const p of ONB_PROVIDERS) {
  const o = document.createElement("option");
  o.value = p.id;
  o.textContent = p.label;
  onbProviderEl.appendChild(o);
}

function setStored(k, v) {
  const t = (v || "").trim();
  if (t) localStorage.setItem(k, t);
  else localStorage.removeItem(k);
}

function validateOnb() {
  const pid = onbProviderEl.value;
  const ok =
    pid === "compatible"
      ? $("onbBaseUrl").value.trim() && $("onbModel").value.trim()
      : $("onbKey").value.trim();
  onbStartEl.disabled = !ok;
}

// Render the provider-specific field(s) into the modal, prefilling anything the
// user already has stored.
function renderOnbFields(pid) {
  onbFieldsEl.innerHTML = "";
  const addField = (labelHtml, id, type, placeholder, value) => {
    const f = document.createElement("label");
    f.className = "onb-field";
    const s = document.createElement("span");
    s.innerHTML = labelHtml;
    const i = document.createElement("input");
    i.id = id;
    i.className = "onb-input";
    i.type = type;
    i.placeholder = placeholder;
    i.autocomplete = "off";
    i.spellcheck = false;
    i.value = value || "";
    f.append(s, i);
    onbFieldsEl.appendChild(f);
    return i;
  };
  const addHint = (html) => {
    const p = document.createElement("p");
    p.className = "onb-hint";
    p.innerHTML = html;
    onbFieldsEl.appendChild(p);
  };

  if (pid === "compatible") {
    addField("Base URL", "onbBaseUrl", "text", "https://openrouter.ai/api/v1", localStorage.getItem("compatibleBaseUrl"));
    addField("Model id", "onbModel", "text", "e.g. openai/gpt-4o-mini", localStorage.getItem("compatibleModel"));
    addField('API key <span class="onb-opt">(if required)</span>', "onbKey", "password", "endpoint key...", localStorage.getItem("compatibleApiKey"));
    addHint("Works with OpenRouter, Groq, Together, etc. Local servers (Ollama / LM Studio) need this page opened over <code>http://</code>.");
  } else {
    const prov = ONB_PROVIDERS.find((p) => p.id === pid);
    addField("API key", "onbKey", "password", prov.placeholder, localStorage.getItem(providerKeyName(pid)));
    addHint(`<a href="${prov.keyUrl}" target="_blank" rel="noopener">Get a ${prov.short} key ↗</a>`);
  }

  for (const i of onbFieldsEl.querySelectorAll("input")) {
    i.addEventListener("input", validateOnb);
    i.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !onbStartEl.disabled) startFromOnboarding();
    });
  }
  validateOnb();
  onbFieldsEl.querySelector("input")?.focus();
}

onbProviderEl.addEventListener("change", () => renderOnbFields(onbProviderEl.value));

function showOnboarding() {
  const pid = model && resolveModel(model).providerId;
  onbProviderEl.value = ONB_PROVIDERS.some((p) => p.id === pid) ? pid : "anthropic";
  renderOnbFields(onbProviderEl.value);
  onbOverlay.classList.remove("hidden");
}

function hideOnboarding() {
  onbOverlay.classList.add("hidden");
}

function startFromOnboarding() {
  const pid = onbProviderEl.value;
  if (pid === "compatible") {
    setStored("compatibleBaseUrl", $("onbBaseUrl").value);
    setStored("compatibleModel", $("onbModel").value);
    setStored("compatibleApiKey", $("onbKey").value);
  } else {
    setStored(providerKeyName(pid), $("onbKey").value);
  }
  model = firstModelForProvider(pid);
  localStorage.setItem("model", model);
  modelSelectEl.value = model;
  syncSettingsInputs();
  applyProviderVisibility();
  applyTtsVisibility();
  hideOnboarding();
  startRandomSession();
}

onbStartEl.addEventListener("click", startFromOnboarding);
// Escape hatch: closing the modal drops the user into Settings instead.
$("onbClose").addEventListener("click", () => {
  hideOnboarding();
  toggleSettings(true);
});

// ---- Boot ----
// No start screen: configured users jump straight into a generated scenario;
// first-run (no usable model+key) gets the onboarding modal, which kicks off
// the first scenario once a provider + key are supplied.
if (!isDemo) {
  if (hasKeyForModel(model)) startRandomSession();
  else showOnboarding();
}

// Dev helper: ?demo renders a sample conversation without calling the API,
// for styling work. Not linked from anywhere.
if (isDemo) {
  startSession({
    learner: "You're ordering lunch at a traditional restaurant in Madrid.",
    ai: "A traditional restaurant in Madrid. You are the waiter taking the learner's order.",
  });
  const demoTurn = {
    learner_translation: "Hi, I want an orange juice please.",
    corrected_message: "Hola, quiero un zumo de naranja, por favor.",
    natural_message: "Hola, ¿me pones un zumo de naranja, por favor?",
    notes:
      "In Spain, orange juice is 'zumo de naranja' — 'jugo' is the Latin American word. Also, 'yo' is redundant here since 'quiero' already shows who you mean.",
    mistake_tags: ["regional-vocab-spain", "redundant-subject-pronoun"],
    reply_es: "¡Muy bien! Un zumo de naranja. ¿Quiere algo de comer?",
    reply_en: "Very good! An orange juice. Would you like something to eat?",
  };
  const demoMsg = addUserChatMessage("hola, yo quiero un jugo de naranja por favor");
  addCorrectionBlock(demoMsg, "hola, yo quiero un jugo de naranja por favor", demoTurn);
  addTeacherMessage(demoTurn);
  addUserChatMessage("perfecto, nada mas gracias");
  addThinking(chatMessagesEl);
  const tq = addEl(tutorMessagesEl, "div", "msg user");
  addEl(tq, "div", "bubble", "Why is it zumo and not jugo?");
  const ta = addEl(tutorMessagesEl, "div", "msg teacher");
  addEl(
    ta,
    "div",
    "bubble",
    "'Zumo' is the everyday word for juice in Spain, while 'jugo' is standard across Latin America. In Spain, 'jugo' mostly refers to the juices released when cooking meat."
  );
}
