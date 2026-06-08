// ---- State ----
const isDemo = new URLSearchParams(location.search).has("demo");
let autoShowEn = localStorage.getItem("autoShowEn") === "true";
let autoShowNotes = localStorage.getItem("autoShowNotes") === "true";
let showCost = localStorage.getItem("showCost") !== "false"; // shown by default
let model = localStorage.getItem("model") || "claude-opus-4-8";
let sessionCost = 0;
let sessionTokens = { in: 0, out: 0 };
let situation = ""; // AI-facing role/persona — sent to the prompt, hidden from the UI
let situationDisplay = ""; // learner-facing description shown in the header
let sessionId = null; // per-conversation id — only used to pick a consistent TTS voice
let turns = []; // [{message, turn}] — in-memory conversation state (not persisted)
let tutorTurns = []; // [{question, answer}]
let opening = null; // {reply_es, reply_en} — the AI's in-character first message
let openingFailed = false; // true when the opening couldn't run (e.g. no API key yet)
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
// On-demand phrase audio via ElevenLabs (called directly from the browser).
// Buttons are hidden (body.no-tts) until the user supplies an ElevenLabs key.
function applyTtsVisibility() {
  document.body.classList.toggle("no-tts", !ttsEnabled());
}
applyTtsVisibility();

const audioCache = new Map(); // `${slow}|${text}` -> object URL
let currentAudio = null; // {audio, btn}

function stopAudio() {
  if (!currentAudio) return;
  currentAudio.audio.pause();
  currentAudio.btn.classList.remove("playing");
  currentAudio.btn.textContent = "🔊";
  currentAudio = null;
}

// Clips are voiced per-session (voice = hash of sessionId), so the cache must
// not survive a session switch — otherwise a phrase shared between sessions
// would replay the previous session's voice. Also revokes URLs to avoid a leak.
function resetAudio() {
  stopAudio();
  for (const url of audioCache.values()) URL.revokeObjectURL(url);
  audioCache.clear();
}

async function playTts(text, slow, btn) {
  // Ignore re-clicks while this button's clip is still being fetched, so a
  // double-click can't start two overlapping plays.
  if (btn.classList.contains("loading")) return;
  // Clicking the button that's currently playing stops it.
  if (currentAudio?.btn === btn) {
    stopAudio();
    return;
  }
  stopAudio();
  const key = `${slow}|${text}`;
  btn.classList.add("loading");
  try {
    let url = audioCache.get(key);
    if (!url) {
      const blob = await apiTts({ text, sessionId, slow });
      url = URL.createObjectURL(blob);
      audioCache.set(key, url);
    }
    const audio = new Audio(url);
    currentAudio = { audio, btn };
    btn.classList.add("playing");
    btn.textContent = "⏹";
    audio.addEventListener("ended", () => {
      if (currentAudio?.audio === audio) stopAudio();
    });
    await audio.play();
  } catch (err) {
    btn.textContent = "⚠";
    btn.title = err.message;
    setTimeout(() => {
      btn.textContent = "🔊";
      btn.title = SPEAK_TITLE;
    }, 2500);
  } finally {
    btn.classList.remove("loading");
  }
}

const SPEAK_TITLE = "Play audio — ⌥click for slow";

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
  addSpeakButton(bubble, () => turn.reply_es);
  const wrap = addEl(msg, "div");
  const toggle = addEl(wrap, "span", "en-toggle", "EN ▾");
  const body = addEl(wrap, "div", "en-body", turn.reply_en);
  if (!autoShowEn) body.classList.add("hidden");
  toggle.addEventListener("click", () => revealBody(body, body.classList.toggle("hidden")));
  scrollToBottom(chatMessagesEl);
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
// The AI opens each new session. We seed chatHistory with this instruction
// (kept in sync with OPENING_INSTRUCTION in api.js) so the history sent on
// later turns starts with a valid user message.
const OPENING_HISTORY_SEED =
  "Start the roleplay yourself: greet the learner in character and say one short, simple opening line (1-2 sentences, beginner-friendly) that fits the situation, ending with a question to get the conversation going. Produce only your in-character Spanish line and its English translation.";

function seedOpeningHistory() {
  chatHistory.push({ role: "user", content: OPENING_HISTORY_SEED });
  chatHistory.push({ role: "assistant", content: opening.reply_es });
  transcript.push(`Teacher: ${opening.reply_es}`);
}

async function generateOpening() {
  const input = $("chatInput");
  const button = $("chatForm").querySelector("button");
  input.disabled = true;
  button.disabled = true;
  const thinking = addThinking(chatMessagesEl);
  scrollToBottom(chatMessagesEl);
  try {
    const turn = await apiOpening({ situation, model });
    thinking.remove();
    openingFailed = false;
    trackUsage(turn.usage);
    opening = { reply_es: turn.reply_es, reply_en: turn.reply_en };
    addTeacherMessage(opening);
    seedOpeningHistory();
  } catch (err) {
    thinking.remove();
    // No key yet → the opening never ran; remember so pasting a key in
    // Settings can resume it automatically (see bindKeyInput below).
    openingFailed = true;
    addError(chatMessagesEl, err.message, generateOpening);
  } finally {
    input.disabled = false;
    button.disabled = false;
    input.focus();
    scrollToBottom(chatMessagesEl);
  }
}

