import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { COLS, STAT_COLS, MODEL, STEPS } from "./constants.js";
import { courtArchiveCandidates, courtArchiveStats } from "./courtArchive.js";
import {
  closeResearchSession,
  createResearchSession,
  enrichCompanyWithGoogleAI,
  launchResearchBrowser,
  verifyPhoneForCompanyWithGoogleAI
} from "./googleAiAgent.js";

const OPENAI_MAX_OUTPUT_TOKENS = Math.max(
  1000,
  Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || 128000)
);
const RESEARCH_MAX_OUTPUT_TOKENS = Math.min(50000, OPENAI_MAX_OUTPUT_TOKENS);
const FINAL_BATCH_MAX_OUTPUT_TOKENS = Math.min(50000, OPENAI_MAX_OUTPUT_TOKENS);
const FINAL_QA_MAX_OUTPUT_TOKENS = Math.min(30000, OPENAI_MAX_OUTPUT_TOKENS);
const TARGETED_SEARCH_MAX_OUTPUT_TOKENS = Math.min(8000, OPENAI_MAX_OUTPUT_TOKENS);
const STATISTICS_MAX_OUTPUT_TOKENS = Math.min(12000, OPENAI_MAX_OUTPUT_TOKENS);
const FINAL_BATCH_MODEL = process.env.FINAL_BATCH_MODEL || "gpt-5.6-luna";
const TARGETED_SEARCH_MODEL = process.env.TARGETED_SEARCH_MODEL || "gpt-5.6-luna";
const FINAL_QA_MODEL = process.env.FINAL_QA_MODEL || "gpt-5.6-luna";
const CONFLICT_MODEL = process.env.CONFLICT_MODEL || "gpt-5.6-sol";
const COURT_ARCHIVE_MODEL = process.env.COURT_ARCHIVE_MODEL || "gpt-5.6-luna";
const COURT_VECTOR_STORE_ID = String(process.env.COURT_VECTOR_STORE_ID || "").trim();
const COURT_FILE_SEARCH_MAX_RESULTS = Math.max(
  5,
  Math.min(50, Number(process.env.COURT_FILE_SEARCH_MAX_RESULTS || 40))
);
const GOOGLE_AI_SOL_RETRY_PRIORITY_AB =
  String(process.env.GOOGLE_AI_SOL_RETRY_PRIORITY_AB || "true").toLowerCase() !== "false";
const RESEARCH_SOFT_TARGET = Math.max(
  40,
  Math.min(200, Number(process.env.OPENAI_RESEARCH_SOFT_TARGET || 100))
);
const RESEARCH_MAX_RECOVERY_BRANCHES = Math.max(
  0,
  Math.min(5, Number(process.env.OPENAI_RESEARCH_MAX_RECOVERY_BRANCHES || 3))
);
const RESEARCH_LOW_YIELD_THRESHOLD = Math.max(
  0,
  Math.min(10, Number(process.env.OPENAI_RESEARCH_LOW_YIELD_THRESHOLD || 3))
);
const RESEARCH_MICRO_MAX_OUTPUT_TOKENS = Math.min(
  16000,
  OPENAI_MAX_OUTPUT_TOKENS
);
const RESEARCH_GEO_GROUPS = Math.max(
  2,
  Math.min(5, Number(process.env.OPENAI_RESEARCH_GEO_GROUPS || 3))
);

const STAGE_SEARCH_BRANCHES = [
  [
    "Объявления о продаже/покупке прицепной техники: от собственника, с НДС, продаём парк, несколько единиц, обновление парка",
    "Зерно, зерновозы, агроперевозки и объявления/вакансии компаний, работающих с зерновыми и масличными",
    "Щебень, песок, ПГС, карьеры, самосвальные перевозки и владельцы/эксплуатанты соответствующего парка",
    "Щепа, опилки, кора, биомасса, пеллетное сырьё: перевозки, объявления и вакансии",
    "Отходы, вторсырьё, металлолом и вторчермет: перевозки, объявления и вакансии",
    "Вакансии водителей категории CE/Е у компаний региона с тяжёлой логистикой",
    "Вакансии главных механиков, начальников АТП/гаража/автоколонны, механиков и транспортных специалистов",
    "Вакансии логистов/диспетчеров плюс цепочки работодателей, продавцов техники и связанных перевозчиков"
  ],
  [
    "Лизинг прицепной техники и полуприцепов у компаний региона с целевыми грузами",
    "Лизинговые сообщения одновременно по тягачам и прицепному парку; идентификация лизингополучателей",
    "Конкретные модели, VIN, госномера и предметы финансовой аренды",
    "Сроки окончания финансовой аренды, завершение договоров и цикл замены техники",
    "Возврат, изъятие, реализация и торги по лизинговой грузовой/прицепной технике",
    "Повторные сделки, расширение и обновление грузового парка",
    "Залоги конкретной техники после идентификации VIN/модели; банки, Федресурс, реестры и официальные документы"
  ],
  [
    "Сервисы грузовой прицепной техники и их публичные клиенты/кейсы",
    "Гидравлика, гидроцилиндры, системы разгрузки и клиенты ремонтов",
    "Ремонт кузовов, рам, осей, тормозов и подвески; повторные дорогие ремонты",
    "Поставщики запчастей и дилеры прицепной техники с кейсами конкретных клиентов",
    "Грузовые шинные центры и телематика как точки выхода на эксплуатантов тяжёлого транспорта",
    "Экспедиторы и логистические посредники; отделять посредников от собственных эксплуатантов",
    "Карты, каталоги, тендеры, портфолио, отзывы, фото и новости сервисов для поиска новых клиентов"
  ],
  [
    "Перевозчики зерна, масличных, комбикорма и других агрогрузов",
    "Перевозчики щебня, песка, ПГС, грунта, торфа и строительных сыпучих грузов",
    "Перевозчики щепы, опилок, древесных отходов, биомассы",
    "Перевозчики отходов, вторсырья, металлолома и вторчермета",
    "Перевозчики крупных грузовладельцев региона: искать цепочку грузовладелец → фактический перевозчик",
    "Автопарки, тягачи, прицепная техника, вакансии CE/Е, ремонт, продажа и расширение парка у найденных перевозчиков"
  ],
  [
    "Закупки прицепной техники, полуприцепов, тягачей и комплектов автопоезда",
    "Закупки ремонта прицепной техники, рам, кузовов, гидравлики, осей, тормозов и подвески",
    "Закупки систем разгрузки и запасных частей с идентификацией заказчика/эксплуатанта",
    "Закупки перевозки зерна, щебня, песка, отходов, древесных грузов и других целевых грузов",
    "Новые крупные транспортные контракты и победители, которые могут фактически выполнять перевозку",
    "Контракты и проекты, создающие дополнительный грузопоток и потребность в расширении/замене парка"
  ],
  [
    "Агрохолдинги, растениеводческие хозяйства, КФХ/СПК с товарным потоком и физической логистикой",
    "Элеваторы, ХПП, зернохранилища, зернотрейдеры с физической логистикой",
    "Комбикормовые, мукомольные предприятия, переработчики масличных и производители масел",
    "Карьеры, щебзаводы, нерудные материалы, песок, ПГС и добывающие предприятия",
    "Дорожные ремонтно-строительные компании, АБЗ и крупные стройкомпании с потоком сыпучих материалов",
    "Торфодобывающие предприятия",
    "Лесные хозяйства, лесозаготовители, лесопилки и деревообработка",
    "Фанерные/плитные производства, ДСП/ЛДСП, ЦБК",
    "Пеллетные производства, биомасса, щепа, опилки и древесные отходы",
    "Переработчики отходов, вторсырья, мусоросортировка и мусоропереработка",
    "Перевозчики промышленных/бытовых отходов, металлолом и вторчермет",
    "Промышленные предприятия с крупными регулярными потоками сыпучих/объёмных грузов; параллельно искать их постоянных перевозчиков"
  ],
  [
    "Превышение массы и осевой нагрузки, автоматический весогабаритный контроль, ущерб дорогам",
    "Тяжёлые автопоезда: тягач + полуприцеп, марки/модели, VIN и госномера",
    "Собственник, лизингополучатель, арендатор и фактический эксплуатант в судебных/административных материалах",
    "Споры по лизингу, возврату и изъятию грузовой/прицепной техники",
    "Споры по ремонту прицепной техники, рам, кузовов, гидравлики, осей и подвески",
    "ДТП и страховые споры, где идентифицируются техника, маршрут, груз и эксплуатант"
  ],
  [
    "Выставки коммерческого транспорта и списки участников",
    "Аграрные мероприятия, зерновые и элеваторные конференции",
    "Лесные и деревообрабатывающие выставки/конференции",
    "Мероприятия по отходам, переработке, вторсырью и металлолому",
    "Союзы перевозчиков и транспортные профессиональные сообщества",
    "Отраслевые объединения грузовладельцев; из участников извлекать конкретные компании и затем проверять логистику"
  ],
  [
    "Расширение агрохолдингов, новые элеваторы/зернохранилища, рост производства зерна и масличных",
    "Новые комбикормовые, мукомольные и маслоперерабатывающие мощности",
    "Новые/расширяющиеся карьеры и рост добычи нерудных материалов",
    "Дорожные и инфраструктурные проекты, создающие потоки сыпучих материалов",
    "Расширение торфодобычи",
    "Рост лесопиления/деревообработки, новые плитные, ДСП/ЛДСП и пеллетные мощности",
    "Новые мощности по отходам, вторсырью, металлолому и вторчермету"
  ]
];

