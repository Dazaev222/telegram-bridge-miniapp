/* ═══════════════════════════════════════════════════════════════════
   Claude Bridge Mini App — логика (Telegram WebApp + Firebase RTDB)

   Контракт с ботом (облако/broker.py, менять только вместе с ним):
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

   settings — вложенный объект {model, temperature, context, max_tokens,
   reasoning_effort, system_prompt?, global_system_prompt?, project_path?}.
   reasoning_effort — уровень размышлений: строго low|medium|high, дефолт
   'medium' (те же значения принимает бэкенд — ядро/settings_validator.py,
   и правила RTDB FIREBASE_SETUP.md §6.1; «xhigh» интерфейс не предлагает).
   project_path
   (Проекты) задаёт рабочую папку запроса — бот проверяет её в
   модели/router.validate_cwd до запуска CLI; system_prompt — префикс промпта
   (инструкции проекта при привязанном чате); global_system_prompt —
   снимок инструкций персонализации чата (снимается при создании и
   ретроактивно обновляется при сохранении правил, syncChatsPersonalization).
   Бот ставит его перед проектными (модели/router.build_prompt): новые
   инструкции чаты подхватывают со следующего сообщения. max_tokens —
   лимит длины ответа (слайдер 100..4000, шаг 100, дефолт 1000); бот
   клэмпит его в ядро/settings_validator и передаёт провайдеру, который
   умеет его ограничить (qoder: --max-output-tokens), остальные молча
   отмечают «не поддерживается» в bridge.log.

   bridge/personalization = {about, style, enabled, updatedAt} — глобальные
   инструкции владельца, общие для всех чатов (пишет сессия с owner-claim).
   §6.2: запись в bridge/requests — только сессия с claim owner и только
   как create (!data.exists()). sendRequest не PUT-ит в очередь до
   успешного upgradeToOwnerSession: без owner — честный статус «Жду
   подтверждение владельца (handshake)» и повтор хендшейка; фолдбек
   «писать без owner» убран. initData остаётся в payload: бот валидирует
   подпись независимо от правил.

   Демо-режим (?mock=1) подменяет Firebase локальным эхо — для e2e-тестов
   без реального проекта Firebase. Test-only ручки демо-режима (в проде нет
   ни мока, ни их): window.__voiceTest, window.__mockFailWith,
   window.__mockWriteFail (отказ записи запроса: {} — режет всё,
   {settingsOnly:true} — только запросы с settings).
     __mockEarlyFrame = текст финала — partial и финал уходят ДО
     подтверждения записи: имитация гонки G1, её ловит e2e шаг 65.
     __pendingCount() = число живых заявок: module-область из evaluate не видна,
     шаги 64-66 сверяют снятие заявки только через неё.

   Голосовой ввод Mini App — то же поле bridge/requests/{id}, одно новое поле:
     voice = {oggB64: <base64 контейнера Ogg/Opus>, durationSec: <сек>}
   text при этом остаётся строкой и равен "" (не null и не отсутствие поля):
   бот считает пустой text валидным только в паре с voice. Клиентские лимиты
   срезаются ДО отправки: 120 с и 2.6 МБ после base64 — это потолок одной
   записи RTDB, 20 МБ из бот/voice.py сюда не применим. Ответ приходит по
   существующему bridge/responses — отдельной обработки голоса на ответ нет.
   Test-only хук демо-режима: window.__voiceTest (путь «запись → отправка →
   ответ» без реального микрофона; продакшн-ветку не трогает).
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
// (голосовые заглушки вроде «Не удалось обработать голосовое» попадают сюда
// же через «Не удалось» — отдельного префикса не просим)
const ERROR_STUBS = [
  'Запрос отклонён', 'Запрос просрочен', 'Пустой запрос',
  'Команды из Mini App', 'Не удалось', 'Внутренняя ошибка',
];

// Системные ошибки провайдера: бот помечает ответ флагом ok:false (бот
// свежий) либо текст начинается с «Ошибка выполнения» (модели/base.py, бот
// ещё не перезапущен). Вместо сырого «код 1» — человекочитаемая причина.
const PROVIDER_ERROR_TITLE = 'Провайдер временно недоступен. Переключаюсь...';
const LIMITS_ERROR_TITLE = 'Лимиты модели исчерпаны. Выберите другую';
const LIMITS_RE = /лимит|429|rate[\s_-]?limit|quota|too many requests/i;

// Список Mini App: бесплатные (GLM Flash — дефолт, DeepSeek Flash, Qoder Lite)
// + одна платная (Qwen 3.8 Flash) — её выбрал владелец, она в белом списке
// бэкенда (ядро/settings_validator.PAID_PRIMARY_ALLOWLIST) и работает только
// как выбранная модель: в бесплатный откат при сбое роутер её не берёт.
// роутер (модели/router.py) читает префикс «провайдер/модель» из settings.model.
const MODELS = [
  { id: 'opencode/glm-5.3-flash-free', name: 'GLM Flash', full: 'GLM 5.3 Flash (free)', sub: 'OpenCode · быстрая, для повседневных задач' },
  { id: 'opencode/deepseek-v4.1-flash-free', name: 'DeepSeek Flash', full: 'DeepSeek 4.1 Flash (free)', sub: 'OpenCode · сильная в коде и рассуждениях' },
  { id: 'qoder/lite', name: 'Qoder Lite', full: 'Qoder (DeepSeek lite)', sub: 'Qoder CLI · бесплатный DeepSeek' },
  { id: 'opencode/qwen3.8-flash', name: 'Qwen 3.8 Flash', full: 'Qwen 3.8 Flash · платная', sub: 'OpenCode · платный баланс; при сбое откат на бесплатную' },
];

// Уровни размышлений: строго low|medium|high — те же значения принимает
// бэкенд (ядро/settings_validator.py REASONING_EFFORT_VALUES) и валидируют
// правила RTDB (FIREBASE_SETUP.md §6.1: сравнением строки). «xhigh» тут нет
// и быть не может: бэкенд его клампит в medium, а правила отклонили бы весь
// запрос ($other:false в узле settings).
const REASONING_EFFORTS = [
  { id: 'low', name: 'Быстро', full: 'Минимальные размышления', sub: 'Ответ быстрее — для простых задач' },
  { id: 'medium', name: 'Умеренно', full: 'Умеренные размышления', sub: 'По умолчанию — баланс скорости и глубины' },
  { id: 'high', name: 'Глубоко', full: 'Глубокие размышления', sub: 'Думает дольше — для сложных задач' },
];

const DEFAULT_SETTINGS = {
  // legacy-поля персонализации: из них мигрирует claude_bridge.global_rules
  instructions: '',
  replyStyle: '',
  useInstructions: true,
  context: 4096,
  temperature: 1.0,
  // Лимит длины ответа в токенах (слайдер «Персонализация»): те же границы
  // и дефолт, что в клэмпе бота (ядро/settings_validator.py)
  max_tokens: 1000,
  // Уровень размышлений: дефолт бэкенда (REASONING_EFFORT_DEFAULT)
  reasoning_effort: 'medium',
  shiftEnter: false,
  model: 'opencode/glm-5.3-flash-free',
};

// Потолок длины текста заявки — правило RTDB §6.1/§6.2 на `bridge/requests/$id`
// («newData.isString() && newData.val().length <= 8000»). Срез обязан быть ДО
// записи: превышение база отвергает всей записью, а повтор без `settings` от
// этого не спасает (он снимает settings, а не длинный text).
const TEXT_MAX_LEN = 8000;

/* ── Голосовой ввод: лимиты и заготовленные ответы ─────────────────── */

// Длительность: та же граница, что на боте (ядро/stt MAX_VOICE_DURATION через
// бот/voice.py: 120 с). Ставим лимит на клиенте, чтобы запись вообще не
// улетела в облако впустую.
const VOICE_MAX_DURATION_SEC = 120;
// Потолок ОДНОЙ записи RTDB ≈ 3 МБ; берём 2.6 МБ с запасом на обёртку
// запроса (text/initData/settings). 20 МБ из бот/voice.py — про getFile
// Bot API, к базе отношения не имеет.
const VOICE_MAX_B64_BYTES = 2.6 * 1024 * 1024;
// Запас при автоостановке: обрываем на 0,8 с раньше лимита, чтобы длительность,
// вычисленная по blob/MediaRecorder, не «доползла» за 120 с.
const VOICE_SAFETY_MARGIN_MS = 800;
// Потолок ожидания stop()/discard(): onstop у MediaRecorder иногда не
// наступает вовсе (обрыв трека, сбой кодировщика opus в WKWebView). Без
// дедлайна запись застревала бы в состоянии «stopping» с занятым микрофоном.
const VOICE_STOP_TIMEOUT_MS = 4000;
// Потолок ожидания getUserMedia. Промпт разрешения в WKWebView иногда не
// разрешается никогда; «starting» при этом считает чат занятым и прячет
// «Отправить», так что без дедлайна Mini App залипал бы до перезапуска.
const VOICE_START_TIMEOUT_MS = 12000;
// Ogg/Opus-страница ~180 Б, 50 к/с → ≈ 9 КБ/с: по размеру куска можно
// досчитать длительность, когда MediaRecorder не отдаёт timeslice.
const VOICE_BYTES_PER_SEC = 9000;
// Битрейт намеренно низкий: 2.6 МБ после base64 (≈1.95 МБ аудио) — это
// ~100 с при 128 кбит/с и ~440 с при 32 кбит/с. При 48 кбит/с моно
// 120-секундная запись занимает ~0,72 МБ (0,97 МБ в base64) — в потолок
// встаёт с трёхкратным запасом.
const VOICE_BITS_PER_SECOND = 48000;
// Текст своего пузыря: в ленте — пузырь, а не сырой аудио-кусок
const VOICE_BUBBLE_PREFIX = 'Голосовое сообщение';

