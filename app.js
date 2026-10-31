/* ═══════════════════════════════════════════════════════════════════
   Claude Bridge Mini App — логика (Telegram WebApp + Firebase RTDB)

   Контракт с ботом (firebase/broker.py, менять только вместе с ним):
     bridge/requests/{id}  = {text, initData, ts, settings?} — пишет Mini App
     bridge/responses/{id} = {text, ts, ok?}                 — пишет бот
       ok:false — системный сбой (провайдер упал/лимиты): в UI красный пузырь
     bridge/state          = {stage, status, ts}             — пишет бот
     bridge/presence       = {status, beat}                  — пишет бот
     bridge/handshake/{id} = {uid, initData, ts}             — пишет Mini App
     bridge/tokens/{uid}   = {token, exp, ts}                — пишет бот

   Последняя пара — хендшейк харденинга (FIREBASE_SETUP.md §8): анонимная
   сессия просит custom-токен, бот проверяет initData и публикует токен в
   узел, читаемый только той же сессией; signInWithCustomToken поднимает
   claim owner. При ужесточённых правилах ответы/state/personalization
   доступны только сессии с owner-claim, поэтому все подписки настраиваются
   после апгрейда (bridge.init()), а PERMISSION_DENIED показывает понятное
   сообщение в чате.

   settings — вложенный объект {model, temperature, context, system_prompt?,
   global_system_prompt?, project_path?}. project_path (Проекты) задаёт
   рабочую папку запроса — бот проверяет её в llm/router.validate_cwd до
   запуска CLI; system_prompt — префикс промпта (инструкции проекта при
   привязанном чате); global_system_prompt — снимок инструкций
   персонализации чата (снимается при создании и ретроактивно обновляется
   при сохранении правил, syncChatsPersonalization). Бот ставит его перед
   проектными (llm/router.build_prompt): новые инструкции чаты подхватывают
   со следующего сообщения.

   bridge/personalization = {about, style, enabled, updatedAt} — глобальные
   инструкции владельца, общие для всех чатов (пишет сессия с owner-claim).
   Если правила RTDB ещё старые (без узла settings, $other:false), запись
   с settings отклоняется целиком: тогда ретраим запрос по старому
   контракту {text, initData, ts} — мост не ломается до перепубликации
   правил (см. FIREBASE_SETUP.md §6).

   Демо-режим (?mock=1) подменяет Firebase локальным эхо — для e2e-тестов
   без реального проекта Firebase.
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

/* ── Константы ─────────────────────────────────────────────────────── */

const LS_SETTINGS = 'cb.settings.v1';
const LS_CHATS = 'cb.chats.v1';
const LS_CURRENT = 'cb.chat.current';
const LS_PROJECTS = 'cb.projects.v1';
const LS_PERSONALIZATION = 'cb.personalization.v1';
const LS_PERSONALIZATION_LEGACY = 'claude_bridge.global_rules';
const LS_PERSONALIZATION_MIGRATED = 'cb.personalization.migrated.v1';
const GLOBAL_RULES_LIMIT = 1500;

// Возраст запроса, после которого бот его отклоняет (REQUEST_MAX_AGE_SEC брокера)
const REQUEST_TIMEOUT_SEC = 600;

// Префиксы заглушек бота: ответ с таким началом — ошибка, а не ответ модели
const ERROR_STUBS = [
  'Запрос отклонён', 'Запрос просрочен', 'Пустой запрос',
  'Команды из Mini App', 'Не удалось', 'Внутренняя ошибка',
];

// Системные ошибки провайдера: бот помечает ответ флагом ok:false (бот
// свежий) либо текст начинается с «Ошибка выполнения» (llm/base.py, бот
// ещё не перезапущен). Вместо сырого «код 1» — человекочитаемая причина.
const PROVIDER_ERROR_TITLE = 'Провайдер временно недоступен. Переключаюсь...';
const LIMITS_ERROR_TITLE = 'Лимиты модели исчерпаны. Выберите другую';
const LIMITS_RE = /лимит|429|rate[\s_-]?limit|quota|too many requests/i;

// ТОЛЬКО стабильные бесплатные модели: GLM Flash (по умолчанию),
// DeepSeek Flash и Qoder (DeepSeek lite). Нестабильные Nemotron/MiMo/Beam/Flint убраны.
// роутер (llm/router.py) читает префикс «провайдер/модель» из settings.model.
const MODELS = [
  { id: 'opencode/glm-5.3-flash-free', name: 'GLM Flash', full: 'GLM 5.3 Flash (free)', sub: 'OpenCode · быстрая, для повседневных задач' },
  { id: 'opencode/deepseek-v4.1-flash-free', name: 'DeepSeek Flash', full: 'DeepSeek 4.1 Flash (free)', sub: 'OpenCode · сильная в коде и рассуждениях' },
  { id: 'qoder/lite', name: 'Qoder Lite', full: 'Qoder (DeepSeek lite)', sub: 'Qoder CLI · бесплатный DeepSeek' },
];

const DEFAULT_SETTINGS = {
  // legacy-поля персонализации: из них мигрирует claude_bridge.global_rules
  instructions: '',
  replyStyle: '',
  useInstructions: true,
  context: 4096,
  temperature: 1.0,
  shiftEnter: false,
  model: 'opencode/glm-5.3-flash-free',
};

/* ── Telegram WebApp ───────────────────────────────────────────────── */

const tg = window.Telegram?.WebApp || null;
const tgUser = tg?.initDataUnsafe?.user || null;

function initTelegram() {
  if (!tg) return;
  try {
    tg.ready();
    tg.expand();
    // Принудительная светлая тема интерфейса Telegram
    tg.setHeaderColor('#F2F2F7');
    tg.setBackgroundColor('#F2F2F7');
    tg.disableVerticalSwipes?.();
  } catch (e) { console.warn('Telegram WebApp:', e); }
}

const getInitData = () => tg?.initData || '';

/* ── Настройки ─────────────────────────────────────────────────────── */

let settings = { ...DEFAULT_SETTINGS };

function loadSettings() {
  try {
    settings = { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem(LS_SETTINGS)) || {}) };
  } catch { settings = { ...DEFAULT_SETTINGS }; }
  // Миграция со старых id (auto/sonnet/opus/haiku/...): в интерфейсе
  // остались только бесплатные модели — неизвестный id сбрасываем на GLM Flash
  if (!MODELS.some(m => m.id === settings.model)) settings.model = DEFAULT_SETTINGS.model;
}

function saveSettings() {
  try {
    localStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
  } catch (e) { /* квота/приватный режим: настройки живут до перезагрузки */ }
}

/* ── Персонализация: глобальные инструкции ─────────────────────────── */

let globalRules = { about: '', style: '', enabled: true, updatedAt: 0 };

function normalizePersonalization(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return {
    about: typeof raw.about === 'string' ? raw.about.slice(0, GLOBAL_RULES_LIMIT) : '',
    style: typeof raw.style === 'string' ? raw.style.slice(0, GLOBAL_RULES_LIMIT) : '',
    enabled: raw.enabled !== false,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
  };
}

// Старые поля жили в cb.settings.v1 и claude_bridge.global_rules; новый
// экран хранит их отдельно. Миграция читает прежние значения, чтобы
// инструкции не пропали и сразу уехали в облако.
function loadGlobalRules() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(LS_PERSONALIZATION)); } catch { /* битый JSON */ }
  let restored = normalizePersonalization(raw);
  if (!restored) {
    try { raw = JSON.parse(localStorage.getItem(LS_PERSONALIZATION_LEGACY)); } catch { /* нет legacy */ }
    restored = normalizePersonalization(raw);
  }
  if (!restored && (settings.instructions || settings.replyStyle)) {
    restored = {
      about: String(settings.instructions || '').slice(0, GLOBAL_RULES_LIMIT),
      style: String(settings.replyStyle || '').slice(0, GLOBAL_RULES_LIMIT),
      enabled: settings.useInstructions !== false,
      updatedAt: 0,
    };
  }
  if (!restored) return;
  globalRules = restored;
  if (!globalRules.updatedAt) globalRules.updatedAt = Date.now();
  saveGlobalRules();
}

function saveGlobalRules() {
  try {
    localStorage.setItem(LS_PERSONALIZATION, JSON.stringify(globalRules));
  } catch (e) { /* квота/приватный режим: правила живут до перезагрузки */ }
}

async function pushPersonalizationToCloud() {
  if (!bridge || typeof bridge.savePersonalization !== 'function') return false;
  try {
    await bridge.savePersonalization(personalizationSnapshot());
    return true;
  } catch (e) {
    console.warn('personalization save:', e);
    return false;
  }
}