async function sendChatMessage(text, existingMsg = null) {
  const input = $("chatInput");
  const button = $("chatForm").querySelector("button");
  input.disabled = true;
  button.disabled = true;

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
    thinking.remove();
    addError(chatMessagesEl, err.message, () => sendChatMessage(text, msg));
  } finally {
    input.disabled = false;
    button.disabled = false;
    input.focus();
    scrollToBottom(chatMessagesEl);
  }
}

async function sendTutorQuestion(text, existingMsg = null) {
  const input = $("tutorInput");
  const button = $("tutorForm").querySelector("button");
  input.disabled = true;
  button.disabled = true;

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
    thinking.remove();
    trackUsage(usage);
    const reply = addEl(tutorMessagesEl, "div", "msg teacher");
    addEl(reply, "div", "bubble", answer);
    tutorHistory.push({ role: "user", content: text });
    tutorHistory.push({ role: "assistant", content: answer });
    tutorTurns.push({ question: text, answer });
  } catch (err) {
    thinking.remove();
    addError(tutorMessagesEl, err.message, () => sendTutorQuestion(text, msg));
  } finally {
    input.disabled = false;
    button.disabled = false;
    input.focus();
    scrollToBottom(tutorMessagesEl);
  }
}

// ---- Session setup ----
function showMain() {
  $("situationLabel").textContent = `Situation: ${situationDisplay}`;
  $("chatInput").focus();
}

// A scenario is either an {learner, ai} object (generated deck) or a plain
// string (custom situation, or the old single-string scenarios.json format).
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

function startSession(scenario) {
  const sc = normalizeScenario(scenario);
  situation = sc.ai;
  situationDisplay = sc.learner;
  sessionId = crypto.randomUUID();
  turns = [];
  tutorTurns = [];
  opening = null;
  chatHistory = [];
  tutorHistory = [];
  transcript = [];
  resetUsage();
  resetAudio();
  chatMessagesEl.innerHTML = "";
  tutorMessagesEl.innerHTML = "";
  addTutorIntro();
  showMain();
  // Have the AI open the conversation in character (skipped in demo mode,
  // which renders a canned conversation without calling the API).
  if (!isDemo) generateOpening();
}

// ---- Random scenario deck ----
// Cycles through public/scenarios.json in a shuffled order persisted in
// localStorage, so nothing repeats until the whole deck is exhausted.
let scenarios = [];
const scenariosLoaded = fetch("scenarios.json")
  .then((r) => r.json())
  .then((d) => (scenarios = d))
  .catch(() => {});

function drawFromDeck() {
  let deck = null;
  try {
    deck = JSON.parse(localStorage.getItem("scenarioDeck"));
  } catch {}
  if (!deck || !Array.isArray(deck.order) || deck.order.length !== scenarios.length || deck.cursor >= deck.order.length) {
    const order = [...scenarios.keys()];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    deck = { order, cursor: 0 };
  }
  const scenario = scenarios[deck.order[deck.cursor]];
  deck.cursor++;
  localStorage.setItem("scenarioDeck", JSON.stringify(deck));
  return scenario;
}

// Start (or restart) a conversation with a fresh random scenario.
async function startRandomSession() {
  await scenariosLoaded;
  if (!scenarios.length) return;
  startSession(drawFromDeck());
}

$("randomizeBtn").addEventListener("click", startRandomSession);

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
bindKeyInput("anthropicKey", "anthropicApiKey", () => {
  // Just supplied a key and the opening never got to run → kick it off now,
  // so pasting the key makes the conversation appear without a manual retry.
  if (openingFailed && getAnthropicKey() && !opening) generateOpening();
});
bindKeyInput("elevenLabsKey", "elevenLabsApiKey", applyTtsVisibility);

const modelSelectEl = $("modelSelect");
modelSelectEl.value = model;
if (modelSelectEl.value !== model) {
  // Stored value no longer in the list — fall back to the first option.
  model = modelSelectEl.value || "claude-opus-4-8";
}
modelSelectEl.addEventListener("change", () => {
  model = modelSelectEl.value;
  localStorage.setItem("model", model);
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

// ---- Boot ----
// No start screen: jump straight into a conversation with a random scenario.
// First-run with no API key: open Settings and focus the key field so the
// user knows what to do (the scenario still loads; the opening shows an
// inline "add your key" message that resolves the moment a key is pasted).
if (!isDemo) {
  startRandomSession();
  if (!getAnthropicKey()) {
    toggleSettings(true);
    $("anthropicKey").focus();
  }
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