// Состояние голосового ввода:
//   idle      — ничего не происходит
//   starting  — ждём разрешение на микрофон (двухэтапный старт, iOS)
//   recording — идёт запись, живёт таймер
//   review    — запись остановлена, ждём подтверждения отправки или отмены
let voiceState = 'idle';
let voiceCapture = null;    // активный захват: {elapsedSec, stop, discard}
let voiceTake = null;       // остановленная запись в ожидании подтверждения
let voiceSending = false;   // подтвердил: идёт кодирование и запись в очередь
// × нажат, пока stop()/discard() ещё в await: продолжение остановки обязано
// замолчать, иначе отменённая запись родит пузырь «Запись не удалась».
let voiceCancelled = false;
let voiceTicker = null;     // интервал живого таймера
let voiceDeadline = null;   // автоостановка по лимиту 120 с
let voiceNoteTimer = null;  // подпись «отменено/удалено» в уже закрытой панели
// Текущее ожидание микрофона: {abandoned, timeout}. Отмена или дедлайн
// помечают attempt сброшенным, и опоздавший захват по этому флагу сам
// отдаёт микрофон, не входя в запись.
let voiceStartAttempt = null;
let voiceStartTimeoutMs = VOICE_START_TIMEOUT_MS;
// Последняя НЕпринятая базой голосовая запись: {msg, oggB64, durationSec,
// chatId}. Хранится только в памяти сессии (base64 не едет в localStorage
// вместе с историей), поэтому после перезагрузки у неотправленного пузыря
// остаётся лишь «Убрать», а «Повторить» живёт до конца сессии.
let voiceRetry = null;

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
  // Миграция со старых id (auto/sonnet/opus/haiku/...): неизвестный id сбрасываем
  // на дефолт — бесплатную GLM Flash. В списке есть одна платная модель (Qwen),
  // но её выбирает сам владелец, и дефолтом она не становится.
  if (!MODELS.some(m => m.id === settings.model)) settings.model = DEFAULT_SETTINGS.model;
  // Лимит длины ответа: те же правила, что в клэмпе бота
  // (ядро/settings_validator.py: границы 100..4000, мусор → дефолт 1000).
  // Без санитизации испорченное сохранение (null, строка) уводит слайдер
  // в середину диапазона, а подпись показывает «null».
  if (Number.isFinite(settings.max_tokens)) {
    settings.max_tokens = Math.min(4000, Math.max(100, Math.trunc(settings.max_tokens)));
  } else {
    settings.max_tokens = DEFAULT_SETTINGS.max_tokens;
  }
  // Уровень размышлений: только low|medium|high. Правила RTDB валидируют
  // поле сравнением строки и чужое значение отклоняют вместе со всем
  // запросом, поэтому мусор (включая «xhigh», null, число) клампим в
  // дефолт — ровно как это делает бэкенд (ядро/settings_validator).
  if (!REASONING_EFFORTS.some(r => r.id === settings.reasoning_effort)) {
    settings.reasoning_effort = DEFAULT_SETTINGS.reasoning_effort;
  }
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
// проектными (модели/router.build_prompt). system_prompt — инструкции проекта,
// ограничены 4000 символов (лимит правил RTDB). У чата без снимка
// (создан до персонализации) глобальных инструкций нет.
function requestSettings() {
  const out = {
    model: settings.model,
    temperature: settings.temperature,
    context: settings.context,
    // Лимит длины ответа: бот клэмпит в 100..4000, мусор подменяет дефолтом
    max_tokens: settings.max_tokens,
    // Уровень размышлений: loadSettings гарантирует low|medium|high —
    // правила RTDB (§6.1) принимают ровно эти три строки
    reasoning_effort: settings.reasoning_effort,
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
// Test-only: app.js грузится как <script type="module">, поэтому его верхний
// уровень не виден из page.evaluate — e2e читает число заявок только через
// этот хук. Продакшн-код его не вызывает и удалять его при сборке не нужно.
window.__pendingCount = () => pending.size;
const streams = new Map();   // requestId -> {chatId, msg, el} — частичный ответ

// Кадры bridge/responses, пришедшие на ещё НЕ зарегистрированную заявку. Это и есть
// гонка G1: RTDB-слушатель живёт раньше, чем успевает встать запись в pending, а
// handlePartial/handleResponse делали тихий `if (!p) return;` — кадр терялся молча,
// финал не обрабатывался, и «Стоп» висел до таймаута 600 с, блокируя новый запрос.
// Теперь такой кадр копится коротким окном и применяется в trackRequest; чужие кадры
// (перезагрузка, отмена, просрочка) истекают по TTL и ничего не рисуют.
const EARLY_FRAME_TTL_MS = 30000;
const EARLY_FRAME_MAX = 20;
const earlyFrames = new Map();   // requestId -> {partial, response, seenAt}

// Заявки ещё нет в pending, а кадр уже тут: копим его (НЕ теряем молча) и обязательно
// перерисовываем композер — сверка состояния кнопки с реальным pending была ровно тем
// местом, где короткий выход без updateSendButton оставлял активный «Стоп».
function bufferEarlyFrame(requestId, frame) {
  const buf = earlyFrames.get(requestId) ||
    { partial: null, response: null, seenAt: Date.now() };
  if (frame.partial) buf.partial = frame.partial;
  if (frame.response) buf.response = frame.response;
  buf.seenAt = Date.now();
  earlyFrames.set(requestId, buf);
  updateSendButton();
  pruneEarlyFrames();
}

// TTL + потолок по количеству: буфер не имеет права расти за счёт чужих id (ответы
// на запросы других сессий, поздние кадры после «Стоп» и после таймаута).
function pruneEarlyFrames() {
  const now = Date.now();
  for (const [id, buf] of earlyFrames) {
    if (now - buf.seenAt > EARLY_FRAME_TTL_MS) earlyFrames.delete(id);
  }
  while (earlyFrames.size > EARLY_FRAME_MAX) {
    earlyFrames.delete(earlyFrames.keys().next().value);
  }
}

// Применить кадры, которые опередили регистрацию заявки (G1). Вызывается из
// trackRequest сразу после pending.set: сначала partial, потом финал, иначе пузырь
// стрима не успевает создаться и ответ влёгся бы одним сообщением.
function applyEarlyFrames(requestId) {
  const buf = earlyFrames.get(requestId);
  if (!buf) return;
  earlyFrames.delete(requestId);
  if (buf.partial) handlePartial(requestId, buf.partial);
  if (buf.response) handleResponse(requestId, buf.response);
}

function loadChats() {
  // localStorage может отдать мусор (ручная правка, старая версия, private
  // mode): не-JSON, null, не-массив, битые элементы — всё это не должно
  // валить boot, теряется максимум история чатов.
  try {
    const raw = JSON.parse(localStorage.getItem(LS_CHATS));
    chats = Array.isArray(raw) ? raw.filter(c => c && typeof c === 'object'
      && typeof c.id === 'string' && Array.isArray(c.messages)) : [];
  } catch { chats = []; }
  // pending — признак «запрос в полёте». После перезагрузки полёта нет:
  // слушатели bridge/responses не восстанавливаются, и под пузырём навечно
  // осталась бы подпись «отправляется…». Снимаем флаг при загрузке.
  for (const c of chats) {
    for (const m of c.messages || []) {
      if (m && m.pending) m.pending = false;
    }
  }
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

// Голосовой кусок принадлежит ОДНОМУ чату: settings и пузырь привязываются
// только в момент ✓, поэтому незакрытая запись (review) или незакрытая
// отправка (voiceSending) не переезжает — иначе утонула бы в чужом чате, а
// «Очистить»/«Удалить» оставили бы сироту. Тот же долг, что в tapChatAction.
function voiceHoldBlock(action) {
  if (!voiceSending && voiceState === 'idle') return false;
  addMessage('error', 'Сначала голосовое',
    '«' + action + '» переключит чат, а запись ещё не отправлена — '
    + 'нажми ✓ или ×.');
  return true;
}

function newChat(silent = false, projectId = null) {
  if (!silent && voiceHoldBlock('Новый чат')) return null;
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
  // Drawer закрываем и при отказе: под ним виден composer с ✓ и ×.
  if (voiceHoldBlock('Смена чата')) { closeDrawer(); return; }
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

/* ── Управление чатом: очистка и удаление ──────────────────────────── */
// Два РАЗНЫХ действия, оба необратимы (история живёт только в
// localStorage, в облаке её нет):
//   clearChat  — чистит лента, чат ОСТАЁТСЯ в Recents (id, title,
//                привязка к проекту и снимок персонализации целы)
//   deleteChat — чат уходит из Recents вместе со своими сообщениями
// Название при очистке не сбрасываем: «Новый чат» touchChat переименовал
// бы сам, а готовое название пользователь мог поменять сам.

const chatById = id => chats.find(c => c.id === id) || null;

// Снять с учёта всё, что чат ещё не завершил: незакрытые запросы (pending
// + таймер 600 с) и частичные пузыри (streams). Очистка и удаление обязаны
// делать это оба, иначе таймер позже допишет ошибку в несуществующий чат,
// а стрим-пузырь останется висячим (его msg уже вне chat.messages).
// Рендер не трогаем — вызывающий код перерисует один раз.
function dropChatRequests(chatId) {
  for (const id of pendingIdsForChat(chatId)) {
    const p = pending.get(id);
    clearTimeout(p.timer);
    p.voiceMsg = null;      // пузырь этого чата всё равно пропадёт из ленты
    pending.delete(id);
  }
  for (const [id, s] of [...streams]) {
    if (s.chatId !== chatId) continue;
    if (s.el) s.el.remove();
    streams.delete(id);
  }
  // Неотправленный голос этого чата больше некуда повторять
  if (voiceRetry && voiceRetry.chatId === chatId) voiceRetry = null;
}

// «Очистить сообщения»: лента пустеет, чат остаётся в Recents. updated не
// трогаем — действие не «активность в чате», и пересортица Recents только
// запутала бы. Пустой чат при этом живёт по обычным правилам: «New chat»
// переиспользует его, а touchChat даст название со следующего сообщения.
function clearChat(chatId) {
  const chat = chatById(chatId);
  if (!chat) return false;
  dropChatRequests(chatId);
  chat.messages = [];
  persistChats();
  // Ленту перерисовываем только если чат открыт: очистка чата из списка не
  // должна «прокручивать» текущую переписку в начало. updateTyping — всегда:
  // pending снимается глобально, и индикатор «Агент обрабатывает запрос…»
  // чужого чата иначе крутился бы до перезагрузки. updateSendButton —
  // потому что снятый pending мог прятать «Отправить» за «Стоп».
  if (chatId === currentChatId) renderMessages();
  updateTyping();
  updateSendButton();
  renderRecents();
  return true;
}

// «Удалить чат»: вместе с историей из Recents. Удаление текущего — тот же
// инвариант, что у loadChats: активный чат обязан существовать, поэтому
// берём самый свежий из оставшихся, а если чатов не осталось — новый пустой
// (newChat(true) сам сохранит и перерисует всё).
function deleteChat(chatId) {
  const i = chats.findIndex(c => c.id === chatId);
  if (i < 0) return false;
  dropChatRequests(chatId);
  chats.splice(i, 1);
  if (chatId === currentChatId) {
    const next = [...chats].sort((a, b) => b.updated - a.updated)[0];
    currentChatId = next ? next.id : null;
    if (!currentChatId) {
      // Новый чат уже без запросов, но индикатор обязан погаснуть: pending
      // снят выше, а renderAll внутри newChat updateTyping не вызывает.
      newChat(true);
      updateTyping();
      return true;
    }
  }
  persistChats();
  renderAll();
  updateTyping();
  return true;
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
  if (voiceHoldBlock('Новый чат в проекте')) return;
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
let bridge = null;           // {init, beginRequest + commitRequest, onResponse, onPresence, onState}
// Последний запрос ушёл БЕЗ settings: sendToBridge одна честно переписывает
// его без узла settings при отказе правил (§6.1/§6.2, $other:false режет
// неизвестные ключи целиком). Узел необязателен по контракту — потребление
// в sendMessage/confirmVoiceSend даёт диагностику «обновите правила».
let settingsDropped = false;

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
    // Ключ демо-заявки генерируется ДО записи: вызывающий успевает зарегистрировать
    // pending раньше любого кадра bridge/responses (см. reserveRequestId).
    beginRequest() {
      return 'mock-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    },
    async commitRequest(id, text, initData, reqSettings, voice) {
      // Test-only симуляция отказа правил на записи (только ?mock=1):
      //   window.__mockWriteFail = {}                    — резать любую
      //     попытку с settings и без (проверка диагностики отказа)
      //   window.__mockWriteFail = { settingsOnly: true } — резать только
      //     запросы с settings (проверка фолбэка sendToBridge)
      const wf = window.__mockWriteFail || null;
      if (wf && (!wf.settingsOnly || reqSettings)) {
        throw bridgeError(wf.code || 'PERMISSION_DENIED',
          wf.message || 'permission_denied at database/bridge/requests');
      }
      const entry = { text, initData, ts: now() };
      // settings — узел необязательный (фолбэк sendToBridge пишет без него)
      if (reqSettings) entry.settings = reqSettings;
      // Голосовой запрос: новое поле контракта с теми же остальными полями
      if (voice) entry.voice = { oggB64: voice.oggB64, durationSec: voice.durationSec };
      window.__mockDb.bridge.requests[id] = entry;
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
      // Голосовой запрос в демо-режиме: текст пустой, поэтому эхо по text
      // было бы «запрос «»». Отвечаем про голосовое,partial'ы те же.
      const echo = voice
        ? 'голосовое ' + voice.durationSec + ' с'
        : '«' + text + '»';
      // Имитация стриминга: два partial-а, затем финальный ответ
      setTimeout(() => {
        const partial = 'Демо-режим: печатаю ответ';
        window.__mockDb.bridge.responses[id] = { partial, ts: now() };
        onStream?.(id, partial);
      }, 250);
      setTimeout(() => {
        const partial = 'Демо-режим: печатаю ответ на ' + echo + '…';
        window.__mockDb.bridge.responses[id] = { partial, ts: now() };
        onStream?.(id, partial);
      }, 600);
      setTimeout(() => {
        // window.__mockResponseText (e2e): тест подменяет финальный текст
        // ответа, чтобы проверить разметку markdown в пузыре ассистента
        const response = {
          text: window.__mockResponseText ||
            'Демо-режим: запрос ' + echo + ' дошёл до моста. ' +
            'Впишите apiKey в miniapp/firebase-config.js — ответы будет давать реальная модель.',
          ts: now(),
        };
        window.__mockResponseText = null;
        window.__mockDb.bridge.responses[id] = response;
        onResp?.(id, response);
      }, 2200);
      // Test-only гонка G1 (e2e шаг 65): partial и финал уходят ДО возврата
      // commitRequest — ровно то, что в проде даёт ранний кадр на время сетевого
      // await. window.__mockEarlyFrame = текст финала (или { text }).
      if (window.__mockEarlyFrame) {
        const early = window.__mockEarlyFrame;
        window.__mockEarlyFrame = null;
        const finalText = typeof early === 'string' ? early
          : (early && early.text) || 'Демо-режим: ранний кадр';
        const earlyPartial = 'Демо-режим: partial до подтверждения записи';
        window.__mockDb.bridge.responses[id] = { partial: earlyPartial, ts: now() };
        onStream?.(id, earlyPartial);
        const response = { text: finalText, ts: now() };
        window.__mockDb.bridge.responses[id] = response;
        onResp?.(id, response);
      }
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
        + 'Опубликуй правила §8 (python служебное/apply_firebase_rules.py '
        + '--section 6.2 --apply, предварительно --check), чтобы '
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
  // Owner-сессия обязательна для записи запросов (FIREBASE_SETUP.md §6.2):
  // провал хендшейка на старте не валит мост (подписки настраиваются),
  // но commitRequest не пишет очередь, пока владелец не подтверждён.
  let ownerOk = false;
  let ownerPending = null;
  const ensureOwner = initData => {
    if (ownerOk) return Promise.resolve();
    if (ownerPending) return ownerPending;
    ownerPending = upgradeToOwnerSession(authMod, auth, dbMod, db, initData)
      .then(() => {
        ownerOk = true;
        ownerPending = null;
      }, e => {
        ownerPending = null;
        throw e;
      });
    return ownerPending;
  };
  try {
    await upgradeToOwnerSession(authMod, auth, dbMod, db, getInitData());
    ownerOk = true;
  } catch (e) {
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
    beginRequest() {
      // Ключ bridge/requests/{id} создаётся локально (push) и известен СРАЗУ, до
      // сетевого await: на нём держится регистрация заявки в pending, поэтому
      // слушатель bridge/responses заведомо находит активную заявку (гонка G1).
      return dbMod.push(dbMod.child(dbMod.ref(db), 'bridge/requests')).key;
    },
    async commitRequest(requestId, text, initData, reqSettings, voice) {
      // §6.2: родитель bridge/requests закрыт, $id пишется только сессией
      // с claim owner и только как create. Без owner запрос не отправляем:
      // честный статус и повторный хендшейк; фолдбек «писать без owner» убран.
      if (!ownerOk) {
        addMessage('error', 'Жду подтверждение владельца (handshake)',
          'Запрос удержан: правила пропускают запись в bridge/requests '
          + 'только с claim owner. Повторяю хендшейк…');
        try {
          await ensureOwner(initData);
        } catch (e) {
          throw bridgeError('BRIDGE_NO_OWNER',
            'Жду подтверждение владельца (handshake): ' + (e?.message || e));
        }
      }
      // initData остаётся в payload: бот валидирует подпись независимо.
      // settings — узел необязательный (контракт {text, initData, ts}
      // совместим): фолбэк sendToBridge переписывает запрос без него.
      const payload = { text, initData, ts: Math.floor(Date.now() / 1000) };
      if (reqSettings) payload.settings = reqSettings;
      // Голос: контракт bridge/requests/{id} += voice:{oggB64, durationSec};
      // у текстового запроса поля нет вовсе (не null) — старые правила и
      // старый бот его просто не видят.
      if (voice) payload.voice = { oggB64: voice.oggB64, durationSec: voice.durationSec };
      await dbMod.set(dbMod.ref(db, 'bridge/requests/' + requestId), payload);
      return requestId;
    },
    onResponse(cb) { onResp = cb; },
    onPartial(cb) { onStream = cb; },
    onPresence(cb) { onPres = cb; },
    onState(cb) { onState = cb; },
  };
}

/* ── Отправка и приём ──────────────────────────────────────────────── */

// Отказ правил RTDB на ЗАПИСИ: коды Firebase — 'PERMISSION_DENIED', в
// сообщении всегда есть «permission_denied». Симметрично deniedReader
// (чтение): владелец должен видеть «правила», а не сырой текст SDK.
const isRulesDenied = e => (e && e.code === 'PERMISSION_DENIED')
  || /permission[\s_-]?denied/i.test(String((e && e.message) || e || ''));

// Человекочитаемая диагностика отклонённой записи запроса. Причина почти
// всегда одна из трёх: не применены/устарели правила §6.1–§6.2 (они
// отклоняют и узел voice, и неизвестные ключи в settings — $other:false),
// или сессия без owner-токена (§8). Текст объясняет все три и говорит,
// что делать; {title, detail} или null, если отказ не похож на правила.
function describeWriteError(e, subject) {
  if (!isRulesDenied(e)) return null;
  return {
    title: 'Правила RTDB отклонили ' + subject,
    detail: 'Firebase не принял ' + subject + ' в bridge/requests. Так '
      + 'ведут себя неразрешённые правила: они отклоняют и голосовой узел '
      + 'voice {oggB64, durationSec}, и неизвестные ключи в settings, и '
      + 'запись без токена владельца. Сначала переоткрой Mini App — хендшейк '
      + 'выдаст owner-токен (FIREBASE_SETUP.md §8). Если не помогло — в базе '
      + 'устаревшие правила: опубликуй актуальные (§6.2, откат — §6.1, '
      + 'FIREBASE_SETUP.md) командой python служебное/'
      + 'apply_firebase_rules.py --section 6.2 --apply (сначала --check).',
  };
}

// Сбой сети/устройства, а не отказ правил: у Firebase свои коды
// (unavailable / network-request-failed), у fetch — TypeError «Failed to
// fetch». Лечится не правилами, поэтому владельцу нужен отдельный короткий
// текст: «нет связи» и «правила» — это разные истории.
const isNetworkFailure = e => {
  const code = String((e && e.code) || '').toLowerCase();
  const text = String((e && e.message) || e || '').toLowerCase();
  return code === 'unavailable' || code === 'network-request-failed'
    || /failed to fetch|networkerror|net::err|econnrefused|econnreset|network (error|request failed)|offline/.test(text);
};

// Полная диагностика сбоя отправки: правила → сеть → прочие. Всегда отдаёт
// {title, detail} коротким человечным текстом: без стека (берём первую строку
// и режем её), с исходной ошибкой только в консоли (её печатает вызывающий
// catch). fallbackTitle — заголовок для «прочих», он разный у текста и голоса.
function describeSendFailure(e, subject, fallbackTitle) {
  const rules = describeWriteError(e, subject);
  if (rules) return rules;
  if (isNetworkFailure(e)) {
    return {
      title: 'Нет связи с базой',
      detail: 'Firebase не достать — ' + subject + ' не записан в очередь. Это '
        + 'похоже на обрыв сети, а не на отказ правил: проверь интернет и '
        + 'отправь ещё раз.',
    };
  }
  const brief = String((e && e.message) || e || '').split('\n')[0].slice(0, 120);
  return {
    title: fallbackTitle,
    detail: 'Firebase не принял ' + subject + ': ' + (brief || 'неизвестная ошибка')
      + '. Отправка не выполнена — попробуй ещё раз; подробности в консоли.',
  };
}

// Единая точка отправки запроса в мост (текст и голос). Если правила
// отклонили запись с settings — одна честная повторная попытка БЕЗ узла
// settings: он необязателен по контракту ({text, initData, ts} совместим),
// запрос дойдёт до бота, а settingsDropped включит подсказку «обнови
// правила». Второй отказ — наружу, describeSendFailure объяснит его.
// Ключ заявки известен до записи (локальный push), поэтому sendMessage и deliverVoice
// сперва резервируют id и регистрируют pending, а уже потом пишут bridge/requests — так
// слушатель bridge/responses не может увидеть кадр раньше заявки (закрытая гонка G1).
function reserveRequestId() {
  return bridge.beginRequest();
}

// Единая точка ЗАПИСИ уже зарезервированного запроса в мост (текст и голос). Если
// правила отклонили запись с settings — одна честная повторная запись БЕЗ узла
// settings: он необязателен по контракту ({text, initData, ts} совместим), запрос
// дойдёт до бота, а settingsDropped включит подсказку «обнови правила». Второй отказ
// — наружу: describeSendFailure объяснит его, а вызывающий обязан снять заявку через
// untrackRequest (иначе «Стоп» повиснет на несостоявшемся запросе).
async function sendToBridge(requestId, text, reqSettings, voice) {
  try {
    return await bridge.commitRequest(requestId, text, getInitData(), reqSettings, voice);
  } catch (e) {
    if (reqSettings && isRulesDenied(e)) {
      await bridge.commitRequest(requestId, text, getInitData(), null, voice);
      settingsDropped = true;
      return requestId;
    }
    throw e;
  }
}

// Общий для текста и голоса учёт ушедшего запроса: таймер 600 с (ровно
// столько же ждёт бот), пузырь ошибки по истечении, снятие «печатает».
// Из одного чата в полёте максимум один запрос — second-send блокируется
// по pending (см. chatBusy).
function trackRequest(requestId, chatId, voiceMsg) {
  const entry = {
    chatId,
    voiceMsg: voiceMsg || null,
    timer: setTimeout(() => {
      if (pending.delete(requestId)) {
        // Как пути stub/ok:false: пузырь-превью снимаем вместе со
        // стрим-состоянием (иначе он навсегда «печатает», флаг streaming
        // персистится и переживает перезагрузку). Поздний ответ после
        // таймаута игнорируется: handleResponse/Partial видят !p и выходят.
        dropStreamBubble(requestId);
        settleVoicePending(entry);
        addMessage('error', 'Модель не смогла ответить',
          'Ответ не пришёл за 10 минут — запрос просрочен или бот офлайн.',
          chatId);
        updateTyping();
      }
    }, REQUEST_TIMEOUT_SEC * 1000),
  };
  pending.set(requestId, entry);
  // Кадр мог прийти раньше регистрации (G1) — догоняем его сразу.
  applyEarlyFrames(requestId);
  updateTyping();
}

// Чат «занят»: ждём ответ ИЛИ идёт запись/подтверждение голосового.
// Второй запрос из такого чата не пускаем: у бота один воркер, и очередь
// превратилась бы в гонку за один контекст.
// Снять заявку, если запись запроса не удалась: таймер, pending, буфер ранних кадров
// и состояние кнопки убираются одним движением. Без этого «Стоп» висел на запросе,
// который никуда не ушёл, и блокировал новый запрос через chatBusy.
function untrackRequest(requestId) {
  const p = pending.get(requestId);
  if (!p) return false;
  clearTimeout(p.timer);
  p.voiceMsg = null;      // пузырь голоса доводит свой catch (failed/повтор)
  pending.delete(requestId);
  earlyFrames.delete(requestId);
  updateTyping();
  return true;
}

function chatBusy(chatId = currentChatId) {
  if (voiceState !== 'idle') return 'voice';
  if (voiceSending) return 'sending';
  return awaitingReply({ chatId }) ? 'waiting' : null;
}

async function sendMessage() {
  const input = document.getElementById('input');
  const raw = input.value.trim();
  if (!raw) return;
  // Потолок правила RTDB (TEXT_MAX_LEN): длиннее база отвергает ВСЮ запись,
  // а повтор без settings от этого не спасает. Отрезаем и показываем ровно
  // то, что уехало.
  const text = raw.slice(0, TEXT_MAX_LEN);
  if (!bridge) {
    addMessage('error', 'Модель не смогла ответить', 'Firebase не настроен: впишите apiKey в miniapp/firebase-config.js.');
    return;
  }
  // Пока идёт запись голосового, с клавиатуры не отправляем: кнопка
  // «Отправить» скрыта, но Enter вызвал бы sendMessage напрямую.
  const busy = chatBusy();
  if (busy === 'voice' || busy === 'sending') {
    addMessage('error', 'Голосовое ещё не отправлено',
      'Сначала заверши запись голосового (✓ отправить или × отменить).');
    return;
  }
  // Один чат — один запрос в полёте: Enter в обход скрытой кнопки тоже
  // блокируем (у бота один воркер, второй запрос — гонка за контекст).
  if (busy === 'waiting') {
    addMessage('error', 'Уже жду ответ',
      'В этом чате есть незавершённый запрос — дождись ответа или нажми «Стоп».');
    return;
  }

  const chat = currentChat();
  const attach = state.attachment;
  // Срез ПОСЛЕ префикса вложения: база считает длиной всю строку `text`, а не
  // только набранный текст.
  const fullText = (attach ? '[Вложение: ' + attach + ']\n\n' + text : text)
    .slice(0, TEXT_MAX_LEN);

  input.value = '';
  autoResize();
  updateSendButton();
  clearAttachment();

  addMessage('user', fullText);
  touchChat(chat, fullText);
  persistChats();
  renderRecents();

  const msg = { text: fullText, initData: getInitData(), settings: requestSettings() };
  // ГОНКА G1: заявка регистрируется до сетевого await. Ключ создаётся локально
  // (reserveRequestId), поэтому pending живёт раньше, чем любой кадр
  // bridge/responses/{id} может быть обработан, а updateSendButton остаётся в курсе
  // пришедшего ответа — «Стоп» не залипает и новый запрос не упирается в «Уже жду ответ».
  const requestId = reserveRequestId();
  trackRequest(requestId, chat.id);
  try {
    await sendToBridge(requestId, msg.text, msg.settings);
    if (settingsDropped) {
      settingsDropped = false;
      addMessage('error', 'Настройки не приняты базой',
        'Запрос отправлен без settings — обновите правила RTDB (FIREBASE_SETUP.md §6).');
    }
  } catch (e) {
    untrackRequest(requestId);
    console.error('sendRequest:', e);
    const d = describeSendFailure(e, 'запрос', 'Модель не смогла ответить');
    addMessage('error', d.title, d.detail, chat.id);
  }
}

function handlePartial(requestId, partialText) {
  const p = pending.get(requestId);
  // Нет заявки — НЕ повод молча выходить: кадр либо опередил trackRequest (G1), либо
  // чужой/просроченный. bufferEarlyFrame сам зовёт updateSendButton, поэтому кнопка
  // сверяется с pending в любом случае.
  if (!p) { bufferEarlyFrame(requestId, { partial: partialText }); return; }
  settleVoicePending(p);                // мост живой: пометка «отправляется» не нужна
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
  // Финал на неизвестном id — тот же путь, что у partial: буфер + перерисовка
  // композера. Именно тихий return здесь оставлял залипший «Стоп» при раннем финале.
  if (!p) { bufferEarlyFrame(requestId, { response: data }); return; }
  pending.delete(requestId);
  clearTimeout(p.timer);
  settleVoicePending(p);                // ответ пришёл — пузырь голоса финализируем
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
  // текстом «Ошибка выполнения, код N» (модели/base.py). Вместо сырого
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

/* ── Голосовой ввод ──────────────────────────────────────────────────
   Путь: тап по микрофону → двухэтапный старт (прогрев AudioContext +
   getUserMedia, и только потом MediaRecorder) → запись с живым таймером и
   автоостановкой на 120 с → подтверждение → base64 → тот же мост, что у
   текста: bridge/requests/{id} с text:"" и новым полем voice. Ответ
   приходит по существующей подписке bridge/responses — отдельной
   обработки ответа здесь нет намеренно.
   ═══════════════════════════════════════════════════════════════════ */

// Форматы в порядке предпочтения: Ogg/Opus — то, что ждёт бот (контейнер
// из контракта voice.oggB64); audio/mp4 — Safari/WKWebView, где ogg-миксера
// нет; audio/webm;codecs=opus — последний шанс для старых Chromium без
// ogg: ffmpeg на боте определяет контейнер по содержимому, а не по имени.
const VOICE_MIME_CANDIDATES = ['audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm;codecs=opus'];

function pickVoiceMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const mime of VOICE_MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    } catch (e) { /* кривая реализация — идём дальше */ }
  }
  return null;
}

// Микрофон вообще доступен? Кнопка по этой же проверке получает внятную
// подпись вместо «мёртвой» — пользователь должен понимать, почему тап
// ничего не делает.
function voiceSupportError() {
  if (typeof MediaRecorder === 'undefined') {
    return { title: 'Голосовой ввод недоступен',
      detail: 'Этот WebView не умеет MediaRecorder — запись голоса невозможна. '
        + 'Обнови Telegram и WebView (iOS: Настройки → Safari) или напиши текстом.' };
  }
  if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
    return { title: 'Микрофон недоступен',
      detail: 'Браузер не отдаёт микрофон (getUserMedia). Mini App должен '
        + 'открываться по https внутри Telegram: проверь разрешения '
        + 'микрофона в настройках сайта и попробуй ещё раз.' };
  }
  if (!pickVoiceMime()) {
    return { title: 'Нет поддерживаемого аудиоформата',
      detail: 'Ни Ogg/Opus, ни audio/mp4 не поддерживаются этим WebView. '
        + 'Запись не начать — обнови Telegram/WebView или пиши текстом.' };
  }
  return null;
}

// Этап 0 (критично для iOS): «разбудить» аудиоподсистему. В WKWebView/Safari
// MediaRecorder, запущенный на холодном аудио-тракте, пишет файл нулевой
// длины: AudioContext должен быть создан и запущен в том же пользовательском
// жесте, до записи. Греем один нулевой сэмпл через gain = 0 — в динамик
// ничего не идёт, а тракт просыпается. Контекст держим открытым до конца
// записи: закрытие на iOS снова глушит трек.
function primeAudioContext() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  let ctx = null;
  try {
    ctx = new Ctx();
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      const p = ctx.resume();
      if (p && typeof p.catch === 'function') p.catch(() => { /* не критично */ });
    }
    const buffer = ctx.createBuffer(1, 1, ctx.sampleRate || 44100);
    buffer.getChannelData(0)[0] = 0;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(gain);
    gain.connect(ctx.destination);
    src.start(0);
  } catch (e) {
    console.warn('prime AudioContext:', e);
  }
  return ctx;
}

function closeAudioContext(ctx) {
  if (!ctx) return;
  try { if (ctx.state !== 'closed' && typeof ctx.close === 'function') ctx.close(); }
  catch (e) { /* уже закрыт — не важно */ }
}

function releaseStream(stream) {
  if (!stream) return;
  try { for (const t of stream.getTracks()) t.stop(); } catch (e) { /* нет getTracks */ }
}

// Захват от реального микрофона. Возвращает интерфейс {elapsedSec, stop,
// discard} — тот же, что и тестовая подмена, поэтому весь верхний путь
// (таймер, лимиты, base64, отправка) ему безразличен.
async function openMicCapture() {
  const support = voiceSupportError();
  if (support) throw bridgeError('VOICE_UNSUPPORTED', support.detail);

  const mimeType = pickVoiceMime();
  const audioCtx = primeAudioContext();
  let stream = null;
  try {
    // Этап 1 двухэтапного старта: ДОЖИДАЕМСЯ трек. MediaRecorder, созданный
    // до того, как WebView отдал микрофон, на iOS пишет пустой файл.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      video: false,
    });
  } catch (e) {
    closeAudioContext(audioCtx);
    const reasons = {
      NotAllowedError: 'Доступ к микрофону запрещён. Разреши запись голоса '
        + 'для Telegram (iOS: Настройки → Приложения → Telegram → Микрофон) '
        + 'и повтори.',
      NotFoundError: 'Микрофон не найден. Подключи гарнитуру или напиши текстом.',
      NotReadableError: 'Микрофон занят другим приложением — закрой его и повтори.',
      OverconstrainedError: 'Микрофон не поддерживает запрошенный режим — '
        + 'пиши текстом.',
      SecurityError: 'Браузер закрыл доступ к микрофону: страница должна '
        + 'открываться по https внутри Telegram.',
      AbortError: 'Система прервала доступ к микрофону — попробуй ещё раз.',
    };
    throw bridgeError('VOICE_GETUSERMEDIA',
      reasons[e && e.name] || ('Не удалось включить микрофон: ' + (e && e.message || e)));
  }

  // Этап 2: MediaRecorder создаём только теперь и только из аудио-трека.
  let recStream = stream;
  try {
    if (typeof MediaStream === 'function' && stream.getAudioTracks) {
      const tracks = stream.getAudioTracks();
      if (tracks.length) recStream = new MediaStream(tracks);
    }
  } catch (e) { /* старый WebView: пишем из исходного потока */ }

  let rec = null;
  try {
    rec = new MediaRecorder(recStream, {
      mimeType,
      audioBitsPerSecond: VOICE_BITS_PER_SECOND,
    });
  } catch (e) {
    releaseStream(stream);
    closeAudioContext(audioCtx);
    throw bridgeError('VOICE_RECORDER',
      'MediaRecorder не создан для ' + mimeType + ': ' + (e && e.message || e));
  }

  const chunks = [];
  let lastSliceMs = 0;
  let discarded = false;
  let closed = false;
  let stopRequestedAt = 0;   // момент НАШЕГО тапа, а не момент onstop
  let onEndedCb = null;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    releaseStream(stream);
    closeAudioContext(audioCtx);
  };
  const startedAt = performance.now();
  // Трек мог оборваться сам (звонок, Siri, чужое приложение перехватило
  // микрофон, уход в фон). Тогда onstop/onerror приходят без нашего тапа, и
  // вызывающий обязан узнать, что записывать больше нечего: иначе таймер
  // крутится, а куски перестают приходить.
  const notifyEnded = () => {
    if (!onEndedCb) return;
    try { onEndedCb(); } catch (e) { console.warn('voice onEnded:', e); }
  };

  const done = new Promise((resolve, reject) => {
    rec.ondataavailable = ev => {
      if (ev && ev.data && ev.data.size > 0) {
        chunks.push(ev.data);
        lastSliceMs = performance.now() - startedAt;
      }
    };
    rec.onerror = ev => {
      cleanup();
      reject(bridgeError('VOICE_RECORDER',
        'Ошибка записи: ' + ((ev && ev.error && ev.error.message) || (ev && ev.message) || ev)));
      notifyEnded();
    };
    rec.onstop = () => {
      // Wall-clock считаем от тапа остановки, а не от прихода onstop:
      // финализация кодировщика стоит доли секунды, и 120-секундная запись
      // иначе «доползла» бы до отказа собственного лимита клиента.
      const wallSec = ((stopRequestedAt || performance.now()) - startedAt) / 1000;
      const bytes = chunks.reduce((n, c) => n + (c && c.size ? c.size : 0), 0);
      if (discarded) { cleanup(); resolve(null); notifyEnded(); return; }
      // Длительность по надёжности: разметка timeslice'ов → трек (Safari) →
      // wall-clock → оценка по размеру Ogg-кусков.
      let durationSec = lastSliceMs > 0 ? lastSliceMs / 1000 : 0;
      const track = recStream.getAudioTracks && recStream.getAudioTracks()[0];
      if (!durationSec && track && Number.isFinite(track.duration)
          && track.duration > 0 && track.duration < wallSec + 5) {
        durationSec = track.duration;
      }
      if (!durationSec) durationSec = wallSec;
      if (!durationSec && bytes) durationSec = bytes / VOICE_BYTES_PER_SEC;
      const blob = new Blob(chunks, { type: rec.mimeType || mimeType });
      cleanup();
      resolve({
        blob,
        bytes,
        durationSec: Math.round(durationSec * 10) / 10,
        mime: blob.type || mimeType,
        empty: bytes === 0,
      });
      notifyEnded();
    };
  });
  // Спонтанный onerror приходит без ожидающего stop(): без пассивного
  // наблюдателя отказ стал бы unhandled rejection прямо в консоли WebView.
  // Свой await в stopRec при этом получает отказ как обычно.
  done.catch(() => {});

  try {
    // timeslice 1 с: Safari охотнее отдаёт данные у куска с разметкой
    // времени, а без него длительность всё равно досчитаем ниже.
    rec.start(1000);
  } catch (e) {
    cleanup();
    throw bridgeError('VOICE_RECORDER', 'Не удалось начать запись: ' + (e && e.message || e));
  }

  const stopRec = () => {
    if (!stopRequestedAt) stopRequestedAt = performance.now();
    try { if (rec.state !== 'inactive') rec.stop(); }
    catch (e) { console.warn('recorder stop:', e); }
    return done;
  };
  return {
    elapsedSec: () => Math.max(0, (performance.now() - startedAt) / 1000),
    stop: stopRec,
    discard: () => { discarded = true; return stopRec(); },
    // Отдать микрофон вручную нужен, когда stop()/discard() не завершились:
    // без него индикатор записи горит после зависшего onstop
    release: cleanup,
    // Сеттер, а не поле: обработчик вешается уже на готовом объекте, а
    // вызывать его должны замыкания rec (onstop/onerror), созданные раньше.
    set onEnded(fn) { onEndedCb = fn; },
    get onEnded() { return onEndedCb; },
  };
}