// Последняя запись побеждает по updatedAt. Облако с более свежим
// таймстампом подхватываем, локальное более свежее — отправляем наверх.
function applyPersonalizationFromCloud(raw) {
  const remote = normalizePersonalization(raw);
  if (!remote) {
    if (globalRules.updatedAt > 0) pushPersonalizationToCloud();
    return;
  }
  if (remote.updatedAt > globalRules.updatedAt) {
    globalRules = remote;
    saveGlobalRules();
    fillPersonalizationForm();
    setPersonalizationStatus('Инструкции загружены из облака');
    return;
  }
  if (globalRules.updatedAt > remote.updatedAt) pushPersonalizationToCloud();
}

// Текст для settings.global_system_prompt: подписи полей и значения.
// Пустые поля не превращаются в «О пользователе: .» — просто опускаются.
// Точка-разделитель не дублируется, если поле уже кончается знаком конца
// предложения («…по делу.» → «…по делу. Стиль ответа: …»).
function globalSystemPrompt(rules) {
  if (!rules || !rules.enabled) return '';
  const parts = [];
  const about = String(rules.about || '').trim();
  const style = String(rules.style || '').trim();
  if (about) parts.push('О пользователе: ' + about);
  if (style) parts.push('Стиль ответа: ' + style);
  let text = '';
  for (const part of parts) {
    if (!text) text = part;
    else text += (/[.!?…]$/.test(text) ? ' ' : '. ') + part;
  }
  return text.slice(0, 4000);
}

function personalizationSnapshot() {
  return { ...globalRules };
}

// Вариант B: на первом запуске после обновления замораживаем текущие
// инструкции в уже существующих чатах. Дальше каждый чат живёт со снимком,
// а сохранение новых инструкций ретроактивно обновляет снимки всех чатов
// (см. syncChatsPersonalization).
function migrateChatsToPersonalization() {
  let done = false;
  try { done = localStorage.getItem(LS_PERSONALIZATION_MIGRATED) === '1'; } catch { /* private mode */ }
  if (done) return;
  const snapshot = personalizationSnapshot();
  let changed = false;
  for (const chat of chats) {
    if (!chat.personalization) {
      chat.personalization = { ...snapshot };
      changed = true;
    }
  }
  try { localStorage.setItem(LS_PERSONALIZATION_MIGRATED, '1'); } catch { /* private mode */ }
  if (changed) persistChats();
}

// Что уходит в запрос боту: только значимые для исполнения поля.
// global_system_prompt — снимок персонализации чата; бот ставит его перед
// проектными (llm/router.build_prompt). system_prompt — инструкции проекта,
// ограничены 4000 символов (лимит правил RTDB). У чата без снимка
// (создан до персонализации) глобальных инструкций нет.
function requestSettings() {
  const out = {
    model: settings.model,
    temperature: settings.temperature,
    context: settings.context,
  };
  const chat = currentChat();
  const proj = chat && chat.projectId ? projectById(chat.projectId) : null;
  if (proj) {
    if (proj.path && proj.path.trim()) {
      out.project_path = proj.path.trim().slice(0, 500);
    }
    if (proj.instructions && proj.instructions.trim()) {
      out.system_prompt = proj.instructions.trim().slice(0, 4000);
    }
  }
  const gsp = globalSystemPrompt(chat && chat.personalization);
  if (gsp) out.global_system_prompt = gsp;
  return out;
}

/* ── Чаты (localStorage) ───────────────────────────────────────────── */

let chats = [];              // [{id, title, created, updated, messages:[]}]
let currentChatId = null;
const pending = new Map();   // requestId -> {chatId, timer}
const streams = new Map();   // requestId -> {chatId, msg, el} — частичный ответ

function loadChats() {
  // localStorage может отдать мусор (ручная правка, старая версия, private
  // mode): не-JSON, null, не-массив, битые элементы — всё это не должно
  // валить boot, теряется максимум история чатов.
  try {
    const raw = JSON.parse(localStorage.getItem(LS_CHATS));
    chats = Array.isArray(raw) ? raw.filter(c => c && typeof c === 'object'
      && typeof c.id === 'string' && Array.isArray(c.messages)) : [];
  } catch { chats = []; }
  currentChatId = localStorage.getItem(LS_CURRENT);
  if (!chats.some(c => c.id === currentChatId)) {
    currentChatId = chats.length ? chats[0].id : newChat(true);
  }
}

function persistChats() {
  // Храним не больше 30 последних чатов
  chats.sort((a, b) => b.updated - a.updated);
  chats = chats.slice(0, 30);
  // Квота localStorage (~5 МБ) конечна: длинные чаты с ответами модели её
  // выкидывают QuotaExceededError, и без обработки падает каждый следующий
  // sendMessage. Спасаем историю постепенной обрезкой: старые сообщения
  // удаляются, пока запись не влезет; чат-то текущий не трогаем.
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      localStorage.setItem(LS_CHATS, JSON.stringify(chats));
      localStorage.setItem(LS_CURRENT, currentChatId);
      return;
    } catch (e) {
      const victim = [...chats].sort((a, b) => a.updated - b.updated)
        .find(c => c.id !== currentChatId && c.messages.length > 0);
      if (!victim) {
        // Обрезать больше нечего — молча держим историю в памяти до перезагрузки
        return;
      }
      // Половина сообщений самого старого чата, минимум 1: больших скачков
      // не нужно, попыток хватит любому объёму
      victim.messages.splice(0, Math.max(1, Math.floor(victim.messages.length / 2)));
    }
  }
}

const currentChat = () => chats.find(c => c.id === currentChatId) || null;

function newChat(silent = false, projectId = null) {
  // Если текущий чат пуст — новый не создаём (защита от мусора в Recents).
  // Для чата проекта shortcut отключён: «Новый чат в проекте» обязан
  // всегда создавать новый чат — с чистой историей и привязкой к проекту.
  const cur = currentChat();
  if (!silent && !projectId && cur && cur.messages.length === 0) {
    // «New chat» на пустом чате переиспользует его — снимок обновляем,
    // иначе только что сохранённые инструкции не применятся.
    cur.personalization = personalizationSnapshot();
    currentChatId = cur.id;
    persistChats();
    return cur.id;
  }
  const chat = {
    id: crypto.randomUUID(),
    title: 'Новый чат',
    created: Date.now(),
    updated: Date.now(),
    messages: [],
    projectId: projectId || null,
    personalization: personalizationSnapshot(),
  };
  chats.unshift(chat);
  currentChatId = chat.id;
  persistChats();
  renderAll();
  return chat.id;
}

function switchChat(id) {
  if (id === currentChatId) { closeDrawer(); return; }
  currentChatId = id;
  persistChats();
  closeDrawer();
  renderAll();
}

function touchChat(chat, titleSource) {
  chat.updated = Date.now();
  if (chat.title === 'Новый чат' && titleSource) {
    chat.title = titleSource.replace(/\s+/g, ' ').trim().slice(0, 40) || 'Новый чат';
  }
}

/* ── Проекты (Projects) ──────────────────────────────────────────────── */
// Проект — папка, в которой работает ИИ-агент, + инструкции для этой папки.
// Хранится в localStorage; у чата привязка projectId. Запрос из чата проекта
// уходит с settings.project_path и settings.system_prompt (инструкции
// проекта) — бэкенд валидирует путь в router.validate_cwd (см. Speca.md §3).

let projects = [];             // [{id, title, path, instructions, created, updated}]
let currentProjectId = null;   // проект, открытый на странице настроек
let deleteArmed = false;       // двухшаговое удаление: первый тап — «Точно удалить?»

function loadProjects() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_PROJECTS));
    projects = Array.isArray(raw) ? raw.filter(p => p && typeof p === 'object'
      && typeof p.id === 'string' && typeof p.title === 'string') : [];
    for (const p of projects) {
      p.path = typeof p.path === 'string' ? p.path.slice(0, 500) : '';
      p.instructions = typeof p.instructions === 'string' ? p.instructions.slice(0, 4000) : '';
    }
  } catch { projects = []; }
}

function persistProjects() {
  try {
    localStorage.setItem(LS_PROJECTS, JSON.stringify(projects));
  } catch (e) { /* квота: проекты живут в памяти до перезагрузки */ }
}

const projectById = id => projects.find(p => p.id === id) || null;
const chatCountOfProject = id => chats.filter(c => c.projectId === id).length;

function pluralChats(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'чат';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'чата';
  return 'чатов';
}

