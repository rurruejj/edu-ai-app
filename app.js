"use strict";

const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();

// Адрес сервера передаёт бот в ссылке: ?api=...
const API = (new URLSearchParams(location.search).get("api") || "").replace(/\/$/, "");
const tgUser = (tg.initDataUnsafe && tg.initDataUnsafe.user) || null;
const $ = (id) => document.getElementById(id);

const S = {
  folders: [], currentId: null, style: "medium", hasKey: false, sending: false,
  tab: "chat", overview: null, quiz: null, token: 0, loadTimer: null,
};
let pendingFile = null;

const STYLES = [
  { id: "dummy",  icon: "book",   title: "Как для чайника", desc: "Самыми простыми словами, с аналогиями из жизни" },
  { id: "medium", icon: "chat",   title: "Умеренно",        desc: "Понятно и по делу, с нужными терминами" },
  { id: "short",  icon: "bolt",   title: "Кратко",          desc: "Только суть, тезисами" },
  { id: "exam",   icon: "target", title: "К экзамену",      desc: "Определения, термины и вопросы для самопроверки" },
];
const GRADS = [
  "linear-gradient(135deg,#7C6CFF,#4C8DFF)", "linear-gradient(135deg,#F472B6,#FB7185)",
  "linear-gradient(135deg,#34D399,#38BDF8)", "linear-gradient(135deg,#FBBF24,#FB923C)",
  "linear-gradient(135deg,#A78BFA,#F472B6)", "linear-gradient(135deg,#22D3EE,#6366F1)",
];
const gradOf = (id) => GRADS[Math.abs(Number(id)) % GRADS.length];

/* ===== Утилиты ===== */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  const p = props || {};
  for (const k in p) {
    const v = p[k];
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
  }
  kids.flat().forEach((c) => {
    if (c == null || c === false) return;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  });
  return el;
}

function ic(name, cls) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", cls || "ic");
  const use = document.createElementNS(ns, "use");
  use.setAttribute("href", "#i-" + name);
  svg.appendChild(use);
  return svg;
}

function plural(n, f) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return f[2];
  if (b > 1 && b < 5) return f[1];
  if (b === 1) return f[0];
  return f[2];
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("on"), 3200);
}

const haptic = {
  tap: () => { try { tg.HapticFeedback.impactOccurred("light"); } catch (e) {} },
  ok:  () => { try { tg.HapticFeedback.notificationOccurred("success"); } catch (e) {} },
  err: () => { try { tg.HapticFeedback.notificationOccurred("error"); } catch (e) {} },
};

function applyTheme() {
  const dark = tg.colorScheme !== "light";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  const bg = dark ? "#0B0D17" : "#F4F5FB";
  try { tg.setHeaderColor(bg); tg.setBackgroundColor(bg); } catch (e) {}
}

function confirmDialog(message, onYes) {
  if (tg.isVersionAtLeast && tg.isVersionAtLeast("6.2") && tg.showConfirm) {
    tg.showConfirm(message, (ok) => { if (ok) onYes(); });
  } else if (window.confirm(message)) {
    onYes();
  }
}

async function api(path, opts) {
  const r = await fetch(API + path, Object.assign({}, opts || {}, { headers: { "X-Init-Data": tg.initData } }));
  const raw = await r.text();
  let data = {};
  try { data = JSON.parse(raw); } catch (e) {}
  if (!r.ok) throw new Error(data.detail || ("Ошибка " + r.status));
  return data;
}

function formOf(obj) {
  const fd = new FormData();
  Object.keys(obj).forEach((k) => fd.append(k, obj[k]));
  return fd;
}

/* ===== Окна снизу ===== */
function openSheet(title, ...nodes) {
  $("sheetTitle").textContent = title;
  $("sheetBody").replaceChildren(...nodes.filter(Boolean));
  $("sheet").classList.add("open");
  haptic.tap();
}
function closeSheet() { $("sheet").classList.remove("open"); }

/* ===== Вкладки ===== */
function switchTab(tab) {
  S.tab = tab;
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + tab));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  haptic.tap();
  if (tab === "tests") loadTests(false);
  if (tab === "profile") { renderProfile(); loadTests(true); }
}

/* ===== Чат ===== */
const chatEl = $("chat"), input = $("input"), sendBtn = $("send"), fileInput = $("fileInput"), filebar = $("filebar");

function scrollDown() { chatEl.scrollTop = chatEl.scrollHeight; }
function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 120) + "px"; }