// Test-only захват для ?mock=1 (window.__voiceTest): отдаёт подставленную
// запись, не трогая продакшн-ветку. Интерфейс идентичен openMicCapture,
// поэтому лимиты, base64, пузырь и очередь проверяются по-настоящему.
function openCannedCapture(canned) {
  const startedAt = performance.now();
  const b64 = typeof canned.oggB64 === 'string' ? canned.oggB64 : '';
  const durationSec = Number.isFinite(canned.durationSec)
    ? canned.durationSec : (b64 ? 3 : 0);
  const empty = canned.empty === true || (!b64 && !canned.blob);
  const take = () => ({
    blob: canned.blob || null,
    oggB64: b64 || null,
    bytes: Number.isFinite(canned.bytes) ? canned.bytes
      : (b64 ? Math.floor(b64.length * 3 / 4) : 0),
    durationSec,
    mime: canned.mime || 'audio/ogg;codecs=opus',
    empty,
  });
  return {
    elapsedSec: () => (performance.now() - startedAt) / 1000,
    // hangStop — симуляция зависшего onstop: stop()/discard() никогда не
    // резолвятся, а проверка состоит в том, что дедлайн всё равно отдаёт
    // микрофон через release() и возвращает интерфейс в idle.
    stop: canned.hangStop ? () => new Promise(() => {}) : () => Promise.resolve(take()),
    discard: canned.hangStop ? () => new Promise(() => {}) : () => Promise.resolve(null),
    release: () => { if (window.__voiceTest) window.__voiceTest.releases++; },
    // Продакшн вешает на него обработчик «трек оборвался сам»; E2E вызывает
    // его напрямую, симулируя перехват микрофона системой.
    onEnded: null,
  };
}