function renderProjects() {
  const ul = document.getElementById('projectsList');
  const empty = document.getElementById('projectsEmpty');
  ul.innerHTML = '';
  if (!projects.length) { empty.hidden = false; return; }
  empty.hidden = true;
  const icon = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>';
  for (const p of projects) {
    const n = chatCountOfProject(p.id);
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'project-card';
    const ic = document.createElement('span');
    ic.className = 'p-icon';
    ic.innerHTML = icon;
    const body = document.createElement('span');
    body.className = 'p-body';
    const t = document.createElement('span'); t.className = 'p-title'; t.textContent = p.title;
    const meta = document.createElement('span'); meta.className = 'p-meta';
    meta.textContent = n === 0 ? 'нет чатов' : n + ' ' + pluralChats(n);
    body.append(t, meta);
    btn.append(ic, body);
    btn.addEventListener('click', () => openProjectEditor(p.id));
    li.appendChild(btn);
    ul.appendChild(li);
  }
}

/* Страницы: slide-in поверх основного экрана (z-index 55/56) */

const pageHideTimers = new Map();

function openPage(id) {
  const p = document.getElementById(id);
  // Страницу могли открыть заново, пока шло закрытие: отложенный
  // hidden=true иначе сработает поверх открытой страницы.
  clearTimeout(pageHideTimers.get(id));
  pageHideTimers.delete(id);
  p.hidden = false;
  p.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => p.classList.add('open'));
}

function closePage(id) {
  const p = document.getElementById(id);
  p.classList.remove('open');
  p.setAttribute('aria-hidden', 'true');
  clearTimeout(pageHideTimers.get(id));
  pageHideTimers.set(id, setTimeout(() => {
    pageHideTimers.delete(id);
    p.hidden = true;
  }, 300));
}

function closeAllPages() {
  for (const id of ['pageProject', 'pageProjects', 'pageLibrary',
                    'pagePersonalization', 'pageSettings']) closePage(id);
}

function pageBack(id) {
  if (id === 'pageProject' && !document.getElementById('pageProjects').hidden) {
    closePage('pageProject');
    renderProjects();
    return;
  }
  // Персонализация открыта поверх настроек: назад ведёт в настройки
  if (id === 'pagePersonalization' && !document.getElementById('pageSettings').hidden) {
    closePage('pagePersonalization');
    return;
  }
  if (id === 'pageSettings') {
    fillSettingsForm();   // откат несохранённых правок
    closePage('pageSettings');
    return;
  }
  closeAllPages();
}

function openSettingsPage() {
  fillSettingsForm();
  renderUser();
  setPersonalizationStatus('Правила действуют для всех чатов.');
  openPage('pageSettings');
}

function openProjectEditor(id) {
  currentProjectId = id;
  const creating = !id;
  const p = id ? projectById(id) : null;
  if (id && !p) return;

  const labelRow = document.getElementById('projectNameRow');
  const label = document.getElementById('projectNameLabel');
  const input = document.getElementById('projectNameInput');
  const renameSave = document.getElementById('btnProjectRenameSave');

  document.getElementById('pageProjectTitle').textContent = creating ? 'New project' : 'Проект';
  if (creating) {
    labelRow.hidden = true;
    input.hidden = false;
    input.value = '';
    renameSave.hidden = true;
  } else {
    labelRow.hidden = false;
    label.textContent = p.title;
    input.hidden = true;
    renameSave.hidden = true;
  }
  document.getElementById('projectPath').value = p ? p.path : '';
  document.getElementById('projectInstructions').value = p ? p.instructions : '';
  document.getElementById('btnProjectSave').textContent = creating ? 'Создать проект' : 'Сохранить';
  document.getElementById('btnProjectNewChat').hidden = creating;
  // Удалять можно только существующий проект: в черновике кнопки нет
  document.getElementById('btnProjectDelete').hidden = creating;
  disarmDelete();
  openPage('pageProject');
}

function saveProject() {
  const input = document.getElementById('projectNameInput');
  const label = document.getElementById('projectNameLabel');
  const title = (input.hidden ? label.textContent : input.value)
    .trim().replace(/\s+/g, ' ').slice(0, 60) || 'Проект';
  const ppath = document.getElementById('projectPath').value.trim().slice(0, 500);
  const instructions = document.getElementById('projectInstructions').value.trim().slice(0, 4000);

  let p;
  if (currentProjectId) {
    p = projectById(currentProjectId);
    if (!p) return;
  } else {
    p = { id: crypto.randomUUID(), created: Date.now() };
    projects.unshift(p);
  }
  p.title = title;
  p.path = ppath;
  p.instructions = instructions;
  p.updated = Date.now();
  persistProjects();
  renderProjects();

  if (!currentProjectId) {
    // Режим создания: назад к списку
    closePage('pageProject');
    return;
  }
  label.textContent = title;
  input.hidden = true;
  document.getElementById('btnProjectRenameSave').hidden = true;
  document.getElementById('projectNameRow').hidden = false;
  const btn = document.getElementById('btnProjectSave');
  btn.textContent = 'Сохранено ✓';
  setTimeout(() => { btn.textContent = 'Сохранить'; }, 700);
}

function startRename() {
  const label = document.getElementById('projectNameLabel');
  const input = document.getElementById('projectNameInput');
  input.value = label.textContent;
  document.getElementById('projectNameRow').hidden = true;
  input.hidden = false;
  input.focus();
  document.getElementById('btnProjectRenameSave').hidden = false;
}

function commitRename() {
  const p = projectById(currentProjectId);
  if (!p) return;
  const title = document.getElementById('projectNameInput').value
    .trim().replace(/\s+/g, ' ').slice(0, 60) || 'Проект';
  p.title = title;
  p.updated = Date.now();
  persistProjects();
  renderProjects();
  document.getElementById('projectNameLabel').textContent = title;
  document.getElementById('projectNameInput').hidden = true;
  document.getElementById('btnProjectRenameSave').hidden = true;
  document.getElementById('projectNameRow').hidden = false;
}

function newChatInProject() {
  const p = projectById(currentProjectId);
  if (!p) return;
  const chat = {
    id: crypto.randomUUID(),
    title: 'Новый чат',
    created: Date.now(),
    updated: Date.now(),
    messages: [],
    projectId: p.id,
    personalization: personalizationSnapshot(),
  };
  chats.unshift(chat);
  currentChatId = chat.id;
  persistChats();
  closeAllPages();
  renderAll();
}

function disarmDelete() {
  deleteArmed = false;
  const btn = document.getElementById('btnProjectDelete');
  btn.textContent = 'Удалить проект';
  btn.classList.remove('armed');
}

function tryDeleteProject() {
  const btn = document.getElementById('btnProjectDelete');
  if (!deleteArmed) {
    deleteArmed = true;
    btn.textContent = 'Точно удалить?';
    btn.classList.add('armed');
    setTimeout(disarmDelete, 3000);
    return;
  }
  const id = currentProjectId;
  currentProjectId = null;
  projects = projects.filter(x => x.id !== id);
  persistProjects();
  // Чаты проекта развязываем, историю не трогаем: Recents живёт
  for (const c of chats) if (c.projectId === id) c.projectId = null;
  persistChats();
  closePage('pageProject');
  renderProjects();
  renderAll();
}

/* ── Мост: Firebase / мок ──────────────────────────────────────────── */

const isMock = () => new URLSearchParams(location.search).has('mock');
let bridge = null;           // {init, sendRequest, onResponse, onPresence, onState}
let settingsDropped = false; // запрос ушёл без settings (старые правила RTDB)

function firebaseConfig() {
  const cfg = window.__FIREBASE_CONFIG__;
  return cfg && cfg.apiKey && !cfg.apiKey.startsWith('PASTE_') ? cfg : null;
}