function setBody(el, role, text) {
  if (role === "user") el.textContent = text;
  else el.innerHTML = DOMPurify.sanitize(marked.parse(text));
}

function addMessage(role, text, fileName) {
  const el = h("div", { class: "msg " + (role === "user" ? "user" : "bot") });
  if (fileName) el.append(h("div", { class: "file" }, ic("clip", "ic sm"), fileName));
  const body = h("div", { class: "md" });
  setBody(body, role, text || "");
  el.append(body);
  chatEl.append(el);
  scrollDown();
  return el;
}

function addTyping() {
  const el = h("div", { class: "msg bot" }, h("div", { class: "dots" }, h("i"), h("i"), h("i")));
  chatEl.append(el);
  scrollDown();
  return el;
}

function showEmpty() {
  const chips = ["Объясни простыми словами", "Сделай краткий конспект", "Что важно знать к экзамену?"];
  chatEl.append(h("div", { class: "empty", id: "emptyState" },
    h("div", { class: "empty-ic" }, ic("sparkles", "ic lg")),
    h("div", { class: "empty-title" }, S.hasKey ? "Эта папка пока пустая" : "Подключи нейросеть"),
    h("div", { class: "empty-sub" }, S.hasKey
      ? "Пришли файл (PDF, фото, аудио лекции) или задай вопрос, и я объясню."
      : "Напиши боту команду /setkey и пришли свой ключ Gemini."),
    S.hasKey ? h("div", { class: "chips" }, chips.map((c) =>
      h("button", { class: "chip", onclick: () => { input.value = c; autosize(); input.focus(); } }, c))) : null
  ));
}

function setFile(file) {
  pendingFile = file;
  $("filename").textContent = file ? file.name : "";
  filebar.classList.toggle("on", !!file);
  if (!file) fileInput.value = "";
}

function updateSub() {
  const s = STYLES.find((x) => x.id === S.style);
  $("subEl").textContent = s ? "Стиль: " + s.title : "";
}

async function send() {
  if (S.sending || S.currentId === null) return;
  const text = input.value.trim();
  if (!text && !pendingFile) return;

  const folderId = S.currentId;
  const fd = formOf({ folder_id: folderId, text: text });
  if (pendingFile) fd.append("file", pendingFile);

  const es = $("emptyState");
  if (es) es.remove();
  addMessage("user", text, pendingFile ? pendingFile.name : null);
  input.value = "";
  autosize();
  setFile(null);
  S.sending = true;
  sendBtn.disabled = true;
  haptic.tap();

  const typing = addTyping();
  try {
    const data = await api("/api/chat", { method: "POST", body: fd });
    const body = h("div", { class: "md" });
    typing.replaceChildren(body);
    setBody(body, "model", data.answer);
    updateFolderName(folderId, data.folder_name);
    moveToTop(folderId);
  } catch (e) {
    typing.replaceChildren(h("div", { class: "md" }, "Ошибка: " + e.message));
  }
  S.sending = false;
  sendBtn.disabled = false;
  scrollDown();
}

/* ===== Папки ===== */
function saveLast(id) { try { localStorage.setItem("lastFolder", String(id)); } catch (e) {} }
function loadLast() { try { return Number(localStorage.getItem("lastFolder")); } catch (e) { return null; } }

function updateFolderName(id, name) {
  const f = S.folders.find((x) => x.id === id);
  if (f && name) f.name = name;
  if (S.currentId === id && name) $("titleEl").textContent = name;
}

function moveToTop(id) {
  const i = S.folders.findIndex((x) => x.id === id);
  if (i > 0) S.folders.unshift(S.folders.splice(i, 1)[0]);
}

async function openFolder(id) {
  S.currentId = id;
  saveLast(id);
  const f = S.folders.find((x) => x.id === id);
  $("titleEl").textContent = f ? f.name : "EDU AI";
  chatEl.replaceChildren();
  setFile(null);
  try {
    const data = await api("/api/history?folder_id=" + id);
    if (S.currentId !== id) return;
    if (data.messages.length === 0) showEmpty();
    else data.messages.forEach((m) => addMessage(m.role, m.text, m.file_name));
  } catch (e) {
    addMessage("model", "Ошибка: " + e.message);
  }
  scrollDown();
}