// Blob → ArrayBuffer → base64. Цельный btoa(String.fromCharCode(...)) на
// таких строках валится RangeError в apply и рвёт память, поэтому режем на
// куски, кратные 3 байта: у каждого куска свой корректный base64 без
// «внутренней» паддинги, склейка остаётся валидной.
function bytesToBase64(bytes) {
  const CHUNK = 0xFFFC;                 // 65532 — кратно 3
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const part = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    let bin = '';
    for (let j = 0; j < part.length; j++) bin += String.fromCharCode(part[j]);
    out += btoa(bin);
  }
  return out;
}

async function blobToBase64(blob) {
  if (!blob) throw bridgeError('VOICE_NO_DATA', 'Записи нет — нечего отправлять.');
  if (typeof blob.arrayBuffer === 'function') {
    return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
  }
  // Старый WebView без Blob.arrayBuffer (iOS <14): data URL от FileReader.
  return await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result || '');
      const comma = s.indexOf(',');
      if (comma < 0) reject(bridgeError('VOICE_NO_DATA', 'FileReader не вернул base64.'));
      else resolve(s.slice(comma + 1));
    };
    fr.onerror = () => reject(fr.error || bridgeError('VOICE_NO_DATA', 'FileReader не прочитал Blob.'));
    fr.readAsDataURL(blob);
  });
}