// Демо-мост: тот же интерфейс, что у Firebase-моста; пишет запросы в
// window.__mockDb (его проверяет e2e-тест) и через 600 мс отвечает эхом.
function createMockBridge() {
  const now = () => Math.floor(Date.now() / 1000);
  window.__mockDb = {
    bridge: {
      requests: {},
      responses: {},
      presence: { status: 'online', beat: now() },
      state: { stage: 'idle', status: 'idle', ts: now() },
      // e2e может подготовить облачные инструкции до загрузки страницы
      personalization: window.__mockPersonalization
        ? { ...window.__mockPersonalization } : null,
    },
  };
  let onResp = null, onPres = null, onState = null, onStream = null, onPers = null;
  return {
    mode: 'mock',
    async init() {
      onPres?.(window.__mockDb.bridge.presence);
      onState?.(window.__mockDb.bridge.state);
      onPers?.(window.__mockDb.bridge.personalization);
      return true;
    },
    onPersonalization(cb) {
      onPers = cb;
      cb?.(window.__mockDb.bridge.personalization);
    },
    async savePersonalization(data) {
      window.__mockDb.bridge.personalization = { ...data };
      onPers?.(window.__mockDb.bridge.personalization);
    },
    async sendRequest(text, initData, reqSettings) {
      const id = 'mock-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      window.__mockDb.bridge.requests[id] = { text, initData, ts: now(), settings: reqSettings };
      // Тестовый сценарий (e2e): одноразовый сбой ok:false — имитация
      // упавшего провайдера; опционально сначала отдаётся partial
      const failWith = window.__mockFailWith || null;
      window.__mockFailWith = null;
      if (failWith) {
        if (failWith.partial) {
          setTimeout(() => {
            window.__mockDb.bridge.responses[id] = { partial: failWith.partial, ts: now() };
            onStream?.(id, failWith.partial);
          }, failWith.partialDelay ?? 250);
        }
        setTimeout(() => {
          const response = { ok: false, text: failWith.text, ts: now() };
          window.__mockDb.bridge.responses[id] = response;
          onResp?.(id, response);
        }, failWith.delay ?? 900);
        return id;
      }
      // Имитация стриминга: два partial-а, затем финальный ответ
      setTimeout(() => {
        const partial = 'Демо-режим: печатаю ответ';
        window.__mockDb.bridge.responses[id] = { partial, ts: now() };
        onStream?.(id, partial);
      }, 250);
      setTimeout(() => {
        const partial = 'Демо-режим: печатаю ответ на «' + text + '»…';
        window.__mockDb.bridge.responses[id] = { partial, ts: now() };
        onStream?.(id, partial);
      }, 600);
      setTimeout(() => {
        // window.__mockResponseText (e2e): тест подменяет финальный текст
        // ответа, чтобы проверить разметку markdown в пузыре ассистента
        const response = {
          text: window.__mockResponseText ||
            'Демо-режим: запрос «' + text + '» дошёл до моста. ' +
            'Впишите apiKey в miniapp/firebase-config.js — ответы будет давать реальная модель.',
          ts: now(),
        };
        window.__mockResponseText = null;
        window.__mockDb.bridge.responses[id] = response;
        onResp?.(id, response);
      }, 2200);
      return id;
    },
    onResponse(cb) { onResp = cb; },
    onPartial(cb) { onStream = cb; },
    onPresence(cb) { onPres = cb; },
    onState(cb) { onState = cb; },
  };
}

/* ── Хендшейк владельца: custom-токен с claim owner ────────────────── */

// Сколько ждать токен от бота после handshake-запроса. Бот забирает запрос
// раз в 2 с, минт локальный — при живом боте токен приходит за 2-3 с.
const HANDSHAKE_WAIT_SEC = 10;

function bridgeError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// Ожидание токена в bridge/tokens/{uid}: onValue срабатывает и на текущее
// значение, поэтому окно между записью handshake-запроса и подпиской не
// теряет ответ. Протухший токен (exp в прошлом) игнорируется — бот был
// офлайн дольше срока жизни, дождёмся свежего или таймаута.
function waitOwnerToken(dbMod, db, uid) {
  return new Promise((resolve, reject) => {
    let unsub = null;
    const finish = (fn, arg) => {
      clearTimeout(timer);
      unsub?.();
      fn(arg);
    };
    const timer = setTimeout(() => {
      finish(reject, bridgeError('BRIDGE_HANDSHAKE_TIMEOUT',
        'токен не пришёл за ' + HANDSHAKE_WAIT_SEC + ' с'));
    }, HANDSHAKE_WAIT_SEC * 1000);
    unsub = dbMod.onValue(dbMod.ref(db, 'bridge/tokens/' + uid), snap => {
      const val = snap.val();
      if (!val || typeof val.token !== 'string' || !val.token) return;
      if (Number.isFinite(val.exp) && val.exp * 1000 < Date.now()) return;
      finish(resolve, val.token);
    }, err => finish(reject, err));
  });
}

// Обмен анонимной сессии на сессию с claim owner (FIREBASE_SETUP.md §8):
// handshake-запрос {uid, initData, ts} в bridge/handshake → бот проверяет
// подпись initData и публикует custom-токен в bridge/tokens/{uid} →
// signInWithCustomToken поднимает owner-claim у той же сессии (uid не меняется).
async function upgradeToOwnerSession(authMod, auth, dbMod, db, initData) {
  if (!initData) {
    throw bridgeError('BRIDGE_NO_INITDATA',
      'Mini App открыт вне Telegram: initData пуст');
  }
  const uid = auth.currentUser?.uid;
  if (!uid) {
    throw bridgeError('BRIDGE_NO_UID', 'анонимная сессия не установлена');
  }
  const hsRef = dbMod.push(dbMod.child(dbMod.ref(db), 'bridge/handshake'));
  try {
    await dbMod.set(hsRef, { uid, initData, ts: Math.floor(Date.now() / 1000) });
  } catch (e) {
    const denied = e?.code === 'PERMISSION_DENIED'
      || /permission/i.test(String(e?.message || ''));
    if (denied) {
      // Старые правила (§6.1 без узла handshake): запись запроса отклонена.
      // Окно раскатки — канал ещё работает анонимно, апгрейд недоступен.
      throw bridgeError('BRIDGE_RULES_OLD',
        'правила RTDB ещё без узла handshake: ' + (e?.message || e));
    }
    throw bridgeError('BRIDGE_HANDSHAKE_WRITE',
      'handshake не записан: ' + (e?.message || e));
  }
  const token = await waitOwnerToken(dbMod, db, uid);
  await authMod.signInWithCustomToken(auth, token);
}

// Человекочитаемое объяснение по коду ошибки хендшейка
function describeUpgradeError(e) {
  const code = e?.code || '';
  const msg = String(e?.message || e || '').slice(0, 200);
  if (code === 'BRIDGE_NO_INITDATA') {
    return {
      title: 'Канал владельца не подтверждён',
      detail: 'Mini App открыт вне Telegram: без подписи initData бот не '
        + 'выпускает токен доступа, а правила RTDB отдают ответы только '
        + 'владельцу. Открой приложение из чата с ботом.',
    };
  }
  if (code === 'BRIDGE_RULES_OLD') {
    return {
      title: 'Харденинг ещё не включён',
      detail: 'Правила RTDB отклонили handshake — опубликованы правила без '
        + 'узла bridge/handshake. Канал работает в анонимном режиме. '
        + 'Опубликуй правила §8 (scripts/apply_firebase_rules.py), чтобы '
        + 'закрыть ответы от посторонних.',
    };
  }
  if (code === 'BRIDGE_HANDSHAKE_TIMEOUT') {
    return {
      title: 'Токен владельца не пришёл',
      detail: 'Бот не выпустил токен доступа за ' + HANDSHAKE_WAIT_SEC
        + ' с: бот выключен, канал Mini App не поднят или подпись initData '
        + 'отклонена. Проверь бота (bridge.log) и переоткрой Mini App.',
    };
  }
  return {
    title: 'Канал владельца не подтверждён',
    detail: 'Хендшейк не удался: ' + msg + '. Переоткрой Mini App.',
  };
}