function openFolders() {
  const list = h("div");
  S.folders.forEach((f) => list.append(
    h("div", { class: "row-item" + (f.id === S.currentId ? " on" : ""), onclick: () => { closeSheet(); openFolder(f.id); } },
      h("div", { class: "tile", style: "width:40px;height:40px;border-radius:12px;font-size:16px;background:" + gradOf(f.id) }, (f.name || "?")[0].toUpperCase()),
      h("div", { class: "ri-name" }, f.name),
      h("button", { class: "ri-del", onclick: (e) => { e.stopPropagation(); removeFolder(f.id); } }, ic("trash", "ic sm")))
  ));
  openSheet("Папки", list,
    h("button", { class: "btn", onclick: () => { closeSheet(); newFolder(); } }, ic("plus"), "Новая папка"));
}

async function newFolder() {
  try {
    const f = await api("/api/folder/new", { method: "POST" });
    S.folders.unshift({ id: f.id, name: f.name });
    await openFolder(f.id);
    loadTests(true);
  } catch (e) { toast("Не удалось создать папку: " + e.message); }
}

function removeFolder(id) {
  const f = S.folders.find((x) => x.id === id);
  confirmDialog("Удалить папку «" + (f ? f.name : "") + "» вместе с перепиской?", async () => {
    try {
      await api("/api/folder/delete", { method: "POST", body: formOf({ folder_id: id }) });
      S.folders = S.folders.filter((x) => x.id !== id);
      closeSheet();
      if (S.currentId === id) {
        if (S.folders.length) await openFolder(S.folders[0].id);
        else await newFolder();
      }
      loadTests(true);
    } catch (e) { toast("Не удалось удалить: " + e.message); }
  });
}

function openRename() {
  const f = S.folders.find((x) => x.id === S.currentId);
  if (!f) return;
  const inp = h("input", { class: "input", maxlength: "60", value: f.name, placeholder: "Например: Экономическая теория" });
  openSheet("Название папки", inp,
    h("button", { class: "btn", onclick: async () => {
      const name = inp.value.trim();
      if (!name) return;
      try {
        const data = await api("/api/folder/rename", { method: "POST", body: formOf({ folder_id: f.id, name: name }) });
        updateFolderName(f.id, data.name);
        closeSheet();
        loadTests(true);
      } catch (e) { toast("Не удалось переименовать: " + e.message); }
    } }, "Сохранить"));
  setTimeout(() => inp.focus(), 350);
}

/* ===== Профиль ===== */
function displayName() {
  if (!tgUser) return "Гость";
  return [tgUser.first_name, tgUser.last_name].filter(Boolean).join(" ") || "Без имени";
}

function avatarNode() {
  const inner = h("div");
  const initials = tgUser
    ? ((tgUser.first_name || "?")[0] + (tgUser.last_name ? tgUser.last_name[0] : "")).toUpperCase()
    : "?";
  if (tgUser && tgUser.photo_url) {
    const img = h("img", { alt: "" });
    img.onerror = () => { img.remove(); inner.textContent = initials; };
    img.src = tgUser.photo_url;
    inner.append(img);
  } else {
    inner.textContent = initials;
  }
  return h("div", { class: "p-avatar" }, inner);
}

function statCard(icon, cls, label, value) {
  return h("div", { class: "stat" },
    h("div", { class: "stat-top" }, h("span", { class: cls || "" }, ic(icon, "ic sm")), label),
    h("div", { class: "stat-val" }, value));
}

function statsNode(st) {
  return h("div", { class: "stats" },
    statCard("flame", "flame", "Серия", st.streak + " " + plural(st.streak, ["день", "дня", "дней"])),
    statCard("check", "", "Тестов", st.attempts),
    statCard("sparkles", "", "Средний", st.avg + "%"));
}

function renderProfile() {
  const root = $("profileBody");
  root.replaceChildren();
  const st = (S.overview && S.overview.stats) || { streak: 0, attempts: 0, avg: 0 };
  root.append(
    h("div", { class: "p-head" }, avatarNode(),
      h("div", { class: "p-name" }, displayName()),
      tgUser && tgUser.username ? h("div", { class: "p-user" }, "@" + tgUser.username) : null),
    statsNode(st),
    h("div", { class: "section-title" }, "Как объяснять материал"),
    STYLES.map((s) => h("button", { class: "style-opt" + (s.id === S.style ? " on" : ""), onclick: () => chooseStyle(s.id) },
      h("div", { class: "so-ic" }, ic(s.icon)),
      h("div", { class: "so-text" }, h("div", { class: "so-t" }, s.title), h("div", { class: "so-d" }, s.desc)),
      h("div", { class: "so-check" }, ic("check")))),
    h("div", { class: "status" }, h("span", { class: "dot" + (S.hasKey ? "" : " off") }),
      S.hasKey ? "Нейросеть подключена" : "Ключ Gemini не подключён. Напиши боту команду /setkey")
  );
}