function fmtVoiceClock(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}

const voiceBubbleText = sec => VOICE_BUBBLE_PREFIX + ' · ' + Math.max(1, Math.round(sec)) + ' с';

// ═══ UI: состояние кнопки и панели записи ═══

const VOICE_HINTS = {
  idle: '',
  starting: 'Включаю микрофон…',
  recording: 'Идёт запись · × — отменить',
  stopping: 'Дочитываю запись…',
  review: 'Записано · ✓ отправить, × отменить',
};

function voiceEls() {
  return {
    mic: document.getElementById('btnMic'),
    bar: document.getElementById('voiceBar'),
    timer: document.getElementById('voiceTimer'),
    hint: document.getElementById('voiceHint'),
    send: document.getElementById('voiceSend'),
    cancel: document.getElementById('voiceCancel'),
  };
}

// hint — переопределить подпись (автоостановка, отмена); иначе VOICE_HINTS
// по текущему состоянию. Показываем либо живые секунды записи, либо
// длительность остановленного куска — панель и payload не расходятся.
function setVoiceUi(hint) {
  const el = voiceEls();
  if (!el.mic) return;
  const active = voiceState !== 'idle';
  el.mic.classList.toggle('recording', voiceState === 'recording');
  el.mic.classList.toggle('starting', voiceState === 'starting');
  el.mic.classList.toggle('has-take', voiceState === 'review');
  el.mic.setAttribute('aria-label',
    voiceState === 'recording' ? 'Остановить запись' : 'Записать голосовое сообщение');
  el.bar.hidden = !active;
  el.bar.classList.toggle('review', voiceState === 'review');
  if (active) clearTimeout(voiceNoteTimer);
  el.bar.classList.toggle('note', !active && !el.bar.hidden);
  // Лента приподнимается под панель записи: последний пузырь не должен
  // прятаться под выросшим composer.
  const app = document.getElementById('app');
  if (app) app.classList.toggle('voice-open', active);
  if (active) {
    let shown = 0;
    if (voiceState === 'review' && voiceTake) shown = voiceTake.durationSec;
    else if ((voiceState === 'recording' || voiceState === 'stopping') && voiceCapture) {
      shown = voiceCapture.elapsedSec();
    }
    el.timer.textContent = fmtVoiceClock(shown);
    el.timer.classList.toggle('at-limit', shown >= VOICE_MAX_DURATION_SEC - 5);
    el.hint.textContent = hint || VOICE_HINTS[voiceState] || '';
    el.send.hidden = voiceState !== 'review';
    el.send.disabled = voiceSending;
  }
  updateSendButton();
}

function stopVoiceTicker() {
  if (voiceTicker) { clearInterval(voiceTicker); voiceTicker = null; }
  if (voiceDeadline) { clearTimeout(voiceDeadline); voiceDeadline = null; }
}

// Короткая подпись в панели записи, когда состояние уже «idle»: без неё
// отменённая запись уходила бы «в никуда» без единого слова.
function showVoiceNote(text, ms = 1800) {
  const el = voiceEls();
  if (!el.bar) return;
  clearTimeout(voiceNoteTimer);
  el.bar.hidden = false;
  el.bar.classList.add('note');
  el.bar.classList.remove('review');
  el.timer.textContent = '0:00';
  el.timer.classList.remove('at-limit');
  el.hint.textContent = text;
  el.send.hidden = true;
  voiceNoteTimer = setTimeout(() => {
    el.bar.classList.remove('note');
    setVoiceUi(null);
  }, ms);
}

// ═══ Запись ═══