// Реальный мост: Firebase v9 modular, анонимная авторизация + хендшейк
// владельца (custom-токен с claim owner, FIREBASE_SETUP.md §8).
async function createFirebaseBridge(cfg) {
  const [appMod, authMod, dbMod] = await Promise.all([
    import('https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js'),
    import('https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js'),
  ]);
  const app = appMod.initializeApp(cfg);
  const auth = authMod.getAuth(app);
  const db = dbMod.getDatabase(app);
  await authMod.signInAnonymously(auth);

  // Апгрейд сессии до владельца. Провал не валит мост: подписки настраиваются
  // в init() в любом случае — при старых правилах анонимное чтение ещё
  // работает (окно раскатки), при новых ошибка чтения получит понятное
  // сообщение вместо тихого зависания.
  let upgradeError = null;
  try {
    await upgradeToOwnerSession(authMod, auth, dbMod, db, getInitData());
  } catch (e) {
    upgradeError = e;
    console.error('owner handshake:', e);
    const { title, detail } = describeUpgradeError(e);
    addMessage('error', title, detail);
  }

  let onResp = null, onPres = null, onState = null, onStream = null, onPers = null;
  let listenersOn = false;

  // bridge/responses/{id} = {text, ts, ok?} или {partial, ts} на время
  // генерации; ok:false — системный сбой (см. handleResponse).
  // child_added срабатывает на первом partial, child_changed — на его
  // обновлениях и на финальном text.
  const handleSnapshot = snap => {
    const val = snap.val() || {};
    if (typeof val.text === 'string') onResp?.(snap.key, val);
    else if (typeof val.partial === 'string') onStream?.(snap.key, val.partial);
  };

  // PERMISSION_DENIED при ужесточённых правилах: анонимная сессия (хендшейк
  // не прошёл или токен протух) видит отказ вместо тихого пустого узла.
  // Один пузырь на узел: responses слушают два обработчика (added/changed)
  const deniedShown = new Set();
  const deniedReader = path => e => {
    console.error('firebase ' + path + ':', e);
    if (deniedShown.has(path)) return;
    deniedShown.add(path);
    addMessage('error', 'Firebase: доступ запрещён',
      'Правила RTDB отклонили чтение ' + path + '. Переоткрой Mini App, '
      + 'чтобы получить токен владельца (FIREBASE_SETUP.md §8).');
  };

  const attachListeners = () => {
    if (listenersOn) return;
    listenersOn = true;
    dbMod.onChildAdded(dbMod.ref(db, 'bridge/responses'),
      handleSnapshot, deniedReader('bridge/responses'));
    dbMod.onChildChanged(dbMod.ref(db, 'bridge/responses'),
      handleSnapshot, deniedReader('bridge/responses'));
    dbMod.onValue(dbMod.ref(db, 'bridge/presence'),
      snap => onPres?.(snap.val()), deniedReader('bridge/presence'));
    dbMod.onValue(dbMod.ref(db, 'bridge/state'),
      snap => onState?.(snap.val()), deniedReader('bridge/state'));
  };

  return {
    mode: 'firebase',
    async init() {
      // Подписки здесь, а не до хендшейка: при ужесточённых правилах
      // анонимная сессия до токена получает только PERMISSION_DENIED, а
      // после апгрейда все чтения идут уже под owner-claim
      attachListeners();
      return true;
    },
    onPersonalization(cb) {
      onPers = cb;
      // Подписка и при неудачном хендшейке: в окне раскатки (старые правила)
      // анонимное чтение персонализации ещё работает; при ужесточённых
      // правилах сработает deniedReader с понятным сообщением
      dbMod.onValue(dbMod.ref(db, 'bridge/personalization'),
        snap => onPers?.(snap.val()),
        deniedReader('bridge/personalization'));
    },
    async savePersonalization(data) {
      await dbMod.set(dbMod.ref(db, 'bridge/personalization'), data);
    },
    async sendRequest(text, initData, reqSettings) {
      const r = dbMod.push(dbMod.child(dbMod.ref(db), 'bridge/requests'));
      const payload = { text, initData, ts: Math.floor(Date.now() / 1000), settings: reqSettings };
      try {
        await dbMod.set(r, payload);
      } catch (e) {
        const denied = e?.code === 'PERMISSION_DENIED' || /permission/i.test(String(e?.message || ''));
        if (!denied) throw e;
        // Старые правила без узла settings ($other:false) отвергают запись
        // целиком — ретраим по прежнему контракту {text, initData, ts}
        const { settings: _omit, ...minimal } = payload;
        await dbMod.set(r, minimal);
        settingsDropped = true;
      }
      return r.key;
    },
    onResponse(cb) { onResp = cb; },
    onPartial(cb) { onStream = cb; },
    onPresence(cb) { onPres = cb; },
    onState(cb) { onState = cb; },
  };
}

/* ── Отправка и приём ──────────────────────────────────────────────── */

async function sendMessage() {
  const input = document.getElementById('input');
  const text = input.value.trim();
  if (!text) return;
  if (!bridge) {
    addMessage('error', 'Модель не смогла ответить', 'Firebase не настроен: впишите apiKey в miniapp/firebase-config.js.');
    return;
  }

  const chat = currentChat();
  const attach = state.attachment;
  const fullText = attach ? '[Вложение: ' + attach + ']\n\n' + text : text;

  input.value = '';
  autoResize();
  updateSendButton();
  clearAttachment();

  addMessage('user', fullText);
  touchChat(chat, fullText);
  persistChats();
  renderRecents();

  const msg = { text: fullText, initData: getInitData(), settings: requestSettings() };
  try {
    const requestId = await bridge.sendRequest(msg.text, msg.initData, msg.settings);
    if (settingsDropped) {
      settingsDropped = false;
      addMessage('error', 'Настройки не приняты базой',
        'Запрос отправлен без settings — обновите правила RTDB (FIREBASE_SETUP.md §6).');
    }
    pending.set(requestId, {
      chatId: chat.id,
      timer: setTimeout(() => {
        if (pending.delete(requestId)) {
          // Как пути stub/ok:false: пузырь-превью снимаем вместе со
          // стрим-состоянием (иначе он навсегда «печатает», флаг streaming
          // персистится и переживает перезагрузку). Поздний ответ после
          // таймаута игнорируется: handleResponse/Partial видят !p и выходят.
          dropStreamBubble(requestId);
          addMessage('error', 'Модель не смогла ответить',
            'Ответ не пришёл за 10 минут — запрос просрочен или бот офлайн.',
            chat.id);
          updateTyping();
        }
      }, REQUEST_TIMEOUT_SEC * 1000),
    });
    updateTyping();
  } catch (e) {
    console.error('sendRequest:', e);
    addMessage('error', 'Модель не смогла ответить', 'Не удалось записать запрос в Firebase: ' + (e?.message || e));
  }
}

function handlePartial(requestId, partialText) {
  const p = pending.get(requestId);
  if (!p) return;                       // финал уже пришёл или чужой id
  const chat = chats.find(c => c.id === p.chatId);
  if (!chat) return;
  let s = streams.get(requestId);
  if (!s) {
    const msg = { role: 'assistant', text: partialText, ts: Date.now(), streaming: true };
    chat.messages.push(msg);
    s = { chatId: chat.id, msg, el: null };
    streams.set(requestId, s);
    if (chat.id === currentChatId) {
      hideEmpty();
      s.el = appendMessage(msg);
      scrollFeed(false);
    }
  } else {
    s.msg.text = partialText;
    if (chat.id === currentChatId) {
      if (s.el && s.el.isConnected) updateStreamBubble(s.el, s.msg, true);
      else renderMessages();
      scrollFeed(false);
    }
  }
  updateTyping();
}

// Убирает пузырь-превью стрима: финал оказался заглушкой или сбоем
// провайдера, а не ответом модели (иначе «печатающийся» текст завис бы в ленте)
function dropStreamBubble(requestId) {
  const s = streams.get(requestId);
  if (!s) return;
  const chat = chats.find(c => c.id === s.chatId);
  if (chat) {
    const index = chat.messages.indexOf(s.msg);
    if (index >= 0) chat.messages.splice(index, 1);
    persistChats();
  }
  if (s.el) s.el.remove();
  streams.delete(requestId);
}

function handleResponse(requestId, data) {
  const p = pending.get(requestId);
  if (!p) return;                       // чужой или уже полученный ответ
  pending.delete(requestId);
  clearTimeout(p.timer);
  const text = String(data?.text ?? '');
  const stub = ERROR_STUBS.some(prefix => text.startsWith(prefix));
  const s = streams.get(requestId);

  if (stub) {
    // Частичный ответ оказался заглушкой: убираем пузырь-превью
    dropStreamBubble(requestId);
    addMessage('error', 'Модель не смогла ответить', text, p.chatId);
    updateTyping();
    return;
  }

  // Системный сбой: провайдер упал или лимиты исчерпаны. Бот помечает
  // такой ответ флагом ok:false; старый бот (до перезапуска) — только
  // текстом «Ошибка выполнения, код N» (llm/base.py). Вместо сырого
  // кода ошибки — понятная причина; превью стрима убираем, а индикатор
  // «Печатает…» гасит updateTyping() (pending уже пуст).
  if (data?.ok === false || text.startsWith('Ошибка выполнения')) {
    dropStreamBubble(requestId);
    const title = LIMITS_RE.test(text) ? LIMITS_ERROR_TITLE : PROVIDER_ERROR_TITLE;
    addMessage('error', title, text.slice(0, 300) || 'Подробности в bridge.log', p.chatId);
    updateTyping();
    return;
  }

  if (s) {
    // Ответ доехал целиком: тот же пузырь становится финальным — второго нет
    s.msg.text = text;
    s.msg.streaming = false;
    const chat = chats.find(c => c.id === s.chatId);
    if (chat) {
      chat.updated = Date.now();
      persistChats();
    }
    if (s.chatId === currentChatId && s.el && s.el.isConnected) {
      updateStreamBubble(s.el, s.msg, false);
      scrollFeed(true);
    } else if (s.chatId === currentChatId) {
      renderMessages();
    }
    streams.delete(requestId);
    updateTyping();
    return;
  }

  addMessage('assistant', text, undefined, p.chatId);
  updateTyping();
}

/* ── Рендер ленты ──────────────────────────────────────────────────── */

const state = { attachment: null };

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