async function chooseStyle(id) {
  const prev = S.style;
  S.style = id;
  haptic.tap();
  renderProfile();
  updateSub();
  try {
    await api("/api/settings", { method: "POST", body: formOf({ style: id }) });
  } catch (e) {
    S.style = prev;
    renderProfile();
    updateSub();
    toast("Не удалось сохранить стиль: " + e.message);
  }
}

/* ===== Тесты: список предметов ===== */
async function loadTests(silent) {
  if (!API) return;
  if (!silent && !S.overview) {
    $("testsBody").replaceChildren(h("div", { class: "skel" }), h("div", { class: "skel" }), h("div", { class: "skel" }));
  }
  try {
    S.overview = await api("/api/quiz/overview");
    renderTests();
    if (S.tab === "profile") renderProfile();
  } catch (e) {
    if (!S.overview) $("testsBody").replaceChildren(h("div", { class: "status" }, "Ошибка: " + e.message));
  }
}

function subjectCard(f) {
  let meta;
  if (f.attempts) meta = f.attempts + " " + plural(f.attempts, ["тест", "теста", "тестов"]) + " · лучший " + f.best + "%";
  else meta = f.messages ? "Пока без тестов" : "Нет материала";
  const spark = h("div", { class: "spark" },
    f.recent.slice().reverse().map((p) => h("i", { style: "height:" + Math.max(12, p) + "%" })));
  return h("button", { class: "subject", onclick: () => openQuizSetup(f) },
    h("div", { class: "tile", style: "background:" + gradOf(f.folder_id) }, (f.name || "?")[0].toUpperCase()),
    h("div", { class: "s-info" }, h("div", { class: "s-name" }, f.name), h("div", { class: "s-meta" }, meta)),
    f.recent.length ? spark : null,
    ic("chevron"));
}

function renderTests() {
  const root = $("testsBody");
  const ov = S.overview;
  if (!ov) return;
  root.replaceChildren(statsNode(ov.stats), h("div", { class: "section-title" }, "Выбери предмет"));
  if (!ov.folders.length) root.append(h("div", { class: "status" }, "Папок пока нет. Создай папку в чате и пришли материал."));
  ov.folders.forEach((f) => root.append(subjectCard(f)));
}

function seg(items, value, onPick) {
  const wrap = h("div", { class: "seg" });
  items.forEach((it) => {
    const b = h("button", { class: it.v === value ? "on" : "", onclick: () => {
      Array.from(wrap.children).forEach((c) => c.classList.remove("on"));
      b.classList.add("on");
      onPick(it.v);
      haptic.tap();
    } }, it.t);
    wrap.append(b);
  });
  return wrap;
}

function openQuizSetup(f) {
  const o = { count: 10, difficulty: "medium", mode: "train" };
  const has = f.messages > 0;
  openSheet(f.name,
    has ? null : h("div", { class: "status" }, h("span", { class: "dot off" }), "В этой папке пока нет материала. Пришли файл или задай вопрос в чате."),
    h("div", { class: "label" }, "Количество вопросов"),
    seg([{ v: 5, t: "5" }, { v: 10, t: "10" }, { v: 15, t: "15" }], 10, (v) => { o.count = v; }),
    h("div", { class: "label" }, "Сложность"),
    seg([{ v: "easy", t: "Лёгкий" }, { v: "medium", t: "Средний" }, { v: "hard", t: "Сложный" }], "medium", (v) => { o.difficulty = v; }),
    h("div", { class: "label" }, "Режим"),
    seg([{ v: "train", t: "Тренировка" }, { v: "exam", t: "Экзамен" }], "train", (v) => { o.mode = v; }),
    h("div", { class: "hint" }, "Тренировка: сразу видно, верно или нет. Экзамен: разбор только в конце."),
    h("button", { class: "btn", disabled: !has, onclick: () => startQuiz(f, o) }, ic("play", "ic sm"), "Начать тест"));
}

/* ===== Тесты: прохождение ===== */
function showQuiz() {
  $("quiz").classList.add("open");
  try { tg.BackButton.show(); } catch (e) {}
}