// Открывает микрофон под дедлайном. Возвращает {capture}, {error} или
// {abandoned: 'timeout' | 'cancel'} — последний случай ставит таймер либо
// кнопка ×. Опоздавший захват наблюдатель ниже отдаёт сам: без этого трек
// висел бы занятым до перезапуска Mini App, а чат — «в ожидании голоса».
async function openMicUnderDeadline(canned) {
  const attempt = { abandoned: null };
  voiceStartAttempt = attempt;
  let finish;
  const aborted = new Promise(resolve => { finish = resolve; });
  attempt.abort = reason => {
    if (attempt.abandoned) return;
    attempt.abandoned = reason;
    finish({ abandoned: reason });
  };
  attempt.timer = setTimeout(() => attempt.abort('timeout'), voiceStartTimeoutMs);
  const opening = canned
    // Promise.resolve().then(...) держит создание захвата на стороне
    // промиса: синхронный бросок становится отказом claim, а не
    // необработанным исключением прямо из async-вызывающего.
    ? (canned.hangOpen ? new Promise(() => {})
      : Promise.resolve().then(() => openCannedCapture(canned)))
    : openMicCapture();
  const claim = opening.then(capture => ({ capture }), error => ({ error }));
  claim.then(outcome => {
    if (outcome.capture && attempt.abandoned && outcome.capture.release) {
      outcome.capture.release();
    }
  });
  const outcome = await Promise.race([claim, aborted]);
  clearTimeout(attempt.timer);
  // Слот ожидающего освобождён в любом случае: иначе следующий × или
  // повторный старт увидел бы уже похороненный attempt.
  if (voiceStartAttempt === attempt) voiceStartAttempt = null;
  if (attempt.abandoned) return { abandoned: attempt.abandoned };
  return outcome;
}

async function startVoiceRecording() {
  if (voiceState !== 'idle') return;
  if (!bridge) {
    addMessage('error', 'Мост не настроен',
      'Firebase не настроен: впишите apiKey в miniapp/firebase-config.js — '
      + 'голосовое отправить некуда.');
    return;
  }
  const support = voiceSupportError();
  if (support) { addMessage('error', support.title, support.detail); return; }
  if (chatBusy()) {
    addMessage('error', 'Уже жду ответ',
      'Пока предыдущий запрос не получил ответ, второй голосовой не отправим.');
    return;
  }

  voiceState = 'starting';
  setVoiceUi(null);
  // Test-only подмена (?mock=1): реальный микрофон не трогаем совсем.
  const canned = isMock() && window.__voiceTest ? window.__voiceTest.canned : null;
  const outcome = await openMicUnderDeadline(canned);
  if (outcome.abandoned === 'cancel') return;   // × уже снял панель и всё подписал
  if (outcome.abandoned === 'timeout') {
    voiceState = 'idle';
    voiceCapture = null;
    setVoiceUi(null);
    addMessage('error', 'Микрофон не ответил',
      'Доступ к микрофону не подтверждён за '
      + Math.round(voiceStartTimeoutMs / 1000)
      + ' с — запись не началась. Разреши микрофон и повтори, или напиши текстом.');
    return;
  }
  if (outcome.error) {
    const e = outcome.error;
    console.error('voice start:', e);
    voiceState = 'idle';
    voiceCapture = null;
    setVoiceUi(null);
    const code = e && e.code;
    const title = code === 'VOICE_GETUSERMEDIA' ? 'Микрофон не включился'
      : code === 'VOICE_UNSUPPORTED' ? 'Голосовой ввод недоступен'
      : 'Запись не началась';
    addMessage('error', title, String((e && e.message) || e));
    return;
  }
  const capture = outcome.capture;
  voiceCapture = capture;
  // Обрыв трека системой (звонок, Siri, фон) приходит без нашего тапа:
  // обработчик обязан быть навешен ДО перехода в 'recording', иначе
  // onstop застанет состояние сменённым и запись останется «висеть».
  // Сверка идентичности обязательна: опоздавший onstop от уже выброшенного
  // захвата (× во время stop()) иначе оборвал бы следующую запись.
  capture.onEnded = () => {
    if (voiceCapture === capture && voiceState === 'recording') {
      stopVoiceRecording('interrupted');
    }
  };
  voiceState = 'recording';
  setVoiceUi(null);

  voiceTicker = setInterval(() => {
    if (voiceState !== 'recording') return;
    setVoiceUi(null);
  }, 100);
  // Автоостановка по лимиту: на 0,8 с раньше 120 с, чтобы длительность
  // записи не «доползла» за границу, и с объяснением причины в панели.
  voiceDeadline = setTimeout(() => {
    if (voiceState === 'recording') stopVoiceRecording('timeout');
  }, VOICE_MAX_DURATION_SEC * 1000 - VOICE_SAFETY_MARGIN_MS);
}