// Дата в разделителе «Персонализация обновлена»: «30.10.2026, 14:05»
function fmtPersDividerDate(ts) {
  return new Date(ts).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function addMessage(role, text, detail, chatId) {
  const chat = chats.find(c => c.id === (chatId || currentChatId));
  if (!chat) return;
  const msg = { role, text, ts: Date.now() };
  if (detail) msg.detail = detail;
  chat.messages.push(msg);
  chat.updated = Date.now();
  persistChats();
  if (chat.id === currentChatId) {
    hideEmpty();
    appendMessage(msg);
    scrollFeed(true);
  }
}

/* ── Markdown ─────────────────────────────────────────────────────────── */
// Ответы моделей приходят с разметкой (**жирный**, `код`, ```блоки```).
// Парсим marked → санитизируем DOMPurify → innerHTML в контейнере .md.
// Если CDN недоступен (marked/DOMPurify не загрузились) — тихий fallback
// на plain text: UI не ломается, звёздочки остаются как в тексте.

const markdownReady = () =>
  typeof window.marked !== 'undefined' &&
  typeof window.DOMPurify !== 'undefined';

function renderMarkdown(container, text) {
  let html = null;
  if (markdownReady()) {
    try {
      html = window.DOMPurify.sanitize(
        window.marked.parse(text, { breaks: true, gfm: true }));
    } catch (e) { html = null; }
  }
  container.classList.toggle('plain', html === null);
  if (html === null) container.textContent = text;
  else container.innerHTML = html;
}

function bubbleFor(msg) {
  const div = document.createElement('div');
  div.className = 'msg msg-' + msg.role;
  const b = document.createElement('div');
  b.className = 'bubble';
  if (msg.streaming) b.classList.add('streaming');
  if (msg.role === 'assistant') {
    const md = document.createElement('div');
    md.className = 'md';
    renderMarkdown(md, msg.text);
    b.appendChild(md);
  } else if (msg.role === 'error') {
    // Извлекаем message из JSON-ошибок, иначе берём текст как есть.
    const header = msg.text;
    let detailText = msg.detail || header;
    try {
      const parsed = JSON.parse(detailText);
      if (parsed.message) detailText = parsed.message;
    } catch (_) { /* plain text */ }
    // Заголовок
    const ht = document.createElement('b');
    ht.textContent = header;
    b.appendChild(ht);
    // Детали — как markdown-пузырь
    const md = document.createElement('div');
    md.className = 'md';
    renderMarkdown(md, detailText);
    b.appendChild(md);
  } else {
    b.textContent = msg.text;
  }
  const time = document.createElement('span');
  time.className = 'msg-time';
  time.textContent = fmtTime(msg.ts) + (msg.stopped ? ' · остановлено' : '');
  b.appendChild(time);
  div.appendChild(b);
  return div;
}

// Разделитель «Персонализация обновлена <дата>»: граница — updatedAt
// снимка персонализации чата. Вычисляется на лету при рендере,
// в сообщениях не хранится.
function persDivider(boundary) {
  const div = document.createElement('div');
  div.className = 'feed-pers-divider';
  div.setAttribute('role', 'separator');
  div.textContent = 'Персонализация обновлена ' + fmtPersDividerDate(boundary);
  return div;
}

function appendMessage(msg) {
  const feed = document.getElementById('feed');
  const typing = document.getElementById('typing');
  // Первое сообщение, написанное уже по новым правилам, помечаем
  // разделителем. Только если в чате есть более ранние сообщения —
  // иначе он бы оказался в самом верху свежего чата. Если разделитель
  // уже в ленте (например, после переключения чата) — второй не добавляем.
  const chat = currentChat();
  const boundary = chat?.personalization?.updatedAt || 0;
  if (chat && msg.ts >= boundary && !feed.querySelector('.feed-pers-divider')
      && chat.messages.some(m => m.ts < boundary)) {
    feed.insertBefore(persDivider(boundary), typing);
  }
  const el = bubbleFor(msg);
  feed.insertBefore(el, typing);
  return el;
}

function updateStreamBubble(el, msg, streaming) {
  const b = el.querySelector('.bubble');
  if (!b) return;
  const md = b.querySelector('.md');
  if (md) {
    renderMarkdown(md, msg.text);
  } else if (b.firstChild && b.firstChild.nodeType === Node.TEXT_NODE) {
    b.firstChild.nodeValue = msg.text;
  } else {
    b.insertBefore(document.createTextNode(msg.text), b.firstChild);
  }
  b.classList.toggle('streaming', !!streaming);
}

function renderMessages() {
  const feed = document.getElementById('feed');
  // Разделители персонализации чистим вместе с пузырями: рендер stateless
  feed.querySelectorAll('.msg, .feed-pers-divider').forEach(n => n.remove());
  const chat = currentChat();
  if (!chat || chat.messages.length === 0) { showEmpty(); return; }
  hideEmpty();
  const typing = document.getElementById('typing');
  // Разделитель перед первым сообщением, написанным уже после обновления
  // персонализации, но только если есть более ранние сообщения — иначе он
  // бы оказался в самом верху нового чата.
  const boundary = chat.personalization?.updatedAt || 0;
  const hasOlder = chat.messages.some(m => m.ts < boundary);
  let dividerDone = false;
  chat.messages.forEach(m => {
    if (!dividerDone && hasOlder && m.ts >= boundary) {
      feed.insertBefore(persDivider(boundary), typing);
      dividerDone = true;
    }
    feed.insertBefore(bubbleFor(m), typing);
  });
  scrollFeed(false);
}

function showEmpty() { document.getElementById('emptyState').hidden = false; }
function hideEmpty() { document.getElementById('emptyState').hidden = true; }

function scrollFeed(smooth) {
  const feed = document.getElementById('feed');
  feed.scrollTo({ top: feed.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

/* ── Индикатор набора ──────────────────────────────────────────────── */

let botStage = 'idle';

function updateTyping() {
  const typing = document.getElementById('typing');
  // Пока идёт стрим, индикатор «печатает» лишний: текст уже виден в пузыре
  const waiting = [...pending.keys()].some(id => !streams.has(id));
  typing.hidden = !waiting;
  if (waiting) {
    // В пузыре — только анимированный логотип; текст здесь служит
    // подписью для скринридера (role="status" на #typing).
    document.getElementById('typingText').textContent =
      botStage === 'bridge' ? 'Готовим запрос…' : 'Агент обрабатывает запрос…';
    scrollFeed(true);
  }
  updateSendButton();
}

/* ── Статус бота (presence) ────────────────────────────────────────── */

function renderPresence(p) {
  const el = document.getElementById('botStatus');
  const label = document.getElementById('botStatusText');
  let online = false, text = 'нет связи';
  if (isMock()) { online = true; text = 'демо'; }
  else if (p && p.beat) {
    const fresh = Math.floor(Date.now() / 1000) - p.beat < 30;
    online = fresh && p.status === 'online';
    text = online ? 'онлайн' : 'офлайн';
  }
  el.classList.toggle('offline', !online && text !== 'нет связи');
  el.classList.toggle('nolink', text === 'нет связи');
  label.textContent = text;
}

/* ── Drawer ────────────────────────────────────────────────────────── */

function openDrawer() {
  const d = document.getElementById('drawer');
  const o = document.getElementById('drawerOverlay');
  o.hidden = false;
  requestAnimationFrame(() => { o.classList.add('shown'); d.classList.add('open'); });
  d.setAttribute('aria-hidden', 'false');
  renderRecents();
}

function closeDrawer() {
  const d = document.getElementById('drawer');
  const o = document.getElementById('drawerOverlay');
  o.classList.remove('shown');
  d.classList.remove('open');
  d.setAttribute('aria-hidden', 'true');
  setTimeout(() => { o.hidden = true; }, 300);
}

function renderRecents() {
  const ul = document.getElementById('recentsList');
  ul.innerHTML = '';
  const list = [...chats].sort((a, b) => b.updated - a.updated).slice(0, 15);
  if (!list.length) {
    ul.innerHTML = '<li class="recents-empty">Пока нет чатов</li>';
    return;
  }
  for (const c of list) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'recent-item' + (c.id === currentChatId ? ' current' : '');
    btn.innerHTML = '<span class="r-icon"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z"/></svg></span>';
    const body = document.createElement('span');
    body.className = 'r-body';
    const t = document.createElement('span'); t.className = 'r-title'; t.textContent = c.title;
    const meta = document.createElement('span'); meta.className = 'r-meta';
    // Точка-индикатор: правила персонализации обновлены после создания чата,
    // а сообщения по ним чат ещё не отправлял — применятся со следующего.
    const u = (c.personalization && c.personalization.updatedAt) || 0;
    const stale = u > c.created && !(c.messages || []).some(m => m.ts >= u);
    if (stale) {
      const dot = document.createElement('i');
      dot.className = 'r-pers-dot';
      dot.title = 'Правила персонализации обновлены — применятся со следующего сообщения';
      meta.appendChild(dot);
    }
    const proj = c.projectId ? projectById(c.projectId) : null;
    if (proj) {
      const pb = document.createElement('span');
      pb.className = 'r-project';
      pb.textContent = proj.title;
      pb.title = proj.title;
      meta.appendChild(pb);
    }
    const tm = document.createElement('span'); tm.className = 'r-time'; tm.textContent = fmtRecentTime(c.updated);
    meta.appendChild(tm);
    body.append(t, meta);
    btn.appendChild(body);
    btn.addEventListener('click', () => switchChat(c.id));
    li.appendChild(btn);
    ul.appendChild(li);
  }
}

function fmtRecentTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60e3) return 'сейчас';
  if (diff < 3600e3) return Math.floor(diff / 60e3) + ' мин';
  if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' ч';
  if (diff < 172800e3) return 'вчера';
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

/* ── BottomSheet ───────────────────────────────────────────────────── */

let openedSheet = null;

function openSheet(id) {
  closeDropdowns();
  const overlay = document.getElementById('sheetOverlay');
  const sheet = document.getElementById(id);
  overlay.hidden = false;
  sheet.hidden = false;
  requestAnimationFrame(() => { overlay.classList.add('shown'); sheet.classList.add('open'); });
  openedSheet = id;
}

function closeSheet() {
  if (!openedSheet) return;
  const overlay = document.getElementById('sheetOverlay');
  const sheet = document.getElementById(openedSheet);
  overlay.classList.remove('shown');
  sheet.classList.remove('open');
  openedSheet = null;
  setTimeout(() => { overlay.hidden = true; sheet.hidden = true; }, 320);
}

/* ── Настройки: форма ──────────────────────────────────────────────── */

function fillSettingsForm() {
  document.getElementById('setContext').value = settings.context;
  document.getElementById('contextValue').textContent = settings.context;
  document.getElementById('setTemperature').value = settings.temperature;
  document.getElementById('temperatureValue').textContent = Number(settings.temperature).toFixed(2).replace(/0$/, '');
  document.getElementById('setShiftEnter').checked = settings.shiftEnter;
}

function applySettingsForm() {
  settings.context = Number(document.getElementById('setContext').value);
  settings.temperature = Number(document.getElementById('setTemperature').value);
  settings.shiftEnter = document.getElementById('setShiftEnter').checked;
  saveSettings();
}

/* ── Персонализация: форма ─────────────────────────────────────────── */

function setCharCount(input, output) {
  const n = input.value.length;
  output.textContent = n + '/' + GLOBAL_RULES_LIMIT;
  output.classList.toggle('at-limit', n >= GLOBAL_RULES_LIMIT);
}

function setPersonalizationStatus(text, isError = false) {
  const el = document.getElementById('persSaveStatus');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('error', !!isError);
}

function fillPersonalizationForm() {
  const about = document.getElementById('persAbout');
  const style = document.getElementById('persStyle');
  about.value = globalRules.about;
  style.value = globalRules.style;
  document.getElementById('persEnabled').checked = globalRules.enabled;
  setCharCount(about, document.getElementById('persAboutCount'));
  setCharCount(style, document.getElementById('persStyleCount'));
}

async function applyPersonalizationForm() {
  globalRules = {
    about: document.getElementById('persAbout').value.trim().slice(0, GLOBAL_RULES_LIMIT),
    style: document.getElementById('persStyle').value.trim().slice(0, GLOBAL_RULES_LIMIT),
    enabled: document.getElementById('persEnabled').checked,
    updatedAt: Date.now(),
  };
  saveGlobalRules();
  // Ретроактивность: правила применяются и к уже созданным чатам. Если
  // снимки обновились, перерисовываем ленту — граница разделителя
  // «Персонализация обновлена» в текущем чате сместилась.
  const applied = syncChatsPersonalization();
  if (applied) renderMessages();
  setPersonalizationStatus('Сохраняю…');
  const synced = await pushPersonalizationToCloud();
  setPersonalizationStatus(synced
    ? 'Сохранено. Чаты применят правила со следующего сообщения.'
    : 'Сохранено на устройстве. Облако недоступно: проверьте правила RTDB.',
  !synced);
  return synced;
}

// Ретроактивное применение правил: снимок каждого чата с устаревшим
// updatedAt (меньше только что сохранённых правил) заменяется свежим,
// и со следующего сообщения чат собирает промпт по новым правилам.
// Обновляем только personalization: chat.updated, chat.created и messages
// не трогаем, чтобы не пересортировать Recents. Чаты без снимка (битые
// данные) пропускаем. Возвращает число обновлённых чатов.
function syncChatsPersonalization() {
  const boundary = globalRules.updatedAt;
  let n = 0;
  for (const chat of chats) {
    const cur = chat.personalization;
    if (cur && Number.isFinite(cur.updatedAt) && cur.updatedAt < boundary) {
      chat.personalization = personalizationSnapshot();
      n++;
    }
  }
  if (n) persistChats();
  return n;
}

/* ── Модели ────────────────────────────────────────────────────────── */

function renderModels() {
  const ul = document.getElementById('modelList');
  ul.innerHTML = '';
  for (const m of MODELS) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'model-item' + (settings.model === m.id ? ' selected' : '');
    btn.innerHTML = '<span class="m-radio"></span>';
    const body = document.createElement('span');
    body.className = 'm-body';
    const n = document.createElement('div'); n.className = 'm-name'; n.textContent = m.full;
    const s = document.createElement('div'); s.className = 'm-sub'; s.textContent = m.sub;
    body.append(n, s);
    btn.appendChild(body);
    btn.addEventListener('click', () => {
      settings.model = m.id;
      saveSettings();
      renderModelChip();
      closeSheet();
    });
    li.appendChild(btn);
    ul.appendChild(li);
  }
}

function renderModelChip() {
  const m = MODELS.find(x => x.id === settings.model) || MODELS[0];
  document.getElementById('modelName').textContent = m.name;
  const inSettings = document.getElementById('settingsModelName');
  if (inSettings) inSettings.textContent = m.name;
}

/* ── Выпадающие меню ───────────────────────────────────────────────── */

function toggleDropdown(id) {
  const dd = document.getElementById(id);
  const show = !dd.classList.contains('shown');
  closeDropdowns();
  if (show) {
    dd.hidden = false;
    requestAnimationFrame(() => dd.classList.add('shown'));
  }
}

function closeDropdowns() {
  document.querySelectorAll('.dropdown.shown').forEach(dd => {
    dd.classList.remove('shown');
    setTimeout(() => { dd.hidden = true; }, 160);
  });
}

/* ── Вложения ──────────────────────────────────────────────────────── */

function setAttachment(name) {
  state.attachment = name;
  document.getElementById('attachName').textContent = name;
  document.getElementById('attachChip').hidden = false;
}

function clearAttachment() {
  state.attachment = null;
  document.getElementById('fileInput').value = '';
  document.getElementById('attachChip').hidden = true;
}

/* ── Экспорт в .md ─────────────────────────────────────────────────── */

function exportChat() {
  const chat = currentChat();
  if (!chat || !chat.messages.length) return;
  const lines = ['# ' + chat.title, '', '> Экспорт из Claude Bridge · ' + new Date().toLocaleString('ru-RU'), ''];
  for (const m of chat.messages) {
    const who = m.role === 'user' ? '**Вы**' : m.role === 'assistant' ? '**Агент**' : '**⚠️ Ошибка**';
    lines.push(who + ' · ' + fmtTime(m.ts), '', m.detail ? m.text + '\n\n' + m.detail : m.text, '');
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'claude-bridge-' + new Date().toISOString().slice(0, 10) + '.md';
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ── Пользователь ──────────────────────────────────────────────────── */

function renderUser() {
  const displayName = tgUser
    ? ([tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ') || 'Владелец')
    : 'Владелец';
  const handle = tgUser && tgUser.username ? '@' + tgUser.username : '';
  const initial = tgUser && tgUser.first_name ? tgUser.first_name[0].toUpperCase() : 'В';
  for (const ids of [
    { avatar: 'userAvatar', name: 'userName', handle: 'userHandle' },
    { avatar: 'settingsAvatar', name: 'settingsName', handle: 'settingsHandle' },
  ]) {
    const avatar = document.getElementById(ids.avatar);
    const name = document.getElementById(ids.name);
    const handleEl = document.getElementById(ids.handle);
    if (!avatar || !name) continue;
    name.textContent = displayName;
    if (handleEl) {
      handleEl.textContent = handle;
      handleEl.hidden = !handle;
    }
    avatar.textContent = initial;
    if (tgUser && tgUser.photo_url) {
      const img = document.createElement('img');
      img.src = tgUser.photo_url;
      img.alt = '';
      avatar.textContent = '';
      avatar.appendChild(img);
    }
  }
}

/* ── Композер ──────────────────────────────────────────────────────── */

function autoResize() {
  const input = document.getElementById('input');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
}

const pendingIdsForChat = (chatId = currentChatId) =>
  [...pending.keys()].filter(id => pending.get(id).chatId === chatId);

// Пока текущий чат ждёт ответа, «Отправить» уступает место «Стоп»:
// второй запрос из одного чата в очередь не ставим (у бота это гонка
// за один и тот же контекст).
function updateSendButton() {
  const send = document.getElementById('btnSend');
  const stop = document.getElementById('btnStop');
  const waiting = pendingIdsForChat().length > 0;
  send.hidden = waiting;
  stop.hidden = !waiting;
  send.disabled = !document.getElementById('input').value.trim();
}

// Отмена — локальная: у моста нет канала отмены, бот доработает запрос
// и запишет ответ, но pending уже пуст, поэтому handleResponse/Partial
// его проигнорируют. Уже полученный partial остаётся в ленте с пометкой.
function stopPending() {
  let canceled = false;
  for (const id of pendingIdsForChat()) {
    clearTimeout(pending.get(id).timer);
    pending.delete(id);
    canceled = true;
    const s = streams.get(id);
    if (!s) continue;
    streams.delete(id);
    s.msg.streaming = false;
    if (String(s.msg.text || '').trim()) {
      s.msg.stopped = true;
    } else {
      const chat = chats.find(c => c.id === s.chatId);
      const i = chat ? chat.messages.indexOf(s.msg) : -1;
      if (i >= 0) chat.messages.splice(i, 1);
    }
  }
  if (!canceled) return;
  persistChats();
  updateTyping();
  renderMessages();
  updateSendButton();
}

/* ── Навешивание событий ───────────────────────────────────────────── */

function wireEvents() {
  document.getElementById('btnMenu').addEventListener('click', openDrawer);
  document.getElementById('drawerOverlay').addEventListener('click', closeDrawer);
  document.getElementById('btnNewChat').addEventListener('click', () => { newChat(); closeDrawer(); });
  document.getElementById('btnProfile').addEventListener('click', () => {
    closeDrawer();
    // Drawer уезжает 300 мс: страница выезжает после него
    setTimeout(openSettingsPage, 180);
  });

  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const nav = btn.dataset.nav;
      closeDrawer();
      if (nav === 'projects') {
        renderProjects();
        openPage('pageProjects');
      } else if (nav === 'library') {
        openPage('pageLibrary');
      } else {
        // chats — основной экран: закрываем все страницы
        closeAllPages();
        renderMessages();
      }
    });
  });

  // Страницы: кнопка «назад»
  document.querySelectorAll('[data-back]').forEach(btn =>
    btn.addEventListener('click', () => pageBack(btn.dataset.back)));

  // Проекты
  document.getElementById('btnNewProject').addEventListener('click', () => openProjectEditor(null));
  document.getElementById('btnProjectSave').addEventListener('click', saveProject);
  document.getElementById('btnProjectRename').addEventListener('click', startRename);
  document.getElementById('btnProjectRenameSave').addEventListener('click', commitRename);
  document.getElementById('projectNameInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); commitRename(); }
  });
  document.getElementById('btnProjectNewChat').addEventListener('click', newChatInProject);
  document.getElementById('btnProjectDelete').addEventListener('click', tryDeleteProject);

  // Персонализация: отдельный экран поверх настроек
  document.getElementById('btnOpenPersonalization').addEventListener('click', () => {
    setPersonalizationStatus('Правила действуют для всех чатов.');
    fillPersonalizationForm();
    openPage('pagePersonalization');
  });
  document.getElementById('btnSavePersonalization').addEventListener('click', async () => {
    const btn = document.getElementById('btnSavePersonalization');
    btn.disabled = true;
    await applyPersonalizationForm();
    fillPersonalizationForm();
    btn.textContent = 'Сохранено ✓';
    setTimeout(() => { btn.textContent = 'Сохранить'; btn.disabled = false; }, 1200);
  });
  for (const [inputId, countId] of [['persAbout', 'persAboutCount'],
                                    ['persStyle', 'persStyleCount']]) {
    const input = document.getElementById(inputId);
    input.addEventListener('input', () => {
      if (input.value.length > GLOBAL_RULES_LIMIT) {
        input.value = input.value.slice(0, GLOBAL_RULES_LIMIT);
      }
      setCharCount(input, document.getElementById(countId));
    });
  }

  document.getElementById('btnPlus').addEventListener('click', e => {
    e.stopPropagation();
    toggleDropdown('plusMenu');
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('.dropdown')) closeDropdowns();
  });

  document.getElementById('plusMenu').addEventListener('click', e => {
    const action = e.target.closest('.dropdown-item')?.dataset.action;
    if (!action) return;
    closeDropdowns();
    const fi = document.getElementById('fileInput');
    fi.accept = action === 'attach-photo' ? 'image/*,video/*' : '';
    fi.click();
  });

  document.getElementById('fileInput').addEventListener('change', e => {
    const f = e.target.files?.[0];
    if (f) setAttachment(f.name);
  });
  document.getElementById('attachRemove').addEventListener('click', clearAttachment);

  document.querySelectorAll('.sheet-close').forEach(btn =>
    btn.addEventListener('click', closeSheet));
  document.getElementById('sheetOverlay').addEventListener('click', closeSheet);

  const input = document.getElementById('input');
  input.addEventListener('input', () => { autoResize(); updateSendButton(); });
  input.addEventListener('keydown', e => {
    const shift = e.shiftKey;
    const enter = e.key === 'Enter' && !e.isComposing;
    if (!enter) return;
    const send = settings.shiftEnter ? shift : !shift;
    if (send) { e.preventDefault(); sendMessage(); }
  });

  document.getElementById('btnSend').addEventListener('click', sendMessage);
  document.getElementById('btnStop').addEventListener('click', stopPending);
  document.getElementById('btnModel').addEventListener('click', () => { renderModels(); openSheet('sheetModel'); });
  document.getElementById('btnOpenModel').addEventListener('click', () => { renderModels(); openSheet('sheetModel'); });
  document.getElementById('btnExportChat').addEventListener('click', exportChat);
  document.getElementById('btnOpenLimits').addEventListener('click', () => openSheet('sheetLimits'));

  document.getElementById('btnSaveSettings').addEventListener('click', () => {
    applySettingsForm();
    const btn = document.getElementById('btnSaveSettings');
    btn.textContent = 'Сохранено ✓';
    setTimeout(() => { btn.textContent = 'Сохранить'; }, 1200);
  });

  document.getElementById('setContext').addEventListener('input', e =>
    document.getElementById('contextValue').textContent = e.target.value);
  document.getElementById('setTemperature').addEventListener('input', e =>
    document.getElementById('temperatureValue').textContent = Number(e.target.value).toFixed(2).replace(/0$/, ''));
}