function hideQuiz() {
  clearInterval(S.loadTimer);
  S.token++;
  $("quiz").classList.remove("open");
  try { tg.BackButton.hide(); } catch (e) {}
  S.quiz = null;
  loadTests(true);
}

function closeBtn(ask) {
  return h("button", { class: "q-close", onclick: () => {
    if (ask) confirmDialog("Выйти из теста? Прогресс не сохранится.", hideQuiz);
    else hideQuiz();
  } }, ic("x"));
}

function showLoading(title) {
  showQuiz();
  const phrases = ["Читаю твои материалы…", "Выбираю главное…", "Придумываю вопросы…", "Готовлю варианты ответов…", "Пишу пояснения…"];
  let i = 0;
  const sub = h("div", { class: "load-s" }, phrases[0]);
  $("quizBody").replaceChildren(
    h("div", { class: "q-top" }, closeBtn(false)),
    h("div", { class: "center-col" }, h("div", { class: "orb" }), h("div", { class: "load-t" }, "Составляю тест"), h("div", { class: "hint", style: "margin:0" }, title), sub));
  clearInterval(S.loadTimer);
  S.loadTimer = setInterval(() => { i = (i + 1) % phrases.length; sub.textContent = phrases[i]; }, 2200);
}

async function startQuiz(f, o) {
  closeSheet();
  const token = ++S.token;
  showLoading(f.name);
  try {
    const q = await api("/api/quiz/generate", { method: "POST", body: formOf({ folder_id: f.folder_id, count: o.count, difficulty: o.difficulty }) });
    if (token !== S.token) return;
    clearInterval(S.loadTimer);
    beginQuiz(q, f.name, o.mode);
  } catch (e) {
    if (token !== S.token) return;
    hideQuiz();
    toast(e.message);
  }
}

function beginQuiz(q, title, mode) {
  S.quiz = { id: q.quiz_id, folderId: q.folder_id, title: title, mode: mode, questions: q.questions, answers: [], i: 0, locked: false, done: false, opts: [] };
  renderQuestion();
}

function renderQuestion() {
  const Q = S.quiz, n = Q.questions.length, q = Q.questions[Q.i];
  Q.locked = false;

  const fill = h("div", { class: "q-fill", style: "width:" + (Math.max(Q.i - 1, 0) / n * 100) + "%" });
  requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = (Q.i / n * 100) + "%"; }));
  const top = h("div", { class: "q-top" }, closeBtn(true), h("div", { class: "q-track" }, fill), h("div", { class: "q-count" }, (Q.i + 1) + "/" + n));

  Q.opts = q.options.map((text, j) => h("button", { class: "opt", onclick: () => pick(j) },
    h("span", { class: "opt-letter" }, "ABCD"[j]), h("span", { class: "opt-text" }, text)));

  const scroll = h("div", { class: "q-scroll", id: "qScroll" },
    h("div", { class: "q-sub" }, Q.title), h("div", { class: "q-title" }, q.question), Q.opts, h("div", { id: "explainBox" }));
  const foot = h("div", { class: "q-foot" },
    h("button", { class: "btn hidden", id: "nextBtn", onclick: nextQuestion }, Q.i === n - 1 ? "Завершить" : "Далее"));
  $("quizBody").replaceChildren(top, scroll, foot);
}

function pick(j) {
  const Q = S.quiz;
  if (!Q || Q.locked) return;
  Q.locked = true;
  const q = Q.questions[Q.i];
  Q.answers[Q.i] = j;
  const right = j === q.correct_index;
  Q.opts.forEach((b, k) => {
    b.disabled = true;
    if (Q.mode === "train") {
      if (k === q.correct_index) b.classList.add("correct");
      else if (k === j) b.classList.add("wrong");
    } else if (k === j) {
      b.classList.add("chosen");
    }
  });
  if (Q.mode === "train") {
    if (right) haptic.ok(); else haptic.err();
    $("explainBox").replaceChildren(h("div", { class: "explain " + (right ? "ok" : "bad") },
      h("b", {}, ic(right ? "circle-check" : "circle-x", "ic sm"), right ? "Верно" : "Неверно"),
      q.explanation || ""));
  } else {
    haptic.tap();
  }
  $("nextBtn").classList.remove("hidden");
  setTimeout(() => { const s = $("qScroll"); if (s) s.scrollTop = s.scrollHeight; }, 60);
}

function nextQuestion() {
  const Q = S.quiz;
  if (!Q) return;
  Q.i++;
  if (Q.i < Q.questions.length) renderQuestion();
  else finishQuiz();
}