const RESEARCH_RECOVERY_THEMES = [
  "Географические пробелы: отдельно пройди областной центр, малые города, районы, промзоны и локальные кластеры, которые были слабо представлены.",
  "Источник и синонимы: смени поисковые формулировки, площадки, должности, названия грузов/процессов и ищи long tail, которого нет в уже найденном списке.",
  "Цепочки второго порядка: от найденных грузовладельцев иди к перевозчикам; от сервисов к клиентам; от проектов к подрядчикам/эксплуатантам; от лизинга/тендеров к фактическим пользователям."
];
const FINAL_BATCH_SIZE = Math.max(
  20,
  Math.min(100, Number(process.env.OPENAI_FINAL_BATCH_SIZE || 60))
);

function parseJson(text) {
  const cleaned = String(text || "")
    .trim()
    .replace(/^\`\`\`(?:json)?\s*/i, "")
    .replace(/\s*\`\`\`$/i, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error("Ответ модели не удалось разобрать как JSON");
  }
}

function contract(final = false) {
  if (final) {
    return `\n\nТЕХНИЧЕСКИЙ ФОРМАТ: верни ТОЛЬКО валидный JSON без markdown:
{"direct_buyers":[],"intermediaries":[],"leasing":[],"statistics":[]}.
Коммерческие объекты содержат ключи: ${COLS.map((x) => `"${x}"`).join(", ")}, а также служебный ключ "__comment".
"__comment" — текст Excel-примечания для ячейки первого столбца "Организация". Он обязателен для каждой коммерческой организации и должен содержать отдельными строками: "Сайт/источник:", "ИНН:", "Деятельность:", "Холдинг/УК/группа:", "Email:". Этот служебный ключ не является колонкой XLSX.
Статистика содержит ровно ключи: ${STAT_COLS.map((x) => `"${x}"`).join(", ")}.
Не добавляй видимое поле/колонку "Источник". Если значения нет — пустая строка; в "__comment" для неподтвержденных сведений явно укажи "не подтверждено" или "не найден".`;
  }

  return `\n\nТЕХНИЧЕСКИЙ ФОРМАТ: верни ТОЛЬКО валидный JSON без markdown:
{"direct_buyers":[],"intermediaries":[],"leasing":[]}.
Каждый объект содержит видимые ключи: ${COLS.map((x) => `"${x}"`).join(", ")}, а также служебный "__evidence".
"__evidence" не является колонкой XLSX и имеет формат:
{"source_urls":[],"official_site":"","email":"","holding_source":"","notes":[]}.
Сохраняй в "__evidence" уже найденные при web_search URL первичных/наиболее сильных источников, официальный сайт, публичный e-mail и краткие подтверждающие заметки. Не выполняй отдельный поиск только ради заполнения "__evidence": сохраняй то, что уже встретилось в ходе текущего исследования.
Не добавляй видимое поле "Источник". Если значения нет — пустая строка. Не выдумывай данные.`;
}

function finalBatchContract() {
  return `\n\nПАКЕТНЫЙ ТЕХНИЧЕСКИЙ ФОРМАТ: верни ТОЛЬКО валидный JSON без markdown:
{"direct_buyers":[],"intermediaries":[],"leasing":[]}.
На входе находятся CANONICAL-компании. Каждую входную canonical-компанию верни РОВНО ОДИН РАЗ и обязательно сохрани её "__canonical_id".
Не удаляй компанию на этом этапе. Если она кажется нерелевантной, верни её как обычно и добавь "__decision":"exclude" и краткий "__decision_reason"; окончательное удаление выполняется только глобальным QA.
Для каждой canonical-компании используй ВСЕ элементы массива evidence как единый набор доказательств. Не теряй сведения из отдельных шагов.
Этот пакет обрабатывается БЕЗ web_search: не требуй нового поиска и не придумывай отсутствующие факты. Сначала используй сохранённый "__evidence" из шагов 1–9.
Каждый коммерческий объект содержит ключи: ${COLS.map((x) => `"${x}"`).join(", ")}, "__comment", "__canonical_id", "__decision", "__decision_reason".
"__comment" обязателен и содержит ровно пять смысловых строк: "Сайт/источник:", "ИНН:", "Деятельность:", "Холдинг/УК/группа:", "Email:".
Не возвращай статистику. Не выдумывай данные.`;
}

function finalQaContract() {
  return `\n\nФИНАЛЬНЫЙ QA — верни ТОЛЬКО валидный JSON без markdown:
{
  "remove_ids": [],
  "moves": [{"id":"","sheet":"direct_buyers|intermediaries|leasing"}],
  "patches": [{"id":"","fields":{}}]
}
Не возвращай полный список компаний и не выполняй web_search.
remove_ids — только строки, которые действительно нужно удалить как дубли или нерелевантные.
moves — только строки, которые нужно перенести на другой коммерческий лист.
patches — только исправления полей сохранённой строки; fields может содержать только видимые коммерческие поля и "__comment".
При схлопывании дублей перенеси полезные сведения из удаляемых строк в сохраняемую строку через patches.
Одна организация должна остаться только один раз во всей итоговой совокупности.`;
}

function conflictContract() {
  return `\n\nРАЗРЕШЕНИЕ КОНФЛИКТОВ — верни ТОЛЬКО JSON:
{"remove_ids":[],"moves":[],"patches":[]}.
На входе ТОЛЬКО конфликтные группы. Не анализируй остальные компании.
Разные подтверждённые ИНН — разные юридические лица и никогда не должны объединяться.
Если совпадает телефон/название, но ИНН разные, сохрани обе строки и исправь ошибочную привязку через patch только при явном основании из переданных данных.
Если один объект действительно дубль другого и ИНН не противоречат, можно удалить дубль, сохранив полезные сведения patch-ом в оставшейся строке.
Не выполняй web_search и не придумывай факты.`;
}

function statisticsContract() {
  return `\n\nВерни ТОЛЬКО JSON:
{"statistics":[]}.
statistics — ровно 8 показателей: население региона; количество лесных хозяйств; перевозчиков промышленных и бытовых отходов; дорожных ремонтно-строительных компаний; агро-хозяйств; деревообрабатывающих компаний; производителей ДСП; компаний по вывозу металлического лома/вторчермета.
Каждый объект содержит ровно ключи: ${STAT_COLS.map((x) => `"${x}"`).join(", ")}.
Используй web_search. Для населения предпочитай официальный свежий показатель; для количества компаний — официальный источник или воспроизводимую методику. Если точное число нельзя получить воспроизводимо — "н/д" с причиной.`;
}

function targetedSearchContract() {
  return `\n\nТОЧЕЧНОЕ ОБОГАЩЕНИЕ ОДНОЙ КОМПАНИИ — верни ТОЛЬКО JSON:
{"fields":{},"__comment":""}.
Ищи ТОЛЬКО указанную компанию и ТОЛЬКО перечисленные недостающие сведения.
fields может содержать только: "Управляющая компания", "ИНН", "Телефон", "Руководитель / ЛПР", "Выручка последнего подтвержденного года", "Численность".
"__comment" должен содержать пять строк: Сайт/источник; ИНН; Деятельность; Холдинг/УК/группа; Email.
Не заменяй уже подтверждённые сведения более слабыми. Не выдумывай данные.`;
}

async function loadPrompt(n) {
  const commonPath = path.resolve("prompts/common.txt");
  const promptPath = path.resolve("prompts", String(n).padStart(2, "0") + ".txt");
  const [common, specific] = await Promise.all([
    fs.readFile(commonPath, "utf8"),
    fs.readFile(promptPath, "utf8")
  ]);
  return specific + "\n\n" + common;
}

function normalize(data, withStats = false) {
  const result = {
    direct_buyers: Array.isArray(data?.direct_buyers) ? data.direct_buyers : [],
    intermediaries: Array.isArray(data?.intermediaries) ? data.intermediaries : [],
    leasing: Array.isArray(data?.leasing) ? data.leasing : []
  };
  if (withStats) {
    result.statistics = Array.isArray(data?.statistics) ? data.statistics : [];
  }
  return result;
}

function rowCount(result) {
  return (
    (result.direct_buyers?.length || 0) +
    (result.intermediaries?.length || 0) +
    (result.leasing?.length || 0)
  );
}

function emptyResearchResult() {
  return { direct_buyers: [], intermediaries: [], leasing: [] };
}

function appendResearchResult(target, source, passNumber) {
  for (const sheet of ["direct_buyers", "intermediaries", "leasing"]) {
    for (const row of source?.[sheet] || []) {
      target[sheet].push({
        ...row,
        __research_pass: passNumber
      });
    }
  }
}

function allResearchRows(result) {
  return [
    ...(result?.direct_buyers || []),
    ...(result?.intermediaries || []),
    ...(result?.leasing || [])
  ];
}

function researchRowKey(row) {
  const inn = normalizeInn(row?.["ИНН"]);
  if (inn) return `inn:${inn}`;
  const org = normalizeOrgKey(row?.["Организация"]);
  const place = normalizePlaceKey(row?.["Город/район"]);
  return org ? `org:${org}|${place}` : "";
}

function uniqueResearchCount(result) {
  const keys = new Set();
  let anonymous = 0;
  for (const row of allResearchRows(result)) {
    const key = researchRowKey(row);
    if (key) keys.add(key);
    else anonymous++;
  }
  return keys.size + anonymous;
}

function foundOrganizationNames(result, limit = 180) {
  const names = [];
  const seen = new Set();
  for (const row of allResearchRows(result)) {
    const name = String(row?.["Организация"] || "").trim();
    const key = normalizeOrgKey(name);
    if (!name || !key || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
    if (names.length >= limit) break;
  }
  return names;
}

function normalizeSearchScope(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

async function discoverRegionSearchScopes(client, region) {
  const result = await askJson(client, {
    input: `Верни ТОЛЬКО JSON без markdown:
{"places":[],"clusters":[]}.
Для региона "${region}" перечисли 12–18 наиболее полезных географических точек для B2B-поиска тяжёлой логистики: областной центр, крупные и средние города, значимые районные центры. В clusters дай до 6 известных промышленных/аграрных/лесных/карьерных территорий или муниципальных кластеров. Не включай населённые пункты вне региона. Используй web_search для проверки принадлежности к региону.`,
    model: MODEL,
    maxOutputTokens: 5000,
    webSearch: true,
    diagnosticLabel: `география региона | ${region}`
  });

  const values = [
    ...(Array.isArray(result?.places) ? result.places : []),
    ...(Array.isArray(result?.clusters) ? result.clusters : [])
  ]
    .map(normalizeSearchScope)
    .filter(Boolean);

  const unique = [...new Set(values.map((x) => x.toLowerCase()))]
    .map((lower) => values.find((x) => x.toLowerCase() === lower))
    .filter(Boolean)
    .slice(0, 20);

  if (!unique.length) return [`весь регион: ${region}`];

  const groupCount = Math.min(RESEARCH_GEO_GROUPS, unique.length);
  const groups = Array.from({ length: groupCount }, () => []);
  unique.forEach((value, index) => groups[index % groupCount].push(value));

  return [
    `весь регион: ${region}`,
    ...groups
      .filter((group) => group.length)
      .map((group) => `география: ${group.join(", ")}`)
  ];
}

function microSearchInstruction({ branch, scope, branchIndex, totalBranches }) {
  return `МИКРО-ПОИСК. Это самостоятельная поисковая задача, а не обзор всего этапа.
ТЕМА ${branchIndex + 1}/${totalBranches}: ${branch}
ГЕОГРАФИЧЕСКИЙ СРЕЗ: ${scope}

Выполни web_search именно для этой темы и этого географического среза. Используй несколько формулировок запроса и синонимов, если первый запрос даёт мало результатов.
Ищи конкретные организации и юридические лица, а не статьи/каталоги сами по себе. Переходи от объявления, вакансии, тендера, проекта, сервиса или грузовладельца к фактической компании/перевозчику, если это предусмотрено инструкцией этапа.
Не ограничивай ответ несколькими лучшими компаниями: верни ВСЕ подтверждённые релевантные организации, которые удалось выявить в этой микро-задаче.
A/B/C присваивай после обнаружения. C разрешён при подтверждённом релевантном грузе/процессе, даже если техника ещё не подтверждена.
Не выдумывай компании и не заполняй неизвестные поля предположениями.`;
}

function researchRecoveryInstruction({ theme, alreadyFound, uniqueCount, target, scope }) {
  const known = alreadyFound.length
    ? `\nУЖЕ НАЙДЕННЫЕ (не трать поиск на повторное обнаружение): ${alreadyFound.join("; ")}`
    : "";
  return `ДОПОЛНИТЕЛЬНЫЙ МИКРО-ПОИСК ДЛЯ ПОЛНОТЫ.
Сейчас найдено ${uniqueCount} уникальных релевантных организаций; мягкий ориентир — ${target}+ при наличии реального рынка.
НАПРАВЛЕНИЕ: ${theme}
ГЕОГРАФИЧЕСКИЙ СРЕЗ: ${scope}
Сделай отдельный web_search по этому направлению и географии. Ищи только реальные НОВЫЕ организации и новые подтверждающие факты. Не выдумывай записи ради достижения ориентира.
${known}`;
}

async function runResearchMicroBatch({ client, prompt, region, stageIndex, branch, branchIndex, branches, scopes, extraContext = "" }) {
  const tasks = scopes.map((scope) =>
    askResearch(
      client,
      prompt +
        contract(false) +
        `\n\nРЕГИОН: ${region}
${microSearchInstruction({
  branch,
  scope,
  branchIndex,
  totalBranches: branches.length
})}
${extraContext}
Web search обязателен.`,
      RESEARCH_MICRO_MAX_OUTPUT_TOKENS,
      `этап ${stageIndex + 1} | ветка ${branchIndex + 1}/${branches.length} | ${branch} | ${scope}`
    )
  );

  const settled = await Promise.allSettled(tasks);
  const merged = emptyResearchResult();
  let successCount = 0;
  let firstError = null;

  for (let index = 0; index < settled.length; index++) {
    const item = settled[index];
    if (item.status === "fulfilled") {
      appendResearchResult(
        merged,
        normalize(item.value),
        `branch-${branchIndex + 1}-scope-${index + 1}`
      );
      successCount++;
    } else if (!firstError) {
      firstError = item.reason;
    }
  }

  if (!successCount && firstError) throw firstError;
  return merged;
}

function flattenCandidates(parts) {
  const rows = [];
  const groups = [
    ["direct_buyers", "Прямые покупатели"],
    ["intermediaries", "Посредники"],
    ["leasing", "Лизинг"]
  ];

  for (let stepIndex = 0; stepIndex < parts.length; stepIndex++) {
    const part = parts[stepIndex] || {};
    for (const [key, sourceSheet] of groups) {
      for (const row of part[key] || []) {
        rows.push({
          candidate_id: `c${String(rows.length + 1).padStart(6, "0")}`,
          source_step: stepIndex + 1,
          source_sheet: sourceSheet,
          data: row
        });
      }
    }
  }
  return rows;
}

function normalizeInn(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 10 || digits.length === 12 ? digits : "";
}

function normalizeOrgKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[«»"'.,()]/g, " ")
    .replace(/\b(ооо|ао|пао|зао|оао|ип)\b/g, " ")
    .replace(/[^a-zа-яё0-9]+/gi, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizePlaceKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function canonicalizeCandidates(candidates) {
  const parent = candidates.map((_, i) => i);
  const rank = candidates.map(() => 0);

  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };

  const union = (a, b) => {
    let ra = find(a);
    let rb = find(b);
    if (ra === rb) return;
    if (rank[ra] < rank[rb]) [ra, rb] = [rb, ra];
    parent[rb] = ra;
    if (rank[ra] === rank[rb]) rank[ra]++;
  };

  const innOwners = new Map();

  for (let i = 0; i < candidates.length; i++) {
    const row = candidates[i]?.data || {};
    const inn = normalizeInn(row["ИНН"]);
    if (inn) {
      if (innOwners.has(inn)) union(i, innOwners.get(inn));
      else innOwners.set(inn, i);
    }

    // Без подтвержденного ИНН строки не объединяем программно только по названию/городу.
    // Такие возможные дубли разбираются позже глобальным QA по совокупности признаков.
  }

  const groups = new Map();
  for (let i = 0; i < candidates.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(candidates[i]);
  }

  return [...groups.values()].map((evidence, index) => ({
    canonical_id: `k${String(index + 1).padStart(6, "0")}`,
    candidate_ids: evidence.map((x) => x.candidate_id),
    source_steps: [...new Set(evidence.map((x) => x.source_step))],
    source_sheets: [...new Set(evidence.map((x) => x.source_sheet))],
    evidence
  }));
}

function baselineRowFromCanonical(canonical) {
  const row = {};
  const evidenceRows = canonical?.evidence?.map((x) => x.data || {}) || [];

  for (const col of COLS) {
    const values = [...new Set(
      evidenceRows
        .map((item) => String(item?.[col] ?? "").trim())
        .filter(Boolean)
    )];

    if (col === "Телефон") row[col] = values.join("; ");
    else if (col === "Основание" || col === "Техника/сегмент") row[col] = values.join(" | ");
    else row[col] = values[0] || "";
  }

  row.__canonical_id = canonical.canonical_id;
  row.__decision = "review";
  row.__decision_reason = "Восстановлено из исходных свидетельств: пакетный ответ пропустил canonical-компанию.";
  row.__comment = [
    "Сайт/источник: не подтверждено",
    `ИНН: ${row["ИНН"] || "не подтверждено"}`,
    "Деятельность: требуется финальная проверка",
    `Холдинг/УК/группа: ${row["Управляющая компания"] || "не подтверждено"}`,
    "Email: не найден"
  ].join("\n");
  return row;
}

function ensureBatchCoverage(batch, batchResult) {
  const output = {
    direct_buyers: [],
    intermediaries: [],
    leasing: []
  };
  const seen = new Set();
  const byCanonicalId = new Map(batch.map((item) => [item.canonical_id, item]));

  for (const sheet of ["direct_buyers", "intermediaries", "leasing"]) {
    for (const row of batchResult?.[sheet] || []) {
      const id = String(row?.__canonical_id || "");
      if (!id || !byCanonicalId.has(id) || seen.has(id)) continue;
      seen.add(id);
      output[sheet].push(row);
    }
  }

  for (const canonical of batch) {
    if (seen.has(canonical.canonical_id)) continue;

    const fallback = baselineRowFromCanonical(canonical);
    const preferred = canonical.source_sheets.includes("Лизинг")
      ? "leasing"
      : canonical.source_sheets.includes("Прямые покупатели")
        ? "direct_buyers"
        : "intermediaries";
    output[preferred].push(fallback);
  }

  return output;
}

function makeQaRecords(result) {
  const records = [];
  const groups = ["direct_buyers", "intermediaries", "leasing"];
  for (const sheet of groups) {
    for (const row of result[sheet] || []) {
      records.push({
        id: `q${String(records.length + 1).padStart(6, "0")}`,
        canonical_id: row?.__canonical_id || "",
        sheet,
        row
      });
    }
  }
  return records;
}

function applyFinalQa(records, qa) {
  const allowedSheets = new Set(["direct_buyers", "intermediaries", "leasing"]);
  const allowedFields = new Set([...COLS, "__comment", "__decision", "__decision_reason"]);
  const removeIds = new Set(Array.isArray(qa?.remove_ids) ? qa.remove_ids.map(String) : []);
  const moves = new Map();

  for (const item of Array.isArray(qa?.moves) ? qa.moves : []) {
    const id = String(item?.id || "");
    const sheet = String(item?.sheet || "");
    if (id && allowedSheets.has(sheet)) moves.set(id, sheet);
  }

  const patches = new Map();
  for (const item of Array.isArray(qa?.patches) ? qa.patches : []) {
    const id = String(item?.id || "");
    if (!id || !item?.fields || typeof item.fields !== "object") continue;
    const filtered = {};
    for (const [key, value] of Object.entries(item.fields)) {
      if (allowedFields.has(key)) filtered[key] = value ?? "";
    }
    if (Object.keys(filtered).length) patches.set(id, filtered);
  }

  const result = {
    direct_buyers: [],
    intermediaries: [],
    leasing: [],
    statistics: []
  };

  for (const record of records) {
    if (removeIds.has(record.id)) continue;
    const row = { ...record.row, ...(patches.get(record.id) || {}) };
    const sheet = moves.get(record.id) || record.sheet;
    if (allowedSheets.has(sheet)) result[sheet].push(row);
  }

  return result;
}

function diagnosticRowCount(data) {
  return (
    (Array.isArray(data?.direct_buyers) ? data.direct_buyers.length : 0) +
    (Array.isArray(data?.intermediaries) ? data.intermediaries.length : 0) +
    (Array.isArray(data?.leasing) ? data.leasing.length : 0)
  );
}

function diagnosticToolCounts(response) {
  const counts = {};
  for (const item of response?.output || []) {
    const type = String(item?.type || "unknown");
    if (!type.endsWith("_call")) continue;
    counts[type] = (counts[type] || 0) + 1;
  }
  return counts;
}

function diagnosticWebQueries(response) {
  const queries = [];
  for (const item of response?.output || []) {
    if (item?.type !== "web_search_call") continue;
    const action = item?.action || {};
    if (typeof action.query === "string" && action.query.trim()) {
      queries.push(action.query.trim());
    }
    if (Array.isArray(action.queries)) {
      for (const query of action.queries) {
        if (typeof query === "string" && query.trim()) queries.push(query.trim());
      }
    }
  }
  return [...new Set(queries)];
}

function compactDiagnosticQuery(input, explicitLabel = "") {
  if (explicitLabel) return explicitLabel;
  return String(input || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 320);
}

async function askJson(client, {
  input,
  model = MODEL,
  maxOutputTokens = RESEARCH_MAX_OUTPUT_TOKENS,
  webSearch = false,
  fileSearchVectorStoreId = "",
  diagnosticLabel = ""
}) {
  const request = {
    model,
    input,
    max_output_tokens: maxOutputTokens
  };
  const tools = [];
  if (webSearch) tools.push({ type: "web_search" });
  if (fileSearchVectorStoreId) {
    tools.push({
      type: "file_search",
      vector_store_ids: [fileSearchVectorStoreId],
      max_num_results: COURT_FILE_SEARCH_MAX_RESULTS
    });
  }
  if (tools.length) {
    request.tools = tools;
    request.tool_choice = "required";
  }

  const requestOptions = client.__jobSignal
    ? { signal: client.__jobSignal }
    : undefined;
  const startedAt = Date.now();
  const query = compactDiagnosticQuery(input, diagnosticLabel);

  try {
    const response = await client.responses.create(request, requestOptions);
    const usage = response?.usage || {};
    const stopReason =
      response?.incomplete_details?.reason ||
      (response?.status === "completed" ? "completed" : response?.status || "unknown");

    let parsed = null;
    let parseError = "";
    try {
      parsed = parseJson(response.output_text || "");
    } catch (error) {
      parseError = error?.message || "parse error";
    }

    console.log("[OPENAI_DIAG] " + JSON.stringify({
      query,
      model,
      web_search: webSearch,
      file_search: Boolean(fileSearchVectorStoreId),
      max_output_tokens: maxOutputTokens,
      status: response?.status || "",
      stop_reason: stopReason,
      duration_ms: Date.now() - startedAt,
      input_tokens: usage?.input_tokens ?? null,
      output_tokens: usage?.output_tokens ?? null,
      reasoning_tokens: usage?.output_tokens_details?.reasoning_tokens ?? null,
      cached_input_tokens: usage?.input_tokens_details?.cached_tokens ?? null,
      tool_calls: diagnosticToolCounts(response),
      web_search_queries: diagnosticWebQueries(response),
      output_chars: String(response?.output_text || "").length,
      rows_returned: parsed ? diagnosticRowCount(parsed) : null,
      parse_error: parseError || null
    }));

    if (response.status && response.status !== "completed") {
      throw new Error(`OpenAI response status: ${response.status}; reason: ${stopReason}`);
    }
    if (parseError) throw new Error(parseError);
    return parsed;
  } catch (error) {
    console.error("[OPENAI_DIAG] " + JSON.stringify({
      query,
      model,
      web_search: webSearch,
      file_search: Boolean(fileSearchVectorStoreId),
      max_output_tokens: maxOutputTokens,
      status: "error",
      stop_reason: client.__jobSignal?.aborted ? "cancelled" : "error",
      duration_ms: Date.now() - startedAt,
      error: error?.message || String(error)
    }));
    throw error;
  }
}

function askResearch(client, input, maxOutputTokens = RESEARCH_MAX_OUTPUT_TOKENS, diagnosticLabel = "") {
  return askJson(client, {
    input,
    model: MODEL,
    maxOutputTokens,
    webSearch: true,
    diagnosticLabel
  });
}

function askWithoutSearch(client, input, model, maxOutputTokens) {
  return askJson(client, {
    input,
    model,
    maxOutputTokens,
    webSearch: false
  });
}

function askTargetedSearch(client, input) {
  return askJson(client, {
    input,
    model: TARGETED_SEARCH_MODEL,
    maxOutputTokens: TARGETED_SEARCH_MAX_OUTPUT_TOKENS,
    webSearch: true
  });
}

function askCourtArchive(client, input) {
  if (!COURT_VECTOR_STORE_ID) return null;
  return askJson(client, {
    input,
    model: COURT_ARCHIVE_MODEL,
    maxOutputTokens: RESEARCH_MAX_OUTPUT_TOKENS,
    fileSearchVectorStoreId: COURT_VECTOR_STORE_ID
  });
}

function courtArchiveInstruction(theme, region, alreadyFound = []) {
  const known = alreadyFound.length
    ? `\nУже найденные на предыдущих архивных проходах: ${alreadyFound.join("; ")}. Ищи прежде всего НОВЫЕ организации и новые дела.`
    : "";
  return `РЕГИОН: ${region}
ИСТОЧНИК: загруженный пользователем архив судебных актов в file_search.
ТЕМА АРХИВНОГО ПРОХОДА: ${theme}

ОБЯЗАТЕЛЬНО используй file_search по архиву. Ищи документы, связанные именно с выбранным регионом — по суду, месту события, маршруту, адресу организации или обстоятельствам дела.
Извлекай реальные организации, которые могут быть собственниками, перевозчиками, лизингополучателями, арендаторами или фактическими эксплуатантами тяжёлого транспорта.
В "__evidence.source_urls" не выдумывай URL архивного файла; в "__evidence.notes" укажи номер дела, суд, дату, транспорт, госномер/VIN, статью и обстоятельства, если они явно есть в найденном тексте.
Сам факт упоминания организации не даёт A/B. Не делай вывод о собственнике/эксплуатанте без текста судебного акта.
Возвращай только организации, имеющие отношение к тяжёлой автологистике, прицепной технике, весогабаритному контролю, лизингу/ремонту техники или иному релевантному транспортному спору.${known}`;
}

function commentValue(comment, label) {
  const line = String(comment || "")
    .split(/\r?\n/)
    .find((x) => x.trim().toLowerCase().startsWith(label.toLowerCase() + ":"));
  return line ? line.slice(line.indexOf(":") + 1).trim() : "";
}

function isMissingText(value) {
  const text = String(value || "").trim().toLowerCase();
  return !text ||
    text === "н/д" ||
    text.includes("не найден") ||
    text.includes("не подтвержден") ||
    text.includes("требуется финальная проверка");
}

function missingResearchFields(row) {
  const gaps = [];
  const comment = row?.__comment || "";
  if (isMissingText(commentValue(comment, "Сайт/источник"))) gaps.push("сайт/источник");
  if (!normalizeInn(row?.["ИНН"])) gaps.push("ИНН");
  if (isMissingText(commentValue(comment, "Email"))) gaps.push("email");
  if (isMissingText(commentValue(comment, "Деятельность"))) gaps.push("краткое описание деятельности");

  const holding = commentValue(comment, "Холдинг/УК/группа");
  const manager = String(row?.["Управляющая компания"] || "").trim();
  if (isMissingText(holding) && (!manager || /не подтвержд/i.test(manager))) {
    gaps.push("холдинг/УК/группа");
  }
  return [...new Set(gaps)];
}

function applyTargetedPatch(row, result) {
  const allowed = new Set([
    "Управляющая компания",
    "ИНН",
    "Телефон",
    "Руководитель / ЛПР",
    "Выручка последнего подтвержденного года",
    "Численность"
  ]);
  for (const [key, value] of Object.entries(result?.fields || {})) {
    if (!allowed.has(key)) continue;
    if (value === undefined || value === null || String(value).trim() === "") continue;
    if (key === "Телефон") row[key] = mergePhone(row[key], value);
    else if (!String(row[key] || "").trim() || /не подтвержд/i.test(String(row[key]))) row[key] = value;
  }
  if (String(result?.__comment || "").trim()) row.__comment = String(result.__comment).trim();
}

function buildConflictGroups(records) {
  const buckets = new Map();
  const add = (key, record) => {
    if (!key) return;
    if (!buckets.has(key)) buckets.set(key, []);
    const arr = buckets.get(key);
    if (!arr.some((x) => x.id === record.id)) arr.push(record);
  };

  for (const record of records) {
    const row = record.row || {};
    const org = normalizeOrgKey(row["Организация"]);
    const place = normalizePlaceKey(row["Город/район"]);
    if (org && place) add(`orgplace:${org}|${place}`, record);

    for (const phone of splitPhoneEntries(row["Телефон"])) {
      const normalized = normalizePhoneDigits(phone);
      if (normalized) add(`phone:${normalized}`, record);
    }
  }

  const groups = [];
  const seen = new Set();
  for (const [key, items] of buckets) {
    if (items.length < 2) continue;
    const inns = [...new Set(items.map((x) => normalizeInn(x.row?.["ИНН"])).filter(Boolean))];
    const canonicalIds = [...new Set(items.map((x) => x.canonical_id).filter(Boolean))];
    if (inns.length <= 1 && canonicalIds.length <= 1) continue;
    const signature = items.map((x) => x.id).sort().join("|");
    if (seen.has(signature)) continue;
    seen.add(signature);
    groups.push({ key, records: items });
  }
  return groups;
}


function initialStatuses() {
  return STEPS.map((name, index) => ({
    step: index + 1,
    name,
    status: "waiting",
    detail: "",
    startedAt: null,
    completedAt: null
  }));
}

function startStep(status) {
  status.status = "running";
  status.startedAt = Date.now();
  status.completedAt = null;
}

function finishStep(status) {
  status.status = "done";
  status.completedAt = Date.now();
}

function mergePhone(current, found) {
  const parts = String(current || "")
    .split(";")
    .concat(String(found || "").split(";"))
    .map((x) => x.trim())
    .filter(Boolean);
  return [...new Set(parts)].join(";");
}

function applyContact(row, contact) {
  if (contact?.phone) row["Телефон"] = mergePhone(row["Телефон"], contact.phone);
  if (contact?.leader) row["Руководитель / ЛПР"] = contact.leader;
}

function normalizePhoneDigits(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("8")) digits = "7" + digits.slice(1);
  if (digits.length === 10) digits = "7" + digits;
  return digits.length === 11 && digits.startsWith("7") ? digits : "";
}

function splitPhoneEntries(value) {
  return String(value || "")
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean);
}

function buildPhoneOwnerMap(rows) {
  const map = new Map();
  for (const row of rows) {
    for (const entry of splitPhoneEntries(row["Телефон"])) {
      const normalized = normalizePhoneDigits(entry);
      if (!normalized) continue;
      if (!map.has(normalized)) map.set(normalized, []);
      map.get(normalized).push(row);
    }
  }
  return map;
}

function filterAlreadyInCurrentCell(currentValue, candidateValue) {
  const existing = new Set(
    splitPhoneEntries(currentValue)
      .map(normalizePhoneDigits)
      .filter(Boolean)
  );
  return splitPhoneEntries(candidateValue).filter((entry) => {
    const normalized = normalizePhoneDigits(entry);
    return normalized && !existing.has(normalized);
  });
}

function hasConfirmedPhone(row) {
  return splitPhoneEntries(row?.["Телефон"]).some((entry) => Boolean(normalizePhoneDigits(entry)));
}

function hasConfirmedLeader(row) {
  return Boolean(String(row?.["Руководитель / ЛПР"] || "").trim());
}

function needsGoogleResearch(row) {
  return !hasConfirmedPhone(row) || !hasConfirmedLeader(row);
}

function isPriorityAB(row) {
  const basis = String(row?.["Основание"] || "").trim().toUpperCase();
  return basis.startsWith("A") || basis.startsWith("B");
}

export async function runResearchPipeline({ job, apiKey }) {
  if (!apiKey) throw new Error("OpenAI API key is required");

  const client = new OpenAI({ apiKey });
  const jobSignal = job.abortController?.signal;
  client.__jobSignal = jobSignal;
  const region = String(job.region || job.data?.region || "").trim();
  const diagnosticMode = job.mode === "test12";
  const researchStageLimit = diagnosticMode ? 2 : 9;
  if (!region) throw new Error("Region is required");

  const statuses = initialStatuses();
  const progress = async (patch = {}) => {
    await job.updateProgress({
      statuses,
      region,
      ...patch
    });
  };

  const assertNotCancelled = async () => {
    if (job.cancelled || jobSignal?.aborted) throw new Error("JOB_CANCELLED");
  };

  const abortableSleep = (ms) =>
    new Promise((resolve, reject) => {
      if (jobSignal?.aborted) return reject(new Error("JOB_CANCELLED"));
      const timer = setTimeout(resolve, ms);
      if (jobSignal) {
        jobSignal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("JOB_CANCELLED"));
          },
          { once: true }
        );
      }
    });

  await progress({ phase: "starting", percent: 0 });
  const prompts = await Promise.all(Array.from({ length: 10 }, (_, i) => loadPrompt(i + 1)));
  const parts = [];
  const compactCourtArchive = COURT_VECTOR_STORE_ID ? [] : courtArchiveCandidates(region, 180);
  const compactCourtArchiveMeta = COURT_VECTOR_STORE_ID ? null : courtArchiveStats();
  const researchScopes = await discoverRegionSearchScopes(client, region);
  for (let i = 0; i < researchStageLimit; i++) {
    await assertNotCancelled();
    startStep(statuses[i]);

    const combined = emptyResearchResult();

    const compactCourtArchiveContext =
      i === 6 && !COURT_VECTOR_STORE_ID && compactCourtArchive.length
        ? `\n\nПОЛЬЗОВАТЕЛЬСКИЙ АРХИВ СУДЕБНЫХ АКТОВ — discovery-кандидаты:
Архив содержит ${compactCourtArchiveMeta?.documents || 10109} документов. Для выбранного региона компактный индекс дал:
${JSON.stringify(compactCourtArchive)}
Не добавляй организацию только из-за присутствия в этом списке. Используй список для поиска конкретного дела через web_search/официальный судебный источник и возвращай организацию только после подтверждения транспортно-релевантных обстоятельств.`
        : "";

    if (i === 6 && COURT_VECTOR_STORE_ID) {
      const archiveThemes = [
        "превышение массы и осевой нагрузки, автоматический весогабаритный контроль, ущерб дорогам, статья 12.21.1 КоАП",
        "тягачи, полуприцепы и прицепы, VIN, госномера, собственник, перевозчик, фактический эксплуатант",
        "лизинг, изъятие и возврат техники, ремонт полуприцепов, ДТП и страховые споры с идентификацией транспорта"
      ];

      for (let archivePass = 0; archivePass < archiveThemes.length; archivePass++) {
        await assertNotCancelled();
        const alreadyFound = foundOrganizationNames(combined, 300);
        statuses[i].detail = `судебный архив · ${archivePass + 1} / ${archiveThemes.length}`;
        await progress({ phase: "research", step: i + 1, percent: i * 9 });

        const archiveOutput = normalize(
          await askCourtArchive(
            client,
            prompts[i] +
              contract(false) +
              "\n\n" +
              courtArchiveInstruction(archiveThemes[archivePass], region, alreadyFound)
          )
        );
        appendResearchResult(combined, archiveOutput, `archive-${archivePass + 1}`);
      }
    }

    const branches = STAGE_SEARCH_BRANCHES[i] || [];
    for (let branchIndex = 0; branchIndex < branches.length; branchIndex++) {
      await assertNotCancelled();
      const before = uniqueResearchCount(combined);
      statuses[i].detail =
        `ветка ${branchIndex + 1} / ${branches.length} · микро-поиски 0 / ${researchScopes.length} · ${before} уникальных`;
      await progress({
        phase: "research",
        step: i + 1,
        percent: i * 9 + Math.floor((branchIndex / Math.max(1, branches.length)) * 8)
      });

      const extraContext = [
        compactCourtArchiveContext,
        i === 6 && COURT_VECTOR_STORE_ID
          ? "До web-поиска по судам уже выполнен file_search по пользовательскому архиву. Перепроверяй найденные там организации и дела через официальные источники."
          : ""
      ].filter(Boolean).join("\n");

      const branchResult = await runResearchMicroBatch({
        client,
        prompt: prompts[i],
        region,
        stageIndex: i,
        branch: branches[branchIndex],
        branchIndex,
        branches,
        scopes: researchScopes,
        extraContext
      });
      appendResearchResult(combined, branchResult, `branch-${branchIndex + 1}`);

      const after = uniqueResearchCount(combined);
      statuses[i].detail =
        `ветка ${branchIndex + 1} / ${branches.length} · ${researchScopes.length} микро-поисков · +${Math.max(0, after - before)} новых · ${after} уникальных`;
      await progress({
        phase: "research",
        step: i + 1,
        percent: i * 9 + Math.floor(((branchIndex + 1) / Math.max(1, branches.length)) * 8)
      });
    }

    let lowYieldStreak = 0;
    for (
      let recoveryIndex = 0;
      recoveryIndex < RESEARCH_MAX_RECOVERY_BRANCHES &&
      uniqueResearchCount(combined) < RESEARCH_SOFT_TARGET;
      recoveryIndex++
    ) {
      await assertNotCancelled();
      const before = uniqueResearchCount(combined);
      const alreadyFound = foundOrganizationNames(combined, 120);
      const theme = RESEARCH_RECOVERY_THEMES[recoveryIndex % RESEARCH_RECOVERY_THEMES.length];

      statuses[i].detail =
        `добор ${recoveryIndex + 1} · ${before} / ориентир ${RESEARCH_SOFT_TARGET}`;
      await progress({ phase: "research", step: i + 1, percent: i * 9 + 8 });

      const tasks = researchScopes.map((scope) =>
        askResearch(
          client,
          prompts[i] +
            contract(false) +
            `\n\nРЕГИОН: ${region}
${researchRecoveryInstruction({
  theme,
  alreadyFound,
  uniqueCount: before,
  target: RESEARCH_SOFT_TARGET,
  scope
})}
Web search обязателен.`,
          RESEARCH_MICRO_MAX_OUTPUT_TOKENS,
          `этап ${i + 1} | recovery ${recoveryIndex + 1} | ${theme} | ${scope}`
        )
      );

      const settled = await Promise.allSettled(tasks);
      let successes = 0;
      for (let scopeIndex = 0; scopeIndex < settled.length; scopeIndex++) {
        const item = settled[scopeIndex];
        if (item.status !== "fulfilled") continue;
        appendResearchResult(
          combined,
          normalize(item.value),
          `recovery-${recoveryIndex + 1}-scope-${scopeIndex + 1}`
        );
        successes++;
      }

      if (!successes) throw new Error(`Все микро-поиски добора этапа ${i + 1} завершились ошибкой`);

      const after = uniqueResearchCount(combined);
      const added = Math.max(0, after - before);
      lowYieldStreak = added <= RESEARCH_LOW_YIELD_THRESHOLD ? lowYieldStreak + 1 : 0;

      if (lowYieldStreak >= 2) {
        statuses[i].detail = `разумные поисковые направления исчерпаны · ${after} уникальных`;
        break;
      }
    }

    parts.push(combined);
    finishStep(statuses[i]);
    statuses[i].detail =
      `выполнен · ${rowCount(combined)} записей · ${uniqueResearchCount(combined)} уникальных · ${branches.length} веток × ${researchScopes.length} микро-поиска`;
    await progress({ phase: "research", step: i + 1, percent: (i + 1) * 9 });
  }

  if (diagnosticMode) {
    const totalRows = parts.reduce((sum, part) => sum + rowCount(part), 0);
    const combinedTest = emptyResearchResult();
    for (const part of parts) appendResearchResult(combinedTest, part, "test-summary");
    const unique = uniqueResearchCount(combinedTest);
    await progress({ phase: "completed", step: 2, percent: 100 });
    return {
      mode: "test12",
      result: combinedTest,
      region,
      counts: {
        total_rows: totalRows,
        unique,
        stage1_rows: rowCount(parts[0] || emptyResearchResult()),
        stage1_unique: uniqueResearchCount(parts[0] || emptyResearchResult()),
        stage2_rows: rowCount(parts[1] || emptyResearchResult()),
        stage2_unique: uniqueResearchCount(parts[1] || emptyResearchResult())
      },
      contacts: { total: 0, checked: 0, skipped: 0, ok: 0, unavailable: 0, notFound: 0 }
    };
  }

  await assertNotCancelled();
  startStep(statuses[9]);
  const candidatePool = flattenCandidates(parts);
  const canonicalPool = canonicalizeCandidates(candidatePool);
  const batchCount = Math.max(1, Math.ceil(canonicalPool.length / FINAL_BATCH_SIZE));
  const stagedResult = {
    direct_buyers: [],
    intermediaries: [],
    leasing: []
  };

  for (let batchIndex = 0; batchIndex < batchCount; batchIndex++) {
    await assertNotCancelled();
    const batch = canonicalPool.slice(
      batchIndex * FINAL_BATCH_SIZE,
      (batchIndex + 1) * FINAL_BATCH_SIZE
    );

    statuses[9].detail = `пакет ${batchIndex + 1} / ${batchCount} · ${batch.length} компаний`;
    await progress({
      phase: "dedupe",
      step: 10,
      percent: 82 + Math.floor(((batchIndex + 1) / batchCount) * 5)
    });

    const rawBatchResult = normalize(
      await askWithoutSearch(
        client,
        prompts[9] +
          finalBatchContract() +
          `\n\nРЕГИОН: ${region}
Это пакет CANONICAL-компаний, предварительно собранных программно из всех шагов 1–9.
В evidence каждой canonical-компании находятся ВСЕ исходные строки, которые были программно объединены только по одинаковому подтверждённому ИНН. Строки без подтверждённого ИНН заранее не схлопывались по названию/городу и должны разбираться на глобальном QA по совокупности признаков.
Не игнорируй отдельные элементы evidence: факты из разных шагов должны дополнять друг друга.
Не удаляй canonical-компании и обязательно верни каждый "__canonical_id" ровно один раз.
Сохраняй максимум полезной информации из evidence. Новый web_search здесь запрещён; пробелы будут обработаны отдельным точечным проходом.
Глобальная дедупликация между canonical-компаниями будет отдельным QA-вызовом после обработки всех пакетов.

ПАКЕТ CANONICAL-КОМПАНИЙ JSON:
${JSON.stringify(batch)}`,
        FINAL_BATCH_MODEL,
        FINAL_BATCH_MAX_OUTPUT_TOKENS
      )
    );

    const batchResult = ensureBatchCoverage(batch, rawBatchResult);
    stagedResult.direct_buyers.push(...batchResult.direct_buyers);
    stagedResult.intermediaries.push(...batchResult.intermediaries);
    stagedResult.leasing.push(...batchResult.leasing);
  }

  await assertNotCancelled();
  const stagedCompanies = [
    ...stagedResult.direct_buyers,
    ...stagedResult.intermediaries,
    ...stagedResult.leasing
  ];
  let targetedSearches = 0;

  for (const row of stagedCompanies) {
    const gaps = missingResearchFields(row);
    if (!gaps.length) continue;

    await assertNotCancelled();
    targetedSearches++;
    statuses[9].detail = `точечная проверка ${targetedSearches} · ${row["Организация"] || ""}`;
    await progress({ phase: "dedupe", step: 10, percent: 87 });

    const enriched = await askTargetedSearch(
      client,
      prompts[9] +
        targetedSearchContract() +
        `\n\nРЕГИОН: ${region}
КОМПАНИЯ:
${JSON.stringify(row)}
НЕДОСТАЮЩИЕ СВЕДЕНИЯ:
${JSON.stringify(gaps)}
Сделай один точечный web_search только по этой компании. Ищи недостающие сведения и верни аккуратный patch. Не перепроверяй заполненные поля без необходимости.`
    );
    applyTargetedPatch(row, enriched);
  }

  await assertNotCancelled();
  let qaRecords = makeQaRecords(stagedResult);
  const conflictGroups = buildConflictGroups(qaRecords);

  if (conflictGroups.length) {
    statuses[9].detail = `разрешение конфликтов · ${conflictGroups.length} групп`;
    await progress({ phase: "dedupe", step: 10, percent: 88 });

    const conflictQa = await askWithoutSearch(
      client,
      prompts[9] +
        conflictContract() +
        `\n\nКОНФЛИКТНЫЕ ГРУППЫ:
${JSON.stringify(conflictGroups)}`,
      CONFLICT_MODEL,
      FINAL_QA_MAX_OUTPUT_TOKENS
    );

    const conflictResolved = applyFinalQa(qaRecords, conflictQa);
    stagedResult.direct_buyers = conflictResolved.direct_buyers;
    stagedResult.intermediaries = conflictResolved.intermediaries;
    stagedResult.leasing = conflictResolved.leasing;
    qaRecords = makeQaRecords(stagedResult);
  }

  statuses[9].detail = `глобальный QA · ${qaRecords.length} организаций`;
  await progress({ phase: "dedupe", step: 10, percent: 89 });

  const qa = await askWithoutSearch(
    client,
    prompts[9] +
      finalQaContract() +
      `\n\nРЕГИОН: ${region}
Ниже уже обработанные canonical-компании с техническими id и canonical_id.
Выполни глобальную дедупликацию, финальную переклассификацию и QA только по переданным данным.
Строки с "__decision":"exclude" не удаляй механически: проверь основание.
Не переписывай весь массив компаний: верни только remove_ids, moves и patches.
Разные подтверждённые ИНН никогда не объединяй.
Работай без web_search.

КОММЕРЧЕСКИЕ СТРОКИ JSON:
${JSON.stringify(qaRecords)}`,
    FINAL_QA_MODEL,
    FINAL_QA_MAX_OUTPUT_TOKENS
  );

  const finalResult = applyFinalQa(qaRecords, qa);

  statuses[9].detail = "региональная статистика";
  await progress({ phase: "dedupe", step: 10, percent: 89 });

  const statsResult = await askJson(client, {
    input:
      prompts[9] +
      statisticsContract() +
      `\n\nРЕГИОН: ${region}\nСобери только 8 обязательных показателей статистики по региону.`,
    model: TARGETED_SEARCH_MODEL,
    maxOutputTokens: STATISTICS_MAX_OUTPUT_TOKENS,
    webSearch: true
  });
  finalResult.statistics = Array.isArray(statsResult?.statistics) ? statsResult.statistics : [];

  finishStep(statuses[9]);
  statuses[9].detail = `выполнен · ${rowCount(finalResult)} организаций · точечных поисков: ${targetedSearches}`;
  await progress({ phase: "dedupe", step: 10, percent: 90 });

  const companies = [
    ...finalResult.direct_buyers,
    ...finalResult.intermediaries,
    ...finalResult.leasing
  ];
  const phoneOwners = buildPhoneOwnerMap(companies);
  const googleCompanies = companies.filter(needsGoogleResearch);
  const skippedGoogle = companies.length - googleCompanies.length;

  startStep(statuses[10]);
  statuses[10].detail = googleCompanies.length
    ? `0 / ${googleCompanies.length} · пропущено готовых: ${skippedGoogle}`
    : `контакты уже заполнены · пропущено: ${skippedGoogle}`;
  await progress({
    phase: "google_ai",
    step: 11,
    percent: 90,
    contactCurrent: 0,
    contactTotal: googleCompanies.length
  });

  let ok = 0;
  let unavailable = 0;
  let notFound = 0;
  let solRetries = 0;
  let solRecovered = 0;
  let browser;
  let session;

  try {
    if (googleCompanies.length) {
      browser = await launchResearchBrowser();
      session = await createResearchSession(browser);
      if (jobSignal) {
        jobSignal.addEventListener(
          "abort",
          () => browser?.close().catch(() => {}),
          { once: true }
        );
      }
    }

    for (let i = 0; i < googleCompanies.length; i++) {
      await assertNotCancelled();

      if (i > 0 && i % 90 === 0) {
        if (session) await closeResearchSession(session);
        if (browser) await browser.close().catch(() => {});
        browser = await launchResearchBrowser();
        session = await createResearchSession(browser);
        statuses[10].detail = `${i} / ${googleCompanies.length} · новая сессия поиска`;
        await progress({
          phase: "google_ai",
          step: 11,
          percent: 90 + Math.floor((i / Math.max(1, googleCompanies.length)) * 9),
          contactCurrent: i,
          contactTotal: googleCompanies.length,
          contactCompany: "",
          contactStats: { ok, unavailable, notFound, solRetries, solRecovered }
        });
        await abortableSleep(2000);
      }

      const row = googleCompanies[i];
      statuses[10].detail = `${i} / ${googleCompanies.length} · ${row["Организация"] || ""}`;
      await progress({
        phase: "google_ai",
        step: 11,
        percent: 90 + Math.floor((i / Math.max(1, googleCompanies.length)) * 9),
        contactCurrent: i,
        contactTotal: googleCompanies.length,
        contactCompany: row["Организация"] || ""
      });

      let contact;
      try {
        const needPhone = !hasConfirmedPhone(row);
        const needLeader = !hasConfirmedLeader(row);
        contact = await enrichCompanyWithGoogleAI({
          client,
          session,
          row,
          region,
          needPhone,
          needLeader,
          isCancelled: () => Boolean(job.cancelled || jobSignal?.aborted),
          signal: jobSignal
        });
      } catch (error) {
        contact = {
          status: "unavailable",
          phone: "",
          leader: "",
          note: error?.message || "browser error"
        };
      }

      if (contact.status === "not_found" && GOOGLE_AI_SOL_RETRY_PRIORITY_AB && isPriorityAB(row)) {
        solRetries++;
        statuses[10].detail = `${i + 1} / ${googleCompanies.length} · Sol retry · ${row["Организация"] || ""}`;
        await progress({
          phase: "google_ai",
          step: 11,
          percent: 90 + Math.floor((i / Math.max(1, googleCompanies.length)) * 9),
          contactCurrent: i,
          contactTotal: googleCompanies.length,
          contactCompany: row["Организация"] || "",
          contactStats: { ok, unavailable, notFound, solRetries, solRecovered }
        });

        try {
          const needPhone = !hasConfirmedPhone(row);
          const needLeader = !hasConfirmedLeader(row);
          contact = await enrichCompanyWithGoogleAI({
            client,
            session,
            row,
            region,
            needPhone,
            needLeader,
            forceFallback: true,
            isCancelled: () => Boolean(job.cancelled || jobSignal?.aborted),
          signal: jobSignal
          });
          if (contact.status === "ok") solRecovered++;
        } catch (error) {
          contact = {
            status: "unavailable",
            phone: "",
            leader: "",
            note: error?.message || "Sol retry browser error"
          };
        }
      }

      if (contact.status === "ok") {
        const candidates = filterAlreadyInCurrentCell(row["Телефон"], contact.phone);
        const accepted = [];

        for (const entry of candidates) {
          const normalized = normalizePhoneDigits(entry);
          if (!normalized) continue;

          const owners = phoneOwners.get(normalized) || [];
          const belongsElsewhere = owners.some((owner) => owner !== row);

          if (belongsElsewhere) {
            const verification = await verifyPhoneForCompanyWithGoogleAI({
              client,
              session,
              row,
              region,
              phone: normalized,
              isCancelled: () => Boolean(job.cancelled || jobSignal?.aborted),
          signal: jobSignal
            });
            if (!verification?.confirmed) continue;
          }

          accepted.push(entry);
          if (!phoneOwners.has(normalized)) phoneOwners.set(normalized, []);
          if (!phoneOwners.get(normalized).includes(row)) {
            phoneOwners.get(normalized).push(row);
          }
        }

        if (accepted.length) {
          contact.phone = accepted.join("; ");
          applyContact(row, contact);
          ok++;
        } else if (contact.leader) {
          applyContact(row, { ...contact, phone: "" });
          ok++;
        } else {
          notFound++;
        }
      } else if (contact.status === "not_found") {
        notFound++;
      } else {
        unavailable++;
      }

      statuses[10].detail = `${i + 1} / ${googleCompanies.length} · выполнено`;
      await progress({
        phase: "google_ai",
        step: 11,
        percent: 90 + Math.floor(((i + 1) / Math.max(1, googleCompanies.length)) * 9),
        contactCurrent: i + 1,
        contactTotal: googleCompanies.length,
        contactCompany: row["Организация"] || "",
        contactStats: { ok, unavailable, notFound, solRetries, solRecovered }
      });

      if (i < googleCompanies.length - 1) {
        await abortableSleep(5000);
      }
    }
  } finally {
    if (session) await closeResearchSession(session);
    if (browser) await browser.close().catch(() => {});
  }

  finishStep(statuses[10]);
  statuses[10].detail = `выполнен · проверено ${googleCompanies.length}, пропущено ${skippedGoogle}`;
  await progress({
    phase: "completed",
    step: 11,
    percent: 100,
    contactCurrent: googleCompanies.length,
    contactTotal: googleCompanies.length,
    contactStats: { ok, unavailable, notFound, solRetries, solRecovered }
  });

  return {
    mode: "full",
    result: finalResult,
    region,
    counts: {
      direct_buyers: finalResult.direct_buyers.length,
      intermediaries: finalResult.intermediaries.length,
      leasing: finalResult.leasing.length,
      statistics: finalResult.statistics.length
    },
    contacts: {
      total: companies.length,
      checked: googleCompanies.length,
      skipped: skippedGoogle,
      ok,
      unavailable,
      notFound,
      solRetries,
      solRecovered
    }
  };
}