// Ждёт promise не дольше ms и возвращает {done, value}. done=false — таймаут
// или отказ: оба означают «данных нет», и вызывающий сам отдаёт микрофон.
async function settleWithin(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(
        value => ({ done: true, value }),
        error => { console.warn('voice promise:', error); return { done: false }; }),
      new Promise(resolve => {
        timer = setTimeout(() => resolve({ done: false }), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// reason: 'user' — сам тапнул, 'timeout' — упёрся в лимит 120 с
async function stopVoiceRecording(reason) {
  if (voiceState !== 'recording') return;
  const capture = voiceCapture;
  voiceState = 'stopping';               // второй тап в этот момент бесполезен
  voiceCancelled = false;                // новая остановка — прежняя × не в счёт
  stopVoiceTicker();
  setVoiceUi(null);
  let take = null;
  try {
    if (capture) {
      const stopped = await settleWithin(capture.stop(), VOICE_STOP_TIMEOUT_MS);
      if (!stopped.done && capture.release) capture.release();
      take = stopped.done ? stopped.value : null;
    }
  } catch (e) {
    console.error('voice stop:', e);
  }
  // × во время await перехватил запись: он уже снял панель и подписал
  // «ничего не отправлено». Продолжение обязан молчать — ни пузыря «Запись
  // не удалась», ни возврата куска в review.
  if (voiceCancelled || voiceState !== 'stopping' || voiceCapture !== capture) {
    voiceCapture = null;
    return;
  }
  voiceCapture = null;
  if (!take) {
    voiceState = 'idle';
    addMessage('error', 'Запись не удалась',
      'Браузер не отдал данные микрофона — попробуй ещё раз или напиши текстом.');
    setVoiceUi(null);
    return;
  }
  // Пустой файл — фирменный симптом непрогретого iOS-трека: без прогрева
  // AudioContext Safari отдаёт 0 байт, и это надо объяснить, а не отправить.
  if (take.empty) {
    voiceState = 'idle';
    addMessage('error', 'Запись получилась пустой',
      'Микрофон вернул 0 байт — так WKWebView наказывает за холодный аудиотракт. '
      + 'Закрой Mini App, открой заново и повтори запись.');
    setVoiceUi(null);
    return;
  }
  voiceTake = take;
  voiceState = 'review';
  setVoiceUi(reason === 'timeout'
    ? 'Лимит ' + VOICE_MAX_DURATION_SEC + ' с — запись остановлена автоматически'
    : reason === 'interrupted'
      ? 'Микрофон перехвачен системой — запись остановлена раньше времени'
      : null);
}

function discardVoiceTake(note) {
  voiceTake = null;
  voiceState = 'idle';
  stopVoiceTicker();
  voiceCapture = null;
  // Подсветка микрофона, сдвиг ленты и скрытый «Отправить» живут в классах,
  // которые снимает только setVoiceUi: без него панель «закрылась бы» на
  // 1,8 с позже подписи.
  setVoiceUi(null);
  if (note) showVoiceNote(note);
}

// Отмена активной записи: кусок выбрасывается явно и подпись об этом
// говорит — потерянная запись не уходит «в никуда».
async function cancelVoiceRecording() {
  if (voiceState === 'starting') {
    // Микрофон ещё не получен: панель снимаем сразу, а опоздавшее
    // разрешение отдаст устройство в наблюдателе openMicUnderDeadline.
    // Без этой ветки × молча игнорировался, и чат оставался «занят голосом».
    const attempt = voiceStartAttempt;
    voiceStartAttempt = null;
    if (attempt) attempt.abort('cancel');
    voiceState = 'idle';
    voiceCapture = null;
    setVoiceUi(null);
    showVoiceNote('Микрофон отменён — запись не началась');
    return;
  }
  if (voiceState === 'recording' || voiceState === 'stopping') {
    const capture = voiceCapture;
    voiceState = 'stopping';
    // Останавливающийся stop()/discard() того же куска больше не хозяин:
    // его продолжение по этому флагу уходит молча.
    voiceCancelled = true;
    stopVoiceTicker();
    try {
      if (capture) {
        const stopped = await settleWithin(
          capture.discard ? capture.discard() : capture.stop(),
          VOICE_STOP_TIMEOUT_MS);
        if (!stopped.done && capture.release) capture.release();
      }
    } catch (e) { console.warn('voice discard:', e); }
    voiceCapture = null;
    voiceTake = null;
    voiceState = 'idle';
    setVoiceUi(null);
    showVoiceNote('Запись отменена — ничего не отправлено');
    return;
  }
  if (voiceState === 'review') {
    discardVoiceTake('Запись удалена — ничего не отправлено');
  }
}

// ═══ Отправка ═══

async function confirmVoiceSend() {
  if (voiceState !== 'review' || !voiceTake || voiceSending) return;
  const take = voiceTake;

  // Лимит длительности срезаем ДО отправки: бот отклонил бы и так, но
  // 20 МБ из бот/voice.py сюда не применим — потолок у одной записи RTDB.
  if (take.durationSec > VOICE_MAX_DURATION_SEC) {
    discardVoiceTake(null);
    addMessage('error', 'Голосовое слишком длинное',
      'Максимум ' + VOICE_MAX_DURATION_SEC + ' с, а записано '
      + take.durationSec + ' с. Запись не отправлена: сократи и повтори.');
    return;
  }

  // Потолок базы отсекаем ДО кодирования: base64 длиннее аудио ровно в 4/3,
  // а blobToBase64 — синхронный цикл по всему буферу, который на длинной
  // iOS-записи (audio/mp4 не ограничен VOICE_BITS_PER_SECOND) вешает
  // главный поток. Оценка грубая, проверка после кодирования — настоящая.
  if (take.bytes && Math.ceil(take.bytes / 3) * 4 > VOICE_MAX_B64_BYTES) {
    addMessage('error', 'Голосовое слишком большое',
      'Запись весит ' + (take.bytes / 1024 / 1024).toFixed(1)
      + ' МБ, а потолок одного запроса — 2.6 МБ после base64. Сократи запись'
      + ' (сейчас ' + take.durationSec + ' с) и повтори.');
    discardVoiceTake(null);
    return;
  }

  voiceSending = true;
  setVoiceUi('Упаковываю запись…');
  let oggB64 = take.oggB64 || '';
  if (!oggB64) {
    try {
      oggB64 = await blobToBase64(take.blob);
    } catch (e) {
      console.error('voice encode:', e);
      voiceSending = false;
      addMessage('error', 'Не удалось упаковать запись',
        String((e && e.message) || e) + ' — попробуй ещё раз.');
      // Кусок остаётся в review и поддаётся повтору, только если его не
      // выбросили во время await. Прошлый тест «idle и пусто» совпадал с
      // подписью discardVoiceTake и воскрешал отменённую запись.
      if (voiceState !== 'review' || voiceTake !== take) return;
      setVoiceUi(null);
      return;
    }
    // Отмена (× или свайп) во время кодирования уже перевела состояние в
    // idle и подписала «ничего не отправлено». Без этой проверки продолжение
    // всё равно записало бы запрос в очередь — и врало бы пользователю.
    if (voiceState !== 'review' || voiceTake !== take) {
      voiceSending = false;
      return;   // × уже подписал «ничего не отправлено», новый старт перекрасит сам
    }
  }

  // Второй клиентский лимит: размер ПОСЛЕ base64 (> 2.6 МБ запись RTDB не
  // примет). Отсекаем здесь, до любой попытки записать запрос в очередь.
  if (oggB64.length > VOICE_MAX_B64_BYTES) {
    voiceSending = false;
    discardVoiceTake(null);
    addMessage('error', 'Голосовое слишком большое',
      'После base64 вышло ' + (oggB64.length / 1024 / 1024).toFixed(1)
      + ' МБ, а потолок одного запроса — 2.6 МБ. Сократи запись (сейчас '
      + take.durationSec + ' с) и повтори.');
    return;
  }

  const chat = currentChat();
  if (!chat) { voiceSending = false; setVoiceUi(null); return; }
  if (pendingIdsForChat(chat.id).length) {
    voiceSending = false;
    voiceState = 'review';
    setVoiceUi(null);
    addMessage('error', 'Уже жду ответ',
      'В этом чате есть незавершённый запрос — дождись ответа или нажми «Стоп».');
    return;
  }

  // Свой пузырь в ленте — как текстовый запрос, только про голос
  const text = voiceBubbleText(take.durationSec);
  const voiceMsg = { role: 'user', text, ts: Date.now(), voice: { durationSec: take.durationSec }, pending: true };
  chat.messages.push(voiceMsg);
  if (chat.id === currentChatId) { hideEmpty(); appendMessage(voiceMsg); scrollFeed(true); }
  touchChat(chat, text);
  persistChats();
  renderRecents();

  voiceTake = null;
  voiceState = 'idle';
  setVoiceUi(null);
  showVoiceNote('Отправляю голосовое…');

  await deliverVoice(voiceMsg, chat, oggB64, take.durationSec);
}

// Запись уже принятого куска в очередь bridge/requests. Общий хвост для
// первой отправки (confirmVoiceSend) и повтора из неотправленного пузыря
// (resendFailedVoice). При отказе сообщение помечается failed и остаётся в
// ленте с явной пометкой «не отправлено» + действиями «Повторить/Убрать» —
// но никогда не выглядит отправленным.
async function deliverVoice(voiceMsg, chat, oggB64, durationSec) {
  voiceSending = true;
  // Заявка в pending до отправки — как у текстового пути (G1): «Стоп» и блокировка
  // чата живут тем же pending с первой секунды, а не с подтверждения записи.
  const requestId = reserveRequestId();
  trackRequest(requestId, chat.id, voiceMsg);
  try {
    // Тот же путь, что у текста: initData, requestSettings(), та же очередь
    await sendToBridge(requestId, '', requestSettings(), { oggB64, durationSec });
    if (settingsDropped) {
      settingsDropped = false;
      addMessage('error', 'Настройки не приняты базой',
        'Голосовой запрос отправлен без settings — обновите правила RTDB '
        + '(FIREBASE_SETUP.md §6.1).', chat.id);
    }
    if (voiceRetry && voiceRetry.msg === voiceMsg) voiceRetry = null;
  } catch (e) {
    untrackRequest(requestId);
    console.error('voice sendRequest:', e);
    voiceMsg.pending = false;
    voiceMsg.failed = true;                 // пузырь: явная пометка и действия
    voiceRetry = { msg: voiceMsg, oggB64, durationSec, chatId: chat.id };
    persistChats();
    if (chat.id === currentChatId) renderMessages();
    renderRecents();
    const d = describeSendFailure(e, 'голосовое сообщение', 'Голосовое не отправлено');
    addMessage('error', d.title, d.detail, chat.id);
    updateTyping();
  } finally {
    voiceSending = false;
    setVoiceUi(null);
  }
}

// Повтор из неотправленного пузыря: тот же base64 (он живёт только в памяти
// этой сессии), та же очередь. После успеха слот voiceRetry освобождается.
async function resendFailedVoice(msg) {
  if (!voiceRetry || voiceRetry.msg !== msg || voiceSending) return;
  const chat = chats.find(c => c.id === voiceRetry.chatId);
  if (!chat) { voiceRetry = null; return; }
  if (chatBusy(chat.id)) {
    addMessage('error', 'Уже жду ответ',
      'В этом чате есть незавершённый запрос — дождись ответа или нажми «Стоп».',
      chat.id);
    return;
  }
  const { oggB64, durationSec } = voiceRetry;
  msg.pending = true;
  msg.failed = false;
  persistChats();
  if (chat.id === currentChatId) renderMessages();
  await deliverVoice(msg, chat, oggB64, durationSec);
}

// Убрать неотправленный голосовой пузырь из ленты и истории
function removeFailedVoice(msg) {
  if (voiceRetry && voiceRetry.msg === msg) voiceRetry = null;
  for (const c of chats) {
    const i = c.messages.indexOf(msg);
    if (i < 0) continue;
    c.messages.splice(i, 1);
    persistChats();
    if (c.id === currentChatId) renderMessages();
    renderRecents();
    return;
  }
}

// Пузырь «… отправляется» гаснет, как только мост отреагировал на запрос
function settleVoicePending(p) {
  if (!p || !p.voiceMsg) return;
  const msg = p.voiceMsg;
  p.voiceMsg = null;
  if (!msg.pending) return;
  msg.pending = false;
  const chat = chats.find(c => c.id === p.chatId);
  if (chat) persistChats();
  if (p.chatId === currentChatId) renderMessages();
}

function onMicTap() {
  if (voiceState === 'idle') { startVoiceRecording(); return; }
  if (voiceState === 'starting') {
    setVoiceUi('Жду разрешение на микрофон…');
    return;
  }
  if (voiceState === 'recording') { stopVoiceRecording('user'); return; }
  // Остановленную запись отправляем кнопкой ✓ в панели: тап по микрофону
  // её не затирает, иначе подтверждение отправки терялось бы молча.
  if (voiceState === 'review') setVoiceUi('Сначала отправь ✓ или отмени ×');
}

function wireVoiceEvents() {
  const el = voiceEls();
  if (!el.mic) return;
  el.mic.addEventListener('click', onMicTap);
  // × одна и та же: отменить активную запись либо выбросить ещё не
  // отправленный кусок — в обоих случаях с явной подписью в панели
  el.cancel.addEventListener('click', cancelVoiceRecording);
  el.send.addEventListener('click', confirmVoiceSend);

  // Смахивание панелью влево — тот же отказ, что и ×
  let startX = null;
  el.bar.addEventListener('pointerdown', e => { startX = e.clientX; });
  el.bar.addEventListener('pointerup', e => {
    if (startX === null) return;
    const dx = e.clientX - startX;
    startX = null;
    if (dx <= -60) cancelVoiceRecording();
  });
  el.bar.addEventListener('pointercancel', () => { startX = null; });

  setVoiceUi(null);
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
  } else if (msg.voice) {
    // Свой голосовой запрос: не голая строка, а пузырь с длительностью.
    // Base64 в историю не кладём — в localStorage ему не место (2.6 МБ).
    b.classList.add('bubble-voice');
    if (msg.failed) b.classList.add('bubble-voice-failed');
    const mic = document.createElement('span');
    mic.className = 'v-mic';
    mic.setAttribute('aria-hidden', 'true');
    mic.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" '
      + 'stroke="currentColor" stroke-width="2" stroke-linecap="round">'
      + '<rect x="9" y="3" width="6" height="11" rx="3"/>'
      + '<path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
    const label = document.createElement('span');
    label.className = 'v-label';
    label.textContent = VOICE_BUBBLE_PREFIX + ' · ';
    const dur = document.createElement('b');
    dur.textContent = Math.max(1, Math.round(msg.voice.durationSec || 0)) + ' с';
    const wave = document.createElement('span');
    wave.className = 'v-wave';
    wave.setAttribute('aria-hidden', 'true');
    b.append(mic, label, dur, wave);
    if (msg.failed) {
      // Не принят базой: явно «не отправлено» + действия. Не выглядит
      // отправленным ни в ленте, ни после перезагрузки (флаг в истории).
      const badge = document.createElement('span');
      badge.className = 'v-failed-badge';
      badge.textContent = 'не отправлено';
      const acts = document.createElement('span');
      acts.className = 'v-acts';
      if (voiceRetry && voiceRetry.msg === msg) {
        const again = document.createElement('button');
        again.type = 'button';
        again.className = 'v-act v-act-retry';
        again.textContent = 'Повторить';
        again.addEventListener('click', () => resendFailedVoice(msg));
        acts.appendChild(again);
      }
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'v-act';
      rm.textContent = 'Убрать';
      rm.addEventListener('click', () => removeFailedVoice(msg));
      acts.appendChild(rm);
      b.append(badge, acts);
    }
  } else {
    b.textContent = msg.text;
  }
  const time = document.createElement('span');
  time.className = 'msg-time';
  time.textContent = fmtTime(msg.ts) + (msg.stopped ? ' · остановлено' : '')
    + (msg.pending ? ' · отправляется…' : '');
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
  // Тот же предикат, что у композера: охват — все чаты, и ждём ровно пока нет
  // стрим-пузыря (частичный ответ уже виден в ленте).
  const waiting = awaitingReply({ anyChat: true, unstreamedOnly: true });
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
    // Отдельная кнопка меню чата («Очистить» / «Удалить»): сосед элемент в
    // li, а не вложенность в <button> — вложенный button невалиден и не
    // ловил бы тап. Свой 44px тап-цель, тап не переключает чат.
    const menu = document.createElement('button');
    menu.type = 'button';
    menu.className = 'recent-menu';
    menu.dataset.chat = c.id;
    menu.setAttribute('aria-label', 'Действия с чатом: ' + c.title);
    menu.title = 'Действия с чатом';
    menu.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/></svg>';
    menu.addEventListener('click', () => openChatSheet(c.id));
    li.append(btn, menu);
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

/* ── Меню чата: «Очистить» и «Удалить» ─────────────────────────────── */
// Две РАЗНЫЕ кнопки в одном BottomSheet (тот же механизм openSheet, что у
// выбора модели): очистка оставляет чат в Recents, удаление убирает его
// вместе с историей. Оба действия необратимы, поэтому каждое требует
// второй тап-подтверждение — тот же приём, что у «Удалить проект».

const CHAT_ACTIONS = {
  clear:  { btn: 'btnChatClear',  title: 'Очистить сообщения',
            armed: 'Подтвердить очистку?' },
  delete: { btn: 'btnChatDelete', title: 'Удалить чат',
            armed: 'Точно удалить чат?' },
};
const CHAT_HINT_DEFAULT = 'Чаты и история лежат только на этом устройстве, '
  + 'действие необратимо. Нажмите его ещё раз, чтобы подтвердить.';
const CHAT_ARM_MS = 4000;   // подтверждение «протухает», если передумали

let chatSheetId = null;    // чат, к которому открыт лист
let chatArm = null;        // 'clear' | 'delete' — ждём второй тап
let chatArmTimer = null;

function pluralMessages(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'сообщение';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'сообщения';
  return 'сообщений';
}

function setChatSheetHint(text) {
  const el = document.getElementById('chatSheetHint');
  if (el) el.textContent = text || CHAT_HINT_DEFAULT;
}

function openChatSheet(id) {
  const chat = chatById(id);
  if (!chat) return;
  chatSheetId = id;
  const n = (chat.messages || []).length;
  document.getElementById('chatSheetTitle').textContent = chat.title;
  document.getElementById('chatSheetSub').textContent =
    n ? n + ' ' + pluralMessages(n) : 'Чат уже пуст';
  disarmChatActions();
  // Чистить нечего — кнопка не должна притвораться живой
  document.getElementById('btnChatClear').disabled = n === 0;
  openSheet('sheetChat');
}

function disarmChatActions() {
  if (chatArmTimer) { clearTimeout(chatArmTimer); chatArmTimer = null; }
  chatArm = null;
  for (const kind of ['clear', 'delete']) {
    const a = CHAT_ACTIONS[kind];
    const btn = document.getElementById(a.btn);
    if (!btn) continue;
    btn.classList.remove('armed');
    btn.querySelector('.ca-title').textContent = a.title;
  }
  setChatSheetHint(CHAT_HINT_DEFAULT);
}

// Первый тап — только подтверждение (кнопка краснеет и меняет подпись),
// второй — действие. Таймаут и закрытие листа снимают подтверждение.
function tapChatAction(kind) {
  const a = CHAT_ACTIONS[kind];
  if (!a || !chatSheetId) return;
  if (!chatById(chatSheetId)) { closeSheet(); return; }
  // Пока голос в работе, чат трогать нельзя: пузырь и settings чата
  // привязываются только в момент ✓, поэтому смена «текущего» чата между
  // записью и отправкой утопила бы запись в чужом чате с чужими настройками.
  // Отправка (voiceSending) — тот же случай: запрос ещё не в pending, и его
  // пузырь нельзя честно снять.
  if (voiceSending || voiceState !== 'idle') {
    setChatSheetHint('Голосовое ещё не отправлено — сначала ✓ или ×.');
    return;
  }
  if (chatArm !== kind) {
    disarmChatActions();
    chatArm = kind;
    const btn = document.getElementById(a.btn);
    btn.classList.add('armed');
    btn.querySelector('.ca-title').textContent = a.armed;
    setChatSheetHint('«' + chatById(chatSheetId).title + '»: нажмите «'
      + a.armed + '» ещё раз — история не вернётся.');
    chatArmTimer = setTimeout(disarmChatActions, CHAT_ARM_MS);
    return;
  }
  const id = chatSheetId;
  disarmChatActions();
  closeSheet();
  if (kind === 'clear') clearChat(id); else deleteChat(id);
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
  // Подтверждение необратимого действия не должно переживать закрытие листа
  if (openedSheet === 'sheetChat') { disarmChatActions(); chatSheetId = null; }
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
  document.getElementById('setMaxTokens').value = settings.max_tokens;
  document.getElementById('maxTokensValue').textContent = settings.max_tokens;
  document.getElementById('setShiftEnter').checked = settings.shiftEnter;
}

function applySettingsForm() {
  settings.context = Number(document.getElementById('setContext').value);
  settings.temperature = Number(document.getElementById('setTemperature').value);
  settings.max_tokens = Number(document.getElementById('setMaxTokens').value);
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

/* ── Уровень размышлений ───────────────────────────────────────────── */

// BottomSheet в стиле выбора модели: три уровня (low|medium|high), без
// «xhigh» — бэкенд и правила RTDB принимают ровно эти три значения.
function renderReasoning() {
  const ul = document.getElementById('reasoningList');
  ul.innerHTML = '';
  for (const r of REASONING_EFFORTS) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'model-item' + (settings.reasoning_effort === r.id ? ' selected' : '');
    btn.dataset.effort = r.id;
    btn.innerHTML = '<span class="m-radio"></span>';
    const body = document.createElement('span');
    body.className = 'm-body';
    const n = document.createElement('div'); n.className = 'm-name'; n.textContent = r.full;
    const s = document.createElement('div'); s.className = 'm-sub'; s.textContent = r.sub;
    body.append(n, s);
    btn.appendChild(body);
    btn.addEventListener('click', () => {
      settings.reasoning_effort = r.id;
      saveSettings();
      renderReasoningChip();
      closeSheet();
    });
    li.appendChild(btn);
    ul.appendChild(li);
  }
}

function renderReasoningChip() {
  const r = REASONING_EFFORTS.find(x => x.id === settings.reasoning_effort)
    || REASONING_EFFORTS[1];
  const el = document.getElementById('settingsReasoningName');
  if (el) el.textContent = r.id === 'medium' ? r.name + ' (умолч.)' : r.name;
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

// Единая реализация предиката «ждём ответ» (G2). Раньше updateTyping считал ожидание
// по ВСЕМ чатам, а updateSendButton — по ТЕКУЩЕМУ: две копии одного правила
// разъезжались при каждой правке. Теперь охват (текущий чат / все чаты) и учёт
// начавшегося стрима — параметры, а логика одна.
function pendingIdsFor({ chatId = currentChatId, anyChat = false } = {}) {
  return [...pending.keys()].filter(id => anyChat || pending.get(id).chatId === chatId);
}

function awaitingReply({ chatId = currentChatId, anyChat = false, unstreamedOnly = false } = {}) {
  return pendingIdsFor({ chatId, anyChat })
    .some(id => !unstreamedOnly || !streams.has(id));
}

// Совместимость со старыми вызовами: список id одного чата.
const pendingIdsForChat = (chatId = currentChatId) => pendingIdsFor({ chatId });

// Пока текущий чат ждёт ответа, «Отправить» уступает место «Стоп»:
// второй запрос из одного чата в очередь не ставим (у бота это гонка
// за один и тот же контекст). Во время голосовой записи отправки нет
// вообще — панель записи диктует свои кнопки (✓/×).
// Чистое (без DOM) состояние композера — единственная инкарнация правила «чат ждёт
// ответа -> „Отправить“ уступает место „Стоп“». Её проверяет unit-тест
// miniapp/test/composer_state.test.mjs без браузера; updateSendButton только переносит
// эти же флаги в атрибуты кнопок.
function composerButtonsState({ waiting = false, recording = false, hasText = false } = {}) {
  const stopActive = Boolean(waiting) && !Boolean(recording);
  return {
    sendHidden: Boolean(waiting) || Boolean(recording),
    stopHidden: !stopActive,
    // «Стоп» недоступен, когда останавливать нечего: видимость и доступность
    // зеркалят друг друга, двойной тап не может плодить состояние отмены
    stopDisabled: !stopActive,
    sendDisabled: !hasText || Boolean(recording),
  };
}

function updateSendButton() {
  const send = document.getElementById('btnSend');
  const stop = document.getElementById('btnStop');
  const mic = document.getElementById('btnMic');
  const recording = voiceState === 'recording' || voiceState === 'starting'
    || voiceState === 'stopping';
  const state = composerButtonsState({
    waiting: awaitingReply(),
    recording,
    hasText: Boolean(document.getElementById('input').value.trim()),
  });
  send.hidden = state.sendHidden;
  stop.hidden = state.stopHidden;
  stop.disabled = state.stopDisabled;
  send.disabled = state.sendDisabled;
  // Микрофон не прячем даже в ожидании ответа: тап даёт внятный отказ (chatBusy),
  // а не «мёртвую» исчезнувшую кнопку. Блокируем его только на время упаковки и
  // отправки выбранного куска.
  if (mic) mic.disabled = voiceSending;
}

// Отмена — локальная: у моста нет канала отмены, бот доработает запрос
// и запишет ответ, но pending уже пуст, поэтому handleResponse/Partial
// его проигнорируют. Уже полученный partial остаётся в ленте с пометкой.
function stopPending() {
  let canceled = false;
  for (const id of pendingIdsForChat()) {
    const p = pending.get(id);
    clearTimeout(p.timer);
    pending.delete(id);
    canceled = true;
    // Голосовой пузырь не должен остаться «отправляется» после отмены
    settleVoicePending(p);
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
  // Идемпотентность: второй тап не находит заявок в pending — но состояние композера
  // всё равно сверяем, а не выходим молча.
  if (!canceled) { updateSendButton(); return; }
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

  // Меню чата (лист из Recents): два необратимых действия, каждое с
  // подтверждением вторым тапом — см. tapChatAction
  document.getElementById('btnChatClear').addEventListener('click',
    () => tapChatAction('clear'));
  document.getElementById('btnChatDelete').addEventListener('click',
    () => tapChatAction('delete'));

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
  document.getElementById('btnOpenReasoning').addEventListener('click', () => { renderReasoning(); openSheet('sheetReasoning'); });
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
  document.getElementById('setMaxTokens').addEventListener('input', e =>
    document.getElementById('maxTokensValue').textContent = e.target.value);

  wireVoiceEvents();
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
  renderReasoningChip();
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

// Test-only хук голосового ввода — только в демо-режиме (?mock=1):
//   window.__voiceTest.setCanned({oggB64, durationSec})  — готовый base64
//   window.__voiceTest.setCanned({blob, durationSec})    — свой Blob
//   window.__voiceTest.setCanned({empty: true})          — нулевой файл
//     (симптом непрогретого iOS-трека)
//   window.__voiceTest.setCanned({oggB64, hangStop: true}) — stop()/discard()
//     не резолвятся (зависший onstop), проверка дедлайна и release()
//   window.__voiceTest.setCanned({oggB64, hangOpen: true}) — микрофон не
//     открывается никогда (зависший промпт WKWebView): проверка дедлайна
//     старта и того, что × и текст чата снова работают
//   window.__voiceTest.clear()                           — снова настоящий
//     микрофон
//   window.__voiceTest.capture()                         — живой захват:
//     через capture().onEnded() E2E симулирует обрыв трека системой
//   window.__voiceTest.setStartTimeout(ms)               — укоротить ожидание
//     микрофона, иначе ветка «не ответил» проверялась бы 12 с
// Дальше путь настоящий: тап #btnMic → запись → ✓ → лимиты → base64 →
// bridge/requests → ответ по bridge/responses. Продакшн-ветку
// (openMicCapture/getUserMedia/AudioContext) хук не трогает: он подменяет
// только источник данных захвата, интерфейс {elapsedSec, stop, discard,
// release}; счётчик releases — сколько раз путь остановки до дедлайна
// отдавал микрофон вручную.
if (isMock()) {
  window.__voiceTest = {
    canned: null,
    releases: 0,           // сколько раз захват отдали микрофон вручную
    setCanned(c) { this.canned = c || null; return this.canned; },
    clear() { this.canned = null; },
    state: () => voiceState,
    take: () => voiceTake,
    capture: () => voiceCapture,
    sending: () => voiceSending,
    // Короткий дедлайн ожидания микрофона, чтобы ветка «микрофон не ответил»
    // проверялась за десятки миллисекунд, а не за 12 с реального ожидания.
    setStartTimeout(ms) { voiceStartTimeoutMs = Number(ms) > 0 ? Number(ms) : VOICE_START_TIMEOUT_MS; },
    start: () => startVoiceRecording(),
    stop: () => stopVoiceRecording('user'),
    cancel: () => cancelVoiceRecording(),
    send: () => confirmVoiceSend(),
  };
}

boot();