async function finishQuiz() {
  const Q = S.quiz;
  $("quizBody").replaceChildren(h("div", { class: "center-col" }, h("div", { class: "orb" }), h("div", { class: "load-t" }, "Считаю результат")));
  let res;
  try {
    res = await api("/api/quiz/finish", { method: "POST", body: formOf({ quiz_id: Q.id, answers: JSON.stringify(Q.answers) }) });
  } catch (e) {
    const score = Q.questions.filter((q, i) => Q.answers[i] === q.correct_index).length;
    res = { attempt_id: null, score: score, total: Q.questions.length };
    toast("Результат не сохранился: " + e.message);
  }
  if (S.quiz !== Q) return;
  renderResults(res);
}

/* ===== Тесты: итоги ===== */
function renderResults(res) {
  const Q = S.quiz, n = Q.questions.length, score = res.score;
  Q.done = true;
  const pct = Math.round(score / n * 100);
  const C = 2 * Math.PI * 54;

  const ring = h("div", { class: "ring-wrap" });
  ring.innerHTML = '<svg class="ring" viewBox="0 0 120 120"><circle class="bg" cx="60" cy="60" r="54" fill="none" stroke-width="10"/>' +
    '<circle class="fg" cx="60" cy="60" r="54" fill="none" stroke-width="10" stroke-linecap="round" stroke-dasharray="' + C + '" stroke-dashoffset="' + C + '"/></svg>';
  const pctEl = h("div", { class: "ring-pct" }, "0%");
  ring.append(h("div", { class: "ring-num" }, pctEl, h("div", { class: "ring-of" }, score + " из " + n)));

  const fg = ring.querySelector(".fg");
  requestAnimationFrame(() => requestAnimationFrame(() => { fg.style.strokeDashoffset = C * (1 - pct / 100); }));
  const t0 = performance.now();
  const tick = (t) => {
    const k = Math.min(1, (t - t0) / 1000);
    pctEl.textContent = Math.round(pct * k) + "%";
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  const title = pct >= 90 ? "Блестяще!" : pct >= 70 ? "Отличный результат" : pct >= 50 ? "Неплохо, есть что подтянуть" : "Давай повторим материал";
  const wrongCount = n - score;

  const actions = h("div", { class: "actions" },
    wrongCount > 0 && res.attempt_id
      ? h("button", { class: "btn", onclick: () => retryMistakes(res.attempt_id) }, ic("refresh", "ic sm"), "Повторить ошибки (" + wrongCount + ")")
      : null,
    h("button", { class: "btn" + (wrongCount > 0 && res.attempt_id ? " ghost" : ""), onclick: () => newTest(Q.folderId) }, ic("play", "ic sm"), "Новый тест"),
    h("button", { class: "btn ghost", onclick: hideQuiz }, "К тестам"));

  const review = Q.questions.map((q, i) => {
    const chosen = Q.answers[i];
    const ok = chosen === q.correct_index;
    return h("div", { class: "rv" },
      h("div", { class: "rv-head" },
        h("div", { class: "badge " + (ok ? "ok" : "bad") }, ic(ok ? "check" : "x", "ic sm")),
        h("div", { class: "rv-q" }, q.question)),
      h("div", { class: "rv-line" }, h("span", {}, "Твой ответ: "), chosen !== undefined && chosen >= 0 ? q.options[chosen] : "нет ответа"),
      ok ? null : h("div", { class: "rv-line" }, h("span", {}, "Верный ответ: "), q.options[q.correct_index]),
      q.explanation ? h("div", { class: "rv-exp" }, q.explanation) : null,
      h("button", { class: "linkbtn", onclick: () => explainMore(Q.folderId, q.question) }, ic("sparkles", "ic sm"), "Объяснить подробнее"));
  });

  $("quizBody").replaceChildren(
    h("div", { class: "q-top", style: "justify-content:flex-end" }, closeBtn(false)),
    h("div", { class: "q-scroll" },
      ring,
      h("div", { class: "res-title" }, title),
      h("div", { class: "res-sub" }, wrongCount > 0 ? "Разбери ошибки ниже и попробуй ещё раз" : "Все ответы верные"),
      actions,
      h("div", { class: "section-title" }, "Разбор"),
      review));

  if (pct >= 80) { haptic.ok(); confetti(); } else { haptic.tap(); }
}

function confetti() {
  const box = h("div", { class: "confetti" });
  const colors = ["#7C6CFF", "#38BDF8", "#34D399", "#FBBF24", "#FB7185"];
  for (let i = 0; i < 36; i++) {
    const p = h("i");
    p.style.left = Math.random() * 100 + "%";
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = Math.random() * 0.4 + "s";
    p.style.animationDuration = 1.6 + Math.random() * 1.2 + "s";
    box.append(p);
  }
  $("quiz").append(box);
  setTimeout(() => box.remove(), 3500);
}

async function retryMistakes(attemptId) {
  const title = S.quiz.title, mode = S.quiz.mode;
  const token = ++S.token;
  showLoading(title);
  try {
    const q = await api("/api/quiz/retry", { method: "POST", body: formOf({ attempt_id: attemptId }) });
    if (token !== S.token) return;
    clearInterval(S.loadTimer);
    beginQuiz(q, title + " · работа над ошибками", mode);
  } catch (e) {
    if (token !== S.token) return;
    hideQuiz();
    toast(e.message);
  }
}

function newTest(folderId) {
  hideQuiz();
  switchTab("tests");
  const f = S.overview && S.overview.folders.find((x) => x.folder_id === folderId);
  if (f) openQuizSetup(f);
}

async function explainMore(folderId, question) {
  hideQuiz();
  switchTab("chat");
  if (S.currentId !== folderId) await openFolder(folderId);
  input.value = "Объясни подробнее: " + question;
  autosize();
  input.focus();
}

/* ===== События ===== */
sendBtn.addEventListener("click", send);
$("attach").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => setFile(fileInput.files[0] || null));
$("removeFile").addEventListener("click", () => setFile(null));
input.addEventListener("input", autosize);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !("ontouchstart" in window)) { e.preventDefault(); send(); }
});
input.addEventListener("focus", () => document.body.classList.add("typing"));
input.addEventListener("blur", () => setTimeout(() => document.body.classList.remove("typing"), 120));
$("menuBtn").addEventListener("click", openFolders);
$("renameBtn").addEventListener("click", openRename);
$("sheetBg").addEventListener("click", closeSheet);
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));
try {
  tg.BackButton.onClick(() => {
    if (!$("quiz").classList.contains("open")) return;
    if (S.quiz && !S.quiz.done) confirmDialog("Выйти из теста? Прогресс не сохранится.", hideQuiz);
    else hideQuiz();
  });
  tg.onEvent("themeChanged", applyTheme);
} catch (e) {}