/* ── Рендер всего ──────────────────────────────────────────────────── */

// Под шапкой — «Проект: <название>», если текущий чат привязан к проекту.
// Бренд «Claude Bridge» остаётся заголовком: подпись лишь добавляет контекст.
function renderTopbarName() {
  const chat = currentChat();
  const p = chat && chat.projectId ? projectById(chat.projectId) : null;
  const label = document.getElementById('topbarProject');
  const sep = document.getElementById('topbarProjectSep');
  label.hidden = !p;
  sep.hidden = !p;
  label.textContent = p ? 'Проект: ' + p.title : '';
  label.title = p ? p.title : '';
}

function renderAll() {
  renderMessages();
  renderRecents();
  renderModelChip();
  renderTopbarName();
  updateSendButton();
}

/* ── Старт ─────────────────────────────────────────────────────────── */

async function boot() {
  initTelegram();
  loadSettings();
  loadGlobalRules();
  loadChats();
  loadProjects();
  migrateChatsToPersonalization();
  wireEvents();
  fillSettingsForm();
  renderUser();
  renderAll();

  // Мост: мок (?mock=1) → реальный Firebase (если вписан apiKey) → ошибка
  if (isMock()) {
    bridge = createMockBridge();
  } else {
    const cfg = firebaseConfig();
    if (cfg) {
      try {
        bridge = await createFirebaseBridge(cfg);
      } catch (e) {
        console.error('Firebase init:', e);
        addMessage('error', 'Модель не смогла ответить', 'Firebase недоступен: ' + (e?.message || e));
      }
    }
  }

  if (bridge) {
    bridge.onResponse(handleResponse);
    bridge.onPartial(handlePartial);
    bridge.onPresence(renderPresence);
    bridge.onState(s => {
      botStage = s?.stage || 'idle';
      updateTyping();
    });
    await bridge.init();
    bridge.onPersonalization?.(applyPersonalizationFromCloud);
  }
  renderPresence(bridge ? { status: 'online', beat: Math.floor(Date.now() / 1000) } : null);
  document.getElementById('input').focus();
}

// Экспорт для E2E-тестов (перерисовка после restore localStorage).
window.renderAll = renderAll;
window.renderProjects = renderProjects;
window.loadProjects = loadProjects;
window.loadChats = loadChats;

boot();