/* ===== История тестов ===== */
S.testsView = "subjects";
S.history = null;

const DIFF_LABEL = { easy: "Лёгкий", medium: "Средний", hard: "Сложный" };

function parseDate(s) { return new Date(String(s).replace(" ", "T") + "Z"); }

function dayLabel(d) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 86400000);
  if (diff === 0) return "Сегодня";
  if (diff === 1) return "Вчера";
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
}

function pctColor(p) { return p >= 80 ? "var(--ok)" : p >= 50 ? "var(--warn)" : "var(--bad)"; }

async function loadHistory() {
  const data = await api("/api/quiz/history");
  S.history = data.attempts;
}

async function loadTests(silent) {
  if (!API) return;
  if (!silent && !S.overview) {
    $("testsBody").replaceChildren(h("div", { class: "skel" }), h("div", { class: "skel" }), h("div", { class: "skel" }));
  }
  try {
    S.overview = await api("/api/quiz/overview");
    if (S.testsView === "history") await loadHistory();
    renderTests();
    if (S.tab === "profile") renderProfile();
  } catch (e) {
    if (!S.overview) $("testsBody").replaceChildren(h("div", { class: "status" }, "Ошибка: " + e.message));
  }
}

async function setTestsView(v) {
  S.testsView = v;
  haptic.tap();
  if (v === "history") {
    try { await loadHistory(); } catch (e) { toast(e.message); }
  }
  renderTests();
}

function renderTests() {
  const root = $("testsBody");
  const ov = S.overview;
  if (!ov) return;
  const toggle = seg([{ v: "subjects", t: "Предметы" }, { v: "history", t: "История" }], S.testsView, setTestsView);
  root.replaceChildren(statsNode(ov.stats), toggle);
  if (S.testsView === "history") { renderHistoryInto(root); return; }
  root.append(h("div", { class: "section-title" }, "Выбери предмет"));
  if (!ov.folders.length) root.append(h("div", { class: "status" }, "Папок пока нет. Создай папку в чате и пришли материал."));
  ov.folders.forEach((f) => root.append(subjectCard(f)));
}

function renderHistoryInto(root) {
  const list = S.history || [];
  if (!list.length) {
    root.append(h("div", { class: "empty", style: "padding:40px 20px" },
      h("div", { class: "empty-ic" }, ic("list", "ic lg")),
      h("div", { class: "empty-title" }, "История пуста"),
      h("div", { class: "empty-sub" }, "Пройди первый тест, и он появится здесь.")));
    return;
  }
  let lastDay = "";
  list.forEach((a) => {
    const d = parseDate(a.created_at);
    const label = dayLabel(d);
    if (label !== lastDay) { root.append(h("div", { class: "section-title" }, label)); lastDay = label; }
    const pct = a.total ? Math.round(a.score / a.total * 100) : 0;
    const time = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    root.append(h("button", { class: "subject", onclick: () => openAttempt(a.id) },
      h("div", { class: "tile", style: "background:" + gradOf(a.folder_id) }, (a.folder_name || "?")[0].toUpperCase()),
      h("div", { class: "s-info" },
        h("div", { class: "s-name" }, a.folder_name || "Удалённая папка"),
        h("div", { class: "s-meta" }, a.score + " из " + a.total + " · " + (DIFF_LABEL[a.difficulty] || "Средний") + " · " + time)),
      h("div", { class: "pct-badge", style: "color:" + pctColor(pct) + ";border-color:" + pctColor(pct) }, pct + "%")));
  });
}

async function openAttempt(id) {
  const token = ++S.token;
  showQuiz();
  $("quizBody").replaceChildren(
    h("div", { class: "q-top" }, closeBtn(false)),
    h("div", { class: "center-col" }, h("div", { class: "orb" }), h("div", { class: "load-t" }, "Открываю результат")));
  try {
    const d = await api("/api/quiz/attempt?attempt_id=" + id);
    if (token !== S.token) return;
    const a = (S.history || []).find((x) => x.id === id);
    S.quiz = {
      id: d.quiz_id, folderId: d.folder_id, title: a && a.folder_name ? a.folder_name : "Тест", mode: "train",
      questions: d.questions, answers: d.answers, i: 0, locked: true, done: true, opts: [], review: true,
    };
    renderResults({ attempt_id: d.attempt_id, score: d.score, total: d.total });
  } catch (e) {
    if (token !== S.token) return;
    hideQuiz();
    toast(e.message);
  }
}

// При просмотре старого результата конфетти не показываем
function confetti() {
  if (S.quiz && S.quiz.review) return;
  const box = h("div", { class: "confetti" });
  const colors = ["#7C6CFF", "#38BDF8", "#34D399", "#FBBF24", "#FB7185"];
  for (let i = 0; i < 36; i++) {
    const p = h("i");
    p.style.left = Math.random() * 100 + "%";
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = Math.random() * 0.4 + "s";
    p.style.animationDuration = 1.6 + Math.random() * 1.2 + "s";
    box.append(p);
  }
  $("quiz").append(box);
  setTimeout(() => box.remove(), 3500);
}

/* ===== Запуск ===== */
async function init() {
  applyTheme();
  renderProfile();
  if (!API) {
    addMessage("model", "Не указан адрес сервера. Открой приложение через команду /app в боте.");
    return;
  }
  try {
    const data = await api("/api/bootstrap");
    S.folders = data.folders;
    S.style = data.style;
    S.hasKey = data.has_key;
    updateSub();
    renderProfile();
    const last = loadLast();
    const startId = S.folders.some((f) => f.id === last) ? last : S.folders[0].id;
    await openFolder(startId);
  } catch (e) {
    addMessage("model", "Ошибка: " + e.message);
  }
}

/* ===== Заставка ===== */
const SPLASH_MIN_MS = 1500; // сколько миллисекунд заставка показывается минимум
const splashStart = performance.now();

function hideSplash() {
  const s = $("splash");
  if (!s || s.classList.contains("done")) return;
  s.classList.add("done");
  $("app").classList.add("enter");
  haptic.tap();
  setTimeout(() => s.remove(), 700);
}

// Страховка: если сервер не ответил, заставка всё равно исчезнет через 8 секунд
setTimeout(hideSplash, 8000);

init().finally(() => {
  const wait = Math.max(0, SPLASH_MIN_MS - (performance.now() - splashStart));
  setTimeout(hideSplash, wait);
});