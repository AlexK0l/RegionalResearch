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

const DISCOVERY_ALREADY_FOUND_LIMIT = Math.max(
  20,
  Math.min(200, Number(process.env.OPENAI_DISCOVERY_ALREADY_FOUND_LIMIT || 100))
);
const DISCOVERY_SCOPE_LOW_YIELD_THRESHOLD = Math.max(
  0,
  Math.min(10, Number(process.env.OPENAI_DISCOVERY_SCOPE_LOW_YIELD_THRESHOLD || 2))
);
const DISCOVERY_SCOPE_LOW_YIELD_STREAK = Math.max(
  1,
  Math.min(3, Number(process.env.OPENAI_DISCOVERY_SCOPE_LOW_YIELD_STREAK || 2))
);

// Ветки, чьи основные источники обычно индексируются по региону целиком.
// Для них достаточно общего регионального поиска + одного локального контрольного scope.
// Локальные отраслевые ветки по-прежнему проходят все доступные geo-scope.
const REGION_WIDE_DISCOVERY_BRANCHES = {
  1: new Set([0, 5, 6, 7]),
  2: new Set([0, 1, 2, 3, 4, 5, 6]),
  5: new Set([0, 1, 2, 3, 4, 5])
};

function discoveryScopesForBranch(stageIndex, branchIndex, scopes) {
  const all = Array.isArray(scopes) ? scopes.filter(Boolean) : [];
  if (all.length <= 2) return all;

  const regional = REGION_WIDE_DISCOVERY_BRANCHES[stageIndex + 1];
  if (regional?.has(branchIndex)) {
    return all.slice(0, 2);
  }
  return all;
}

function discoveryKnownNames(result, limit = DISCOVERY_ALREADY_FOUND_LIMIT) {
  return foundOrganizationNames(result, limit);
}

function mergeKnownOrganizationNames(target, result) {
  const seen = new Set(target.map((name) => normalizeOrgKey(name)).filter(Boolean));
  for (const row of allResearchRows(result)) {
    const name = String(row?.["Организация"] || "").trim();
    const key = normalizeOrgKey(name);
    if (!name || !key || seen.has(key)) continue;
    seen.add(key);
    target.push(name);
  }
  if (target.length > DISCOVERY_ALREADY_FOUND_LIMIT) {
    target.splice(0, target.length - DISCOVERY_ALREADY_FOUND_LIMIT);
  }
}

function countNewOrganizationsAgainstKnown(result, knownNames) {
  const known = new Set((knownNames || []).map((x) => normalizeOrgKey(x)).filter(Boolean));
  const fresh = new Set();
  for (const row of allResearchRows(result)) {
    const key = normalizeOrgKey(row?.["Организация"]);
    if (key && !known.has(key)) fresh.add(key);
  }
  return fresh.size;
}

const DISCOVERY_STAGE_HINTS = [
  "Объявления, б/у техника и вакансии. Источники: Avito, Drom, Auto.ru, Autoline, Truck1, Machineryline, Perevozka24, HH, SuperJob, сайты компаний. По объявлению/вакансии выходи на организацию и проверяй связь с тяжёлой логистикой/целевым грузом.",
  "Лизинг, залоги и цикл замены. Источники: Федресурс, лизинговые компании, банки, торги, реестры залогов, официальные документы. Различай лизингодателя и фактического эксплуатанта.",
  "Сервисы, гидравлика, запчасти и посредники. Ищи публичных клиентов/кейсы сервисов, ремонтов, гидравлики, шин, телематики, дилеров и поставщиков; отделяй посредника от конечного эксплуатанта.",
  "Перевозчики и автопарк. Ищи фактических перевозчиков целевых грузов, собственный/лизинговый тяжёлый парк, тягачи, прицепную технику, CE-вакансии, ремонт, продажу и расширение парка.",
  "Тендеры, закупки и контракты. Ищи заказчиков и победителей закупок техники, ремонта и перевозок; от контракта/проекта переходи к фактическому эксплуатанту и новому грузопотоку.",
  "Грузовладельцы и отраслевые предприятия. Ищи предприятия с регулярным физическим потоком целевых грузов и параллельно их фактических перевозчиков; не включай по одному ОКВЭД без реального процесса.",
  "Суды и весогабаритный контроль. Ищи конкретные организации, технику, VIN/госномера, собственника/лизингополучателя/арендатора/эксплуатанта; судебное упоминание без транспортной связи недостаточно.",
  "Выставки, союзы и профессиональные сообщества. Используй списки участников только как discovery-источник; затем подтверждай конкретную компанию, её грузопоток/тяжёлую логистику.",
  "Инвестиции, господдержка и расширение. Ищи новые/расширяемые мощности и проекты, создающие дополнительный целевой грузопоток и потенциальную потребность в расширении или замене парка."
];

const DISCOVERY_CORE_PROMPT = `ЦЕЛЬ: найти максимум реальных организаций региона, которым потенциально нужна прицепная техника САТ из-за регулярной тяжёлой автологистики или целевого грузопотока.

ЦЕЛЕВЫЕ ГРУЗЫ: зерно/масличные/корма; щебень/песок/ПГС/грунт/торф; строительные и промышленные сыпучие; щепа/опилки/кора/биомасса/пеллетное сырьё; отходы/вторсырьё/лом; другие регулярные сыпучие или объёмные грузы.

КЛАССИФИКАЦИЯ:
A — конкретно подтверждена релевантная прицепная техника/лизинг/закупка/ремонт/VIN/госномер.
B — техники нет, но есть минимум 2 независимых сильных сигнала: целевой груз + тяжёлая логистика/тягачи/парк/лизинг/контракт/CE-вакансии/обновление.
C — подтверждён релевантный груз/процесс/перевозка, но доказательств для A/B недостаточно.
Уровень укажи в начале "Основания".

ЛИСТЫ:
direct_buyers — конечные грузовладельцы, перевозчики и эксплуатанты;
intermediaries — сервисы/дилеры/экспедиторы и иные каналы без подтверждённой собственной эксплуатации;
leasing — лизинговые/финансовые организации.
Лизингополучатель-эксплуатант остаётся direct_buyers.

DISCOVERY-ПРАВИЛА:
- web_search обязателен; используй несколько формулировок и синонимов.
- Возвращай ВСЕ подтверждённые релевантные организации, а не топ-N.
- Ищи конкретные организации; от объявления, вакансии, тендера, проекта или сервиса переходи к фактической компании.
- Не делай отдельные поиски ради ИНН, телефона, директора, email, сайта, холдинга, выручки или численности.
- Для каждой организации сохрани 1–3 уже найденных сильных URL и короткие evidence notes.
- Не выдумывай компании и факты.`;

function compactDiscoveryPrompt({
  region,
  stageIndex,
  branch,
  branchIndex,
  totalBranches,
  scope,
  extraContext = ""
}) {
  return `${DISCOVERY_CORE_PROMPT}

ЭТАП ${stageIndex + 1}: ${DISCOVERY_STAGE_HINTS[stageIndex] || ""}
ВЕТКА ${branchIndex + 1}/${totalBranches}: ${branch}
РЕГИОН: ${region}
ГЕОГРАФИЯ: ${scope}
${extraContext ? `ДОПОЛНИТЕЛЬНЫЙ КОНТЕКСТ: ${extraContext}` : ""}

Проведи самостоятельный discovery-поиск именно по этой ветке и географии. Если первые формулировки дают мало результатов — меняй запросы, площадки и синонимы. После нахождения кандидата продолжай искать следующие организации, а не обогащай уже найденную.`;
}

function compactRecoveryPrompt({
  region,
  stageIndex,
  theme,
  scope,
  alreadyFound,
  uniqueCount,
  target
}) {
  const known = alreadyFound.length
    ? `УЖЕ НАЙДЕННЫЕ — не трать поиск на повторное обнаружение: ${alreadyFound.join("; ")}`
    : "";
  return `${DISCOVERY_CORE_PROMPT}

ЭТАП ${stageIndex + 1}: ${DISCOVERY_STAGE_HINTS[stageIndex] || ""}
РЕГИОН: ${region}
ДОБОР ДЛЯ ПОЛНОТЫ: ${theme}
ГЕОГРАФИЯ: ${scope}
Сейчас найдено ${uniqueCount} уникальных организаций; мягкий ориентир ${target}+ при наличии реального рынка.
${known}

Ищи прежде всего НОВЫЕ организации и long tail. Не выполняй enrichment найденных компаний. Не выдумывай записи ради ориентира.`;
}

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
const IDENTITY_CONCURRENCY = Math.max(
  1,
  Math.min(8, Number(process.env.OPENAI_IDENTITY_CONCURRENCY || 4))
);
const IDENTITY_MAX_OUTPUT_TOKENS = Math.min(6000, OPENAI_MAX_OUTPUT_TOKENS);

const DISCOVERY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    direct_buyers: { type: "array", items: { "$ref": "#/$defs/company" } },
    intermediaries: { type: "array", items: { "$ref": "#/$defs/company" } },
    leasing: { type: "array", items: { "$ref": "#/$defs/company" } }
  },
  required: ["direct_buyers", "intermediaries", "leasing"],
  "$defs": {
    company: {
      type: "object",
      additionalProperties: false,
      properties: {
        "Организация": { type: "string" },
        "Город/район": { type: "string" },
        "Техника/сегмент": { type: "string" },
        "Основание": { type: "string" },
        "__evidence": {
          type: "object",
          additionalProperties: false,
          properties: {
            source_urls: { type: "array", items: { type: "string" } },
            notes: { type: "array", items: { type: "string" } }
          },
          required: ["source_urls", "notes"]
        }
      },
      required: [
        "Организация",
        "Город/район",
        "Техника/сегмент",
        "Основание",
        "__evidence"
      ]
    }
  }
};

const IDENTITY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    entities: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          candidate_ids: { type: "array", items: { type: "string" } },
          confirmed_inn: { type: "string" },
          legal_name: { type: "string" },
          city: { type: "string" },
          source_urls: { type: "array", items: { type: "string" } },
          note: { type: "string" }
        },
        required: [
          "candidate_ids",
          "confirmed_inn",
          "legal_name",
          "city",
          "source_urls",
          "note"
        ]
      }
    }
  },
  required: ["entities"]
};

const GEO_SCOPE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    places: { type: "array", items: { type: "string" } },
    clusters: { type: "array", items: { type: "string" } }
  },
  required: ["places", "clusters"]
};

const TEST_QUALIFICATION_BATCH_SIZE = 50;
const TEST_QUALIFICATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          decision: { type: "string", enum: ["include", "exclude"] },
          grade: { type: "string", enum: ["A", "B", ""] },
          reason: { type: "string" }
        },
        required: ["id", "decision", "grade", "reason"]
      }
    }
  },
  required: ["decisions"]
};

const FINAL_QUALIFICATION_BATCH_SIZE = Math.max(
  20,
  Math.min(80, Number(process.env.OPENAI_FINAL_QUALIFICATION_BATCH_SIZE || 50))
);

const FINAL_QUALIFICATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          decision: { type: "string", enum: ["include", "exclude"] },
          grade: { type: "string", enum: ["A", "B", "C", ""] },
          reason: { type: "string" }
        },
        required: ["id", "decision", "grade", "reason"]
      }
    }
  },
  required: ["decisions"]
};

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

  return `\n\nDISCOVERY-ФОРМАТ — ЭТАПЫ 1–9. Верни ТОЛЬКО валидный JSON без markdown:
{"direct_buyers":[],"intermediaries":[],"leasing":[]}.

ЦЕЛЬ ЭТОГО ВЫЗОВА — МАКСИМАЛЬНЫЙ RECALL КАНДИДАТОВ, А НЕ ОБОГАЩЕНИЕ.
Каждый объект должен содержать ТОЛЬКО:
{
  "Организация":"",
  "Город/район":"",
  "Техника/сегмент":"",
  "Основание":"",
  "__evidence":{"source_urls":[],"notes":[]}
}

ОБЯЗАТЕЛЬНЫЕ ПРАВИЛА:
- Сначала находи как можно больше разных релевантных организаций по текущей теме и географии.
- НЕ трать отдельные web_search на ИНН, телефон, директора/ЛПР, выручку, численность, email, холдинг/УК, официальный сайт или другие реквизиты.
- Если ИНН, телефон, сайт или иные реквизиты случайно встретились в основном источнике — можешь упомянуть их только в "__evidence.notes", но НЕ запускай для них дополнительный поиск.
- Не заполняй поля полной финальной таблицы на этом этапе. Они будут обогащены позже отдельным проходом.
- Для каждой организации сохрани 1–3 наиболее сильных URL, которые уже встретились в discovery, и коротко укажи, что именно они подтверждают.
- Возвращай ВСЕ подтверждённые релевантные организации текущей микро-задачи, а не выборку лучших.
- Не выдумывай организации, URL и факты.`;
}

function identityResolutionContract() {
  return `\n\nIDENTITY RESOLUTION — верни ТОЛЬКО валидный JSON без markdown:
{
  "entities":[
    {
      "candidate_ids":[],
      "confirmed_inn":"",
      "legal_name":"",
      "city":"",
      "source_urls":[],
      "note":""
    }
  ]
}

На входе один вероятный кластер упоминаний, а НЕ доказанный дубль.
Твоя задача — установить юридическую идентичность каждого упоминания.
Используй web_search только для идентификации юридического лица и подтверждения ИНН.

ПРАВИЛА:
- Каждый входной candidate_id должен встретиться ровно в одном объекте entities.
- Если несколько candidate_id относятся к одному и тому же юрлицу и подтверждён один и тот же ИНН — помести их вместе.
- Если это разные юрлица — раздели их по разным entities.
- confirmed_inn заполняй только подтверждённым 10- или 12-значным ИНН.
- Если ИНН надёжно подтвердить не удалось — оставь confirmed_inn пустым и НЕ объединяй сомнительные упоминания: верни их отдельными entities.
- Не ищи телефон, директора, email, выручку, численность, холдинг или другие сведения.
- legal_name и city заполняй только если удалось подтвердить.
- source_urls — 1–3 URL, подтверждающих идентичность/ИНН.
- Не выдумывай связи между компаниями.`;
}

function finalBatchContract() {
  return `\n\nПАКЕТНЫЙ ТЕХНИЧЕСКИЙ ФОРМАТ: верни ТОЛЬКО валидный JSON без markdown:
{"direct_buyers":[],"intermediaries":[],"leasing":[]}.
На входе находятся CANONICAL-компании. Каждую входную canonical-компанию верни РОВНО ОДИН РАЗ и обязательно сохрани её "__canonical_id".
Не удаляй компанию и НЕ принимай здесь окончательное решение A/B/C. Финальная qualification выполняется только после глобальной дедупликации.
Для каждой canonical-компании используй ВСЕ элементы массива evidence как единый набор доказательств и сохрани объединённый evidence в "__evidence".
"__evidence" имеет вид {"source_urls":[],"notes":[]} и должен включать уникальные URL/notes из всех упоминаний canonical-компании.
Если компания кажется нерелевантной, можешь поставить "__decision":"review" и объяснить сомнение в "__decision_reason", но не исключай её на этом шаге.
Поле "Основание" на этом шаге является СВОДКОЙ evidence, а не окончательной A/B/C оценкой; не начинай его с A/B/C.
Этот пакет обрабатывается БЕЗ web_search: не требуй нового поиска и не придумывай отсутствующие факты.
Каждый коммерческий объект содержит ключи: ${COLS.map((x) => `"${x}"`).join(", ")}, "__comment", "__canonical_id", "__decision", "__decision_reason", "__evidence".
"__comment" обязателен и содержит ровно пять смысловых строк: "Сайт/источник:", "ИНН:", "Деятельность:", "Холдинг/УК/группа:", "Email:".
Не возвращай статистику. Не выдумывай данные.`;
}

function finalQaContract() {
  return `\n\nГЛОБАЛЬНЫЙ DEDUPE/QA — верни ТОЛЬКО валидный JSON без markdown:
{
  "remove_ids": [],
  "moves": [{"id":"","sheet":"direct_buyers|intermediaries|leasing"}],
  "patches": [{"id":"","fields":{}}]
}
Не возвращай полный список компаний и не выполняй web_search.
На этом шаге решай идентичность дублей, целевой лист и фактические противоречия. НЕ назначай окончательный A/B/C — это отдельный следующий проход.
remove_ids — строки, которые действительно нужно удалить как дубли или явно ошибочные сущности.
moves — только строки, которые нужно перенести на другой коммерческий лист.
patches — исправления сохранённой строки; fields может содержать видимые коммерческие поля, "__comment" и "__evidence".
КРИТИЧНО: при схлопывании дублей ОБЪЕДИНИ "__evidence.source_urls" и "__evidence.notes" всех удаляемых дублей в сохраняемую строку через patch. Не теряй ни одного сильного доказательства.
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
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") {
    return String(value).replace(/\s+/g, " ").trim();
  }
  if (Array.isArray(value)) {
    return value.map(normalizeSearchScope).filter(Boolean).join(", ");
  }
  if (typeof value === "object") {
    const preferredKeys = [
      "name",
      "title",
      "label",
      "place",
      "city",
      "district",
      "municipality",
      "cluster",
      "territory",
      "area"
    ];
    for (const key of preferredKeys) {
      const normalized = normalizeSearchScope(value?.[key]);
      if (normalized) return normalized;
    }
    const pieces = Object.values(value)
      .map(normalizeSearchScope)
      .filter(Boolean);
    return [...new Set(pieces)].join(" — ");
  }
  return "";
}

async function discoverRegionSearchScopes(client, region) {
  const result = await askJson(client, {
    input: `Верни ТОЛЬКО JSON без markdown:
{"places":["строка"],"clusters":["строка"]}.
Для региона "${region}" перечисли 12–18 наиболее полезных географических точек для B2B-поиска тяжёлой логистики: областной центр, крупные и средние города, значимые районные центры. В clusters дай до 6 известных промышленных/аграрных/лесных/карьерных территорий или муниципальных кластеров.
ВАЖНО: каждый элемент places и clusters должен быть ПРОСТОЙ СТРОКОЙ с названием, не объектом и не структурой JSON.
Не включай населённые пункты вне региона. Используй web_search для проверки принадлежности к региону.`,
    model: MODEL,
    maxOutputTokens: 5000,
    webSearch: true,
    responseSchema: GEO_SCOPE_SCHEMA,
    schemaName: "region_search_scopes",
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

async function runResearchMicroBatch({
  client,
  region,
  stageIndex,
  branch,
  branchIndex,
  branches,
  scopes,
  extraContext = "",
  alreadyFound = []
}) {
  const selectedScopes = discoveryScopesForBranch(stageIndex, branchIndex, scopes);
  const merged = emptyResearchResult();
  const knownNames = [...alreadyFound];
  let successCount = 0;
  let firstError = null;
  let lowYieldStreak = 0;

  for (let scopeIndex = 0; scopeIndex < selectedScopes.length; scopeIndex++) {
    const scope = selectedScopes[scopeIndex];
    const beforeKnown = [...knownNames];
    const knownContext = knownNames.length
      ? `УЖЕ НАЙДЕННЫЕ В ЭТОМ РЕГИОНЕ — не трать web_search на повторное обнаружение этих организаций; ищи новые: ${knownNames.join("; ")}`
      : "";

    try {
      const value = await askResearch(
        client,
        compactDiscoveryPrompt({
          region,
          stageIndex,
          branch,
          branchIndex,
          totalBranches: branches.length,
          scope,
          extraContext: [extraContext, knownContext].filter(Boolean).join("\n")
        }),
        RESEARCH_MICRO_MAX_OUTPUT_TOKENS,
        `этап ${stageIndex + 1} | ветка ${branchIndex + 1}/${branches.length} | ${branch} | ${scope}`
      );

      const normalized = normalize(value);
      const added = countNewOrganizationsAgainstKnown(normalized, beforeKnown);
      appendResearchResult(
        merged,
        normalized,
        `branch-${branchIndex + 1}-scope-${scopeIndex + 1}`
      );
      mergeKnownOrganizationNames(knownNames, normalized);
      successCount++;

      // Первый scope всегда региональный. Низкий yield локальных scope подряд означает,
      // что дальнейшее географическое дробление в этой ветке даёт в основном повторы.
      if (scopeIndex > 0) {
        lowYieldStreak =
          added <= DISCOVERY_SCOPE_LOW_YIELD_THRESHOLD ? lowYieldStreak + 1 : 0;
        if (
          lowYieldStreak >= DISCOVERY_SCOPE_LOW_YIELD_STREAK &&
          scopeIndex + 1 < selectedScopes.length
        ) {
          console.log("[DISCOVERY_SCOPE_STOP] " + JSON.stringify({
            stage: stageIndex + 1,
            branch: branchIndex + 1,
            processed_scopes: scopeIndex + 1,
            total_scopes: selectedScopes.length,
            last_added: added,
            threshold: DISCOVERY_SCOPE_LOW_YIELD_THRESHOLD
          }));
          break;
        }
      }
    } catch (error) {
      if (!firstError) firstError = error;
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

function evidenceDomains(row) {
  const urls = Array.isArray(row?.__evidence?.source_urls)
    ? row.__evidence.source_urls
    : [];
  const domains = new Set();
  for (const raw of urls) {
    try {
      const host = new URL(String(raw)).hostname
        .toLowerCase()
        .replace(/^www\./, "");
      if (host) domains.add(host);
    } catch {}
  }
  return domains;
}

function buildIdentityClusters(candidates) {
  const parent = candidates.map((_, i) => i);

  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  const byExactName = new Map();
  const byNamePlace = new Map();
  const byDomain = new Map();

  for (let i = 0; i < candidates.length; i++) {
    const row = candidates[i]?.data || {};
    const org = normalizeOrgKey(row["Организация"]);
    const place = normalizePlaceKey(row["Город/район"]);

    if (org) {
      const exact = byExactName.get(org);
      if (exact !== undefined) union(i, exact);
      else byExactName.set(org, i);

      if (place) {
        const key = `${org}|${place}`;
        const known = byNamePlace.get(key);
        if (known !== undefined) union(i, known);
        else byNamePlace.set(key, i);
      }
    }

    for (const domain of evidenceDomains(row)) {
      // Один домен сам по себе не доказывает дубль. Объединяем по домену
      // только если нормализованное название также совпадает.
      if (!org) continue;
      const key = `${domain}|${org}`;
      const known = byDomain.get(key);
      if (known !== undefined) union(i, known);
      else byDomain.set(key, i);
    }
  }

  const groups = new Map();
  for (let i = 0; i < candidates.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(candidates[i]);
  }

  return [...groups.values()].map((items, index) => ({
    cluster_id: `i${String(index + 1).padStart(6, "0")}`,
    items
  }));
}

function compactIdentityCluster(cluster) {
  return {
    cluster_id: cluster.cluster_id,
    mentions: cluster.items.map((item) => ({
      candidate_id: item.candidate_id,
      source_step: item.source_step,
      source_sheet: item.source_sheet,
      organization: item?.data?.["Организация"] || "",
      city: item?.data?.["Город/район"] || "",
      segment: item?.data?.["Техника/сегмент"] || "",
      basis: item?.data?.["Основание"] || "",
      evidence: item?.data?.__evidence || {}
    }))
  };
}

function applyIdentityResult(cluster, result) {
  const byId = new Map(cluster.items.map((item) => [item.candidate_id, item]));
  const assigned = new Set();
  const resolved = [];

  for (const entity of Array.isArray(result?.entities) ? result.entities : []) {
    const ids = [...new Set(
      (Array.isArray(entity?.candidate_ids) ? entity.candidate_ids : [])
        .map(String)
        .filter((id) => byId.has(id) && !assigned.has(id))
    )];
    if (!ids.length) continue;

    const inn = normalizeInn(entity?.confirmed_inn);
    // Без подтвержденного ИНН не разрешаем модели склеить несколько упоминаний.
    const groups = inn ? [ids] : ids.map((id) => [id]);

    for (const groupIds of groups) {
      for (const id of groupIds) assigned.add(id);
      for (const id of groupIds) {
        const original = byId.get(id);
        const data = { ...(original?.data || {}) };
        if (inn) data["ИНН"] = inn;
        if (String(entity?.legal_name || "").trim()) {
          data["Организация"] = String(entity.legal_name).trim();
        }
        if (String(entity?.city || "").trim() && !String(data["Город/район"] || "").trim()) {
          data["Город/район"] = String(entity.city).trim();
        }

        const existingEvidence = data.__evidence || {};
        const sourceUrls = [
          ...(Array.isArray(existingEvidence.source_urls) ? existingEvidence.source_urls : []),
          ...(Array.isArray(entity?.source_urls) ? entity.source_urls : [])
        ].map(String).filter(Boolean);
        const notes = [
          ...(Array.isArray(existingEvidence.notes) ? existingEvidence.notes : []),
          entity?.note ? `Identity: ${entity.note}` : "",
          inn ? `Подтверждённый ИНН: ${inn}` : ""
        ].filter(Boolean);
        data.__evidence = {
          ...existingEvidence,
          source_urls: [...new Set(sourceUrls)],
          notes: [...new Set(notes)]
        };

        resolved.push({ ...original, data });
      }
    }
  }

  for (const item of cluster.items) {
    if (!assigned.has(item.candidate_id)) resolved.push(item);
  }
  return resolved;
}

async function resolveCandidateIdentities({
  client,
  candidates,
  region,
  prompt,
  onProgress,
  assertNotCancelled
}) {
  const clusters = buildIdentityClusters(candidates);
  const resolved = [];
  let completed = 0;
  let confirmedInnMentions = 0;
  let failedClusters = 0;

  for (let offset = 0; offset < clusters.length; offset += IDENTITY_CONCURRENCY) {
    await assertNotCancelled();
    const batch = clusters.slice(offset, offset + IDENTITY_CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map((cluster) =>
        askJson(client, {
          input:
            prompt +
            identityResolutionContract() +
            `\n\nРЕГИОН: ${region}
ВЕРОЯТНЫЙ КЛАСТЕР:
${JSON.stringify(compactIdentityCluster(cluster))}`,
          model: TARGETED_SEARCH_MODEL,
          maxOutputTokens: IDENTITY_MAX_OUTPUT_TOKENS,
          webSearch: true,
          responseSchema: IDENTITY_SCHEMA,
          schemaName: "identity_resolution",
          diagnosticLabel:
            `identity | ${cluster.cluster_id} | ${cluster.items.map((x) => x?.data?.["Организация"] || "").join(" / ")}`
        })
      )
    );

    for (let i = 0; i < settled.length; i++) {
      const cluster = batch[i];
      const item = settled[i];
      if (item.status === "fulfilled") {
        const rows = applyIdentityResult(cluster, item.value);
        confirmedInnMentions += rows.filter((x) => normalizeInn(x?.data?.["ИНН"])).length;
        resolved.push(...rows);
      } else {
        failedClusters++;
        resolved.push(...cluster.items);
      }
      completed++;
    }

    await onProgress({
      completed,
      total: clusters.length,
      confirmedInnMentions,
      failedClusters
    });
  }

  return {
    candidates: resolved,
    clusters: clusters.length,
    confirmedInnMentions,
    failedClusters
  };
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

function mergedEvidenceFromCanonical(canonical) {
  const sourceUrls = [];
  const notes = [];
  for (const evidenceItem of canonical?.evidence || []) {
    const ev = evidenceItem?.data?.__evidence || {};
    for (const url of Array.isArray(ev.source_urls) ? ev.source_urls : []) {
      if (url) sourceUrls.push(String(url));
    }
    for (const note of Array.isArray(ev.notes) ? ev.notes : []) {
      if (note) notes.push(String(note));
    }
  }
  return {
    source_urls: [...new Set(sourceUrls)],
    notes: [...new Set(notes)]
  };
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

  row.__evidence = mergedEvidenceFromCanonical(canonical);
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
      const canonical = byCanonicalId.get(id);
      output[sheet].push({
        ...row,
        __evidence: mergedEvidenceFromCanonical(canonical)
      });
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
  const allowedFields = new Set([...COLS, "__comment", "__decision", "__decision_reason", "__evidence", "__final_grade"]);
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

function finalQualificationInput(records) {
  return records.map((record) => ({
    id: record.id,
    sheet: record.sheet,
    canonical_id: record.canonical_id,
    organization: record?.row?.["Организация"] || "",
    city: record?.row?.["Город/район"] || "",
    segment: record?.row?.["Техника/сегмент"] || "",
    basis_summary: record?.row?.["Основание"] || "",
    inn: record?.row?.["ИНН"] || "",
    evidence: record?.row?.__evidence || { source_urls: [], notes: [] }
  }));
}

async function runFinalQualification({
  client,
  records,
  region,
  assertNotCancelled,
  diagnosticPrefix = "final qualification"
}) {
  const decisions = new Map();
  let completed = 0;

  for (let offset = 0; offset < records.length; offset += FINAL_QUALIFICATION_BATCH_SIZE) {
    await assertNotCancelled();
    const batchRecords = records.slice(offset, offset + FINAL_QUALIFICATION_BATCH_SIZE);
    const batch = finalQualificationInput(batchRecords);
    const batchNumber = Math.floor(offset / FINAL_QUALIFICATION_BATCH_SIZE) + 1;

    const result = await askJson(client, {
      input: `ФИНАЛЬНАЯ КВАЛИФИКАЦИЯ ПОСЛЕ IDENTITY, DEDUPE И MERGE EVIDENCE.
РЕГИОН: ${region}

Это ОКОНЧАТЕЛЬНОЕ решение A/B/C по каждой уже дедуплицированной организации.
Используй ТОЛЬКО переданные данные и объединённый evidence. Новый web_search запрещён.
Игнорируй предварительные A/B/C из discovery и оцени компанию заново.

A — есть конкретное подтверждение релевантной ПРИЦЕПНОЙ техники/полуприцепа/прицепа, её лизинга, закупки, ремонта, VIN/госномера или явной эксплуатации тягач + релевантный полуприцеп.
B — конкретная релевантная прицепная техника не подтверждена, но одновременно подтверждены (1) целевой груз/процесс и (2) тяжёлая автологистика/эксплуатационный сигнал: тягачи, тяжёлый парк, профильные перевозки, CE/Е-вакансии в релевантном контексте, транспортный контракт, лизинг/обновление тяжёлого парка.
C — подтверждён релевантный груз/процесс/перевозка, но evidence недостаточно для A/B; компания остаётся потенциальной, но требует дополнительной проверки.
EXCLUDE — нет достаточной связи с целевым грузом/процессом и тяжёлой логистикой, организация является ошибочной сущностью/каталогом/площадкой либо evidence не подтверждает коммерческую релевантность.

ПРАВИЛА:
- Для каждого входного id верни ровно одно решение.
- include требует grade A, B или C.
- exclude требует пустой grade.
- reason — одно конкретное, проверяемое объяснение по объединённому evidence.
- Не повышай класс из-за слов "возможен", "потенциально", "может использовать".
- Самосвал без прицепа сам по себе НЕ A.
- Тягач без целевого груза сам по себе НЕ B.
- Целевой груз без тяжёлой автологистики сам по себе максимум C.
- Не добавляй новых фактов.

ОРГАНИЗАЦИИ:
${JSON.stringify(batch)}`,
      model: FINAL_QA_MODEL,
      maxOutputTokens: FINAL_QA_MAX_OUTPUT_TOKENS,
      webSearch: false,
      responseSchema: FINAL_QUALIFICATION_SCHEMA,
      schemaName: "final_company_qualification",
      diagnosticLabel: `${diagnosticPrefix} | batch ${batchNumber}`
    });

    const allowed = new Set(batchRecords.map((x) => x.id));
    for (const item of result?.decisions || []) {
      const id = String(item?.id || "");
      if (!allowed.has(id) || decisions.has(id)) continue;
      const include = item?.decision === "include";
      const grade = include && ["A", "B", "C"].includes(item?.grade) ? item.grade : "";
      decisions.set(id, {
        decision: grade ? "include" : "exclude",
        grade,
        reason: String(item?.reason || "").trim()
      });
    }

    completed += batchRecords.length;
    console.log("[FINAL_QUALIFICATION_PROGRESS] " + JSON.stringify({
      prefix: diagnosticPrefix,
      completed,
      total: records.length,
      batch: batchNumber
    }));
  }

  return decisions;
}

function applyFinalQualification(records, decisions) {
  const result = {
    direct_buyers: [],
    intermediaries: [],
    leasing: [],
    statistics: []
  };
  const counts = { A: 0, B: 0, C: 0, excluded: 0 };

  for (const record of records) {
    const decision = decisions.get(record.id);
    if (!decision || decision.decision !== "include" || !decision.grade) {
      counts.excluded++;
      continue;
    }

    const row = { ...record.row };
    row.__final_grade = decision.grade;
    row.__decision = "include";
    row.__decision_reason = decision.reason;
    row["Основание"] = `${decision.grade} — ${decision.reason}`;
    counts[decision.grade]++;

    result[record.sheet].push(row);
  }

  return { result, counts };
}

function diagnosticRowCount(data) {
  return (
    (Array.isArray(data?.direct_buyers) ? data.direct_buyers.length : 0) +
    (Array.isArray(data?.intermediaries) ? data.intermediaries.length : 0) +
    (Array.isArray(data?.leasing) ? data.leasing.length : 0)
  );
}

function diagnosticEvidenceUrlCount(data) {
  let count = 0;
  for (const row of [
    ...(data?.direct_buyers || []),
    ...(data?.intermediaries || []),
    ...(data?.leasing || [])
  ]) {
    count += Array.isArray(row?.__evidence?.source_urls)
      ? row.__evidence.source_urls.length
      : 0;
  }
  return count;
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
  diagnosticLabel = "",
  responseSchema = null,
  schemaName = "structured_output",
  allowJsonRepair = true
}) {
  const request = {
    model,
    input,
    max_output_tokens: maxOutputTokens
  };
  if (responseSchema) {
    request.text = {
      format: {
        type: "json_schema",
        name: schemaName,
        strict: true,
        schema: responseSchema
      }
    };
  }
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
    let repaired = false;
    let repairUsage = null;
    try {
      parsed = parseJson(response.output_text || "");
    } catch (error) {
      parseError = error?.message || "parse error";

      if (
        allowJsonRepair &&
        response.status === "completed" &&
        String(response.output_text || "").trim()
      ) {
        try {
          const repairStartedAt = Date.now();
          const repairRequest = {
            model,
            input:
              "Исправь ТОЛЬКО синтаксис/структуру следующего ответа JSON. " +
              "Не добавляй новые факты, компании, URL или выводы. " +
              "Сохрани всю информацию исходного ответа, которую можно однозначно восстановить.\n\n" +
              String(response.output_text || ""),
            max_output_tokens: Math.min(maxOutputTokens, 12000)
          };
          if (responseSchema) {
            repairRequest.text = {
              format: {
                type: "json_schema",
                name: schemaName + "_repair",
                strict: true,
                schema: responseSchema
              }
            };
          } else {
            repairRequest.text = { format: { type: "json_object" } };
          }

          const repairedResponse = await client.responses.create(
            repairRequest,
            requestOptions
          );
          if (!repairedResponse.status || repairedResponse.status === "completed") {
            parsed = parseJson(repairedResponse.output_text || "");
            repaired = true;
            parseError = "";
            repairUsage = repairedResponse?.usage || null;
            console.log("[OPENAI_JSON_REPAIR] " + JSON.stringify({
              query,
              model,
              schema_name: responseSchema ? schemaName : null,
              duration_ms: Date.now() - repairStartedAt,
              input_tokens: repairUsage?.input_tokens ?? null,
              output_tokens: repairUsage?.output_tokens ?? null,
              reasoning_tokens: repairUsage?.output_tokens_details?.reasoning_tokens ?? null,
              rows_recovered: diagnosticRowCount(parsed)
            }));
          }
        } catch (repairError) {
          console.error("[OPENAI_JSON_REPAIR] " + JSON.stringify({
            query,
            model,
            schema_name: responseSchema ? schemaName : null,
            status: "error",
            error: repairError?.message || String(repairError)
          }));
        }
      }
    }

    console.log("[OPENAI_DIAG] " + JSON.stringify({
      query,
      model,
      web_search: webSearch,
      file_search: Boolean(fileSearchVectorStoreId),
      structured_output: Boolean(responseSchema),
      schema_name: responseSchema ? schemaName : null,
      initial_prompt_chars: String(input || "").length,
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
      evidence_urls: parsed ? diagnosticEvidenceUrlCount(parsed) : null,
      json_repaired: repaired,
      repair_input_tokens: repairUsage?.input_tokens ?? null,
      repair_output_tokens: repairUsage?.output_tokens ?? null,
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
      structured_output: Boolean(responseSchema),
      schema_name: responseSchema ? schemaName : null,
      initial_prompt_chars: String(input || "").length,
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
    responseSchema: DISCOVERY_SCHEMA,
    schemaName: "research_discovery",
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

  if (isMissingText(row?.["Выручка последнего подтвержденного года"])) {
    gaps.push("выручка последнего подтвержденного года");
  }
  if (isMissingText(row?.["Численность"])) {
    gaps.push("численность");
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


function testCandidateGrade(row) {
  const basis = String(row?.["Основание"] || "").trim().toUpperCase();
  if (basis.startsWith("A")) return "A";
  if (basis.startsWith("B")) return "B";
  return "";
}

function buildTestQualificationCandidates(parts) {
  const groups = new Map();
  let sequence = 0;

  for (let stageIndex = 0; stageIndex < parts.length; stageIndex++) {
    for (const row of allResearchRows(parts[stageIndex])) {
      const grade = testCandidateGrade(row);
      if (!grade) continue;

      const org = String(row?.["Организация"] || "").trim();
      const orgKey = normalizeOrgKey(org);
      if (!orgKey) continue;
      const place = String(row?.["Город/район"] || "").trim();
      const placeKey = normalizePlaceKey(place);
      const key = `${orgKey}|${placeKey}`;

      if (!groups.has(key)) {
        sequence++;
        groups.set(key, {
          id: `tq${String(sequence).padStart(5, "0")}`,
          organization: org,
          city: place,
          stages: new Set(),
          grades: new Set(),
          segments: new Set(),
          bases: new Set(),
          source_urls: new Set(),
          notes: new Set()
        });
      }

      const item = groups.get(key);
      item.stages.add(stageIndex + 1);
      item.grades.add(grade);
      if (row?.["Техника/сегмент"]) item.segments.add(String(row["Техника/сегмент"]).trim());
      if (row?.["Основание"]) item.bases.add(String(row["Основание"]).trim());
      for (const url of row?.__evidence?.source_urls || []) {
        if (url) item.source_urls.add(String(url));
      }
      for (const note of row?.__evidence?.notes || []) {
        if (note) item.notes.add(String(note));
      }
    }
  }

  return [...groups.values()].map((item) => ({
    id: item.id,
    organization: item.organization,
    city: item.city,
    stages: [...item.stages].sort(),
    discovery_grades: [...item.grades],
    segments: [...item.segments].slice(0, 8),
    bases: [...item.bases].slice(0, 12),
    evidence: {
      source_urls: [...item.source_urls].slice(0, 12),
      notes: [...item.notes].slice(0, 16)
    }
  }));
}

async function qualifyTestCandidates({ client, candidates, region, assertNotCancelled }) {
  const qualified = [];
  let excluded = 0;

  for (let offset = 0; offset < candidates.length; offset += TEST_QUALIFICATION_BATCH_SIZE) {
    await assertNotCancelled();
    const batch = candidates.slice(offset, offset + TEST_QUALIFICATION_BATCH_SIZE);

    const result = await askJson(client, {
      input: `ПРОВЕРКА КАЧЕСТВА КАНДИДАТОВ ТЕСТА ЭТАПОВ 1–2.
РЕГИОН: ${region}

Оцени ТОЛЬКО переданный evidence. Новый web_search запрещён.
Нужно оставить только компании, которые действительно релевантны продаже прицепной техники САТ.

INCLUDE:
A — есть конкретное подтверждение релевантной прицепной техники, предмета лизинга, VIN/госномера, закупки/ремонта/эксплуатации такой техники.
B — конкретной прицепной техники нет, но evidence подтверждает одновременно реальный целевой груз/процесс И тяжёлую автологистику/эксплуатационный сигнал (собственный или лизинговый тяжёлый парк, тягачи, профильные перевозки, CE-вакансии в релевантном контексте, транспортный контракт, обновление/ремонт парка).

EXCLUDE:
- только отрасль, ОКВЭД или общий профиль компании;
- только целевой груз без подтверждения тяжёлой автологистики;
- только вакансия без достаточной привязки к релевантному процессу;
- посредник/каталог/площадка, ошибочно принятые за конечного пользователя, если нет собственной эксплуатации;
- лизингодатель без релевантной роли для нашего списка;
- evidence не подтверждает заявленный A/B;
- связь основана на предположении.

Для каждого входного id верни ровно одно решение. При сомнении EXCLUDE.
reason — коротко и конкретно, какой факт делает компанию подходящей либо почему evidence недостаточно.
Не добавляй никаких новых фактов.

КАНДИДАТЫ:
${JSON.stringify(batch)}`,
      model: FINAL_QA_MODEL,
      maxOutputTokens: 16000,
      webSearch: false,
      responseSchema: TEST_QUALIFICATION_SCHEMA,
      schemaName: "test12_qualification",
      diagnosticLabel: `test12 qualification | batch ${Math.floor(offset / TEST_QUALIFICATION_BATCH_SIZE) + 1}`
    });

    const byId = new Map(batch.map((x) => [x.id, x]));
    const seen = new Set();
    for (const decision of result?.decisions || []) {
      const id = String(decision?.id || "");
      if (!id || seen.has(id) || !byId.has(id)) continue;
      seen.add(id);
      const source = byId.get(id);

      if (decision.decision === "include" && (decision.grade === "A" || decision.grade === "B")) {
        qualified.push({
          id,
          organization: source.organization,
          city: source.city,
          grade: decision.grade,
          reason: String(decision.reason || "").trim(),
          stages: source.stages,
          segments: source.segments,
          source_urls: source.evidence.source_urls.slice(0, 3)
        });
      } else {
        excluded++;
      }
    }

    // Missing decision = conservative exclude.
    excluded += batch.length - seen.size;
  }

  qualified.sort((a, b) => {
    if (a.grade !== b.grade) return a.grade === "A" ? -1 : 1;
    return a.organization.localeCompare(b.organization, "ru");
  });

  for (const company of qualified) {
    console.log("[TEST12_QUALIFIED_COMPANY] " + JSON.stringify({
      id: company.id,
      organization: company.organization,
      city: company.city,
      grade: company.grade,
      reason: company.reason,
      stages: company.stages,
      segments: company.segments,
      source_urls: company.source_urls
    }));
  }

  console.log("[TEST12_QUALIFICATION] " + JSON.stringify({
    candidates: candidates.length,
    qualified: qualified.length,
    excluded
  }));

  return { qualified, excluded };
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
  console.log("[RESEARCH_SCOPES] " + JSON.stringify({
    region,
    scopes: researchScopes
  }));
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
        `ветка ${branchIndex + 1} / ${branches.length} · adaptive geo-scope · ${before} уникальных`;
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

      const alreadyFound = discoveryKnownNames(combined);
      const branchScopes = discoveryScopesForBranch(i, branchIndex, researchScopes);
      const branchResult = await runResearchMicroBatch({
        client,
        region,
        stageIndex: i,
        branch: branches[branchIndex],
        branchIndex,
        branches,
        scopes: researchScopes,
        extraContext,
        alreadyFound
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
      const alreadyFound = foundOrganizationNames(combined, 80);
      const theme = RESEARCH_RECOVERY_THEMES[recoveryIndex % RESEARCH_RECOVERY_THEMES.length];

      statuses[i].detail =
        `добор ${recoveryIndex + 1} · ${before} / ориентир ${RESEARCH_SOFT_TARGET}`;
      await progress({ phase: "research", step: i + 1, percent: i * 9 + 8 });

      const tasks = researchScopes.map((scope) =>
        askResearch(
          client,
          compactRecoveryPrompt({
            region,
            stageIndex: i,
            theme,
            scope,
            alreadyFound,
            uniqueCount: before,
            target: RESEARCH_SOFT_TARGET
          }),
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
    const discoveryUnique = uniqueResearchCount(combinedTest);

    await assertNotCancelled();
    await progress({ phase: "qualification", step: 2, percent: 92 });

    const candidatePool = flattenCandidates(parts);
    const identityResolution = await resolveCandidateIdentities({
      client,
      candidates: candidatePool,
      region,
      prompt: prompts[9],
      assertNotCancelled,
      onProgress: async ({ completed, total, confirmedInnMentions, failedClusters }) => {
        await progress({
          phase: "qualification",
          step: 2,
          percent: 92 + Math.floor((completed / Math.max(1, total)) * 2),
          qualificationDetail:
            `identity ${completed}/${total}; ИНН: ${confirmedInnMentions}` +
            (failedClusters ? `; ошибок: ${failedClusters}` : "")
        });
      }
    });

    const canonicalPool = canonicalizeCandidates(identityResolution.candidates);
    const canonicalMap = new Map(canonicalPool.map((x) => [x.canonical_id, x]));
    const stagedTest = { direct_buyers: [], intermediaries: [], leasing: [] };

    for (const canonical of canonicalPool) {
      const row = baselineRowFromCanonical(canonical);
      const sheet = canonical.source_sheets.includes("Лизинг")
        ? "leasing"
        : canonical.source_sheets.includes("Прямые покупатели")
          ? "direct_buyers"
          : "intermediaries";
      stagedTest[sheet].push(row);
    }

    let qaRecords = makeQaRecords(stagedTest);
    await progress({
      phase: "qualification",
      step: 2,
      percent: 95,
      qualificationDetail: `global dedupe: ${qaRecords.length} canonical-строк`
    });

    const qa = await askWithoutSearch(
      client,
      prompts[9] +
        finalQaContract() +
        `\n\nРЕГИОН: ${region}
Это ТЕСТ этапов 1–2. Переданы canonical-строки после identity resolution.
Выполни только глобальную дедупликацию/QA. Не назначай A/B/C.
Разные подтверждённые ИНН не объединяй.
При удалении дубля объедини __evidence в сохраняемую строку.
Никакого web_search.

СТРОКИ:
${JSON.stringify(qaRecords)}`,
      FINAL_QA_MODEL,
      FINAL_QA_MAX_OUTPUT_TOKENS
    );

    const dedupedTest = applyFinalQa(qaRecords, qa);
    qaRecords = makeQaRecords(dedupedTest);

    await progress({
      phase: "qualification",
      step: 2,
      percent: 97,
      qualificationDetail: `финальная A/B/C: ${qaRecords.length} уникальных строк`
    });

    const decisions = await runFinalQualification({
      client,
      records: qaRecords,
      region,
      assertNotCancelled,
      diagnosticPrefix: "test12 final qualification"
    });
    const qualified = applyFinalQualification(qaRecords, decisions);

    const qualifiedCompanies = [];
    for (const sheet of ["direct_buyers", "intermediaries", "leasing"]) {
      for (const row of qualified.result[sheet]) {
        const canonical = canonicalMap.get(row.__canonical_id);
        qualifiedCompanies.push({
          id: row.__canonical_id || "",
          organization: row["Организация"] || "",
          city: row["Город/район"] || "",
          grade: row.__final_grade || "",
          reason: row.__decision_reason || "",
          stages: canonical?.source_steps || [],
          segments: String(row["Техника/сегмент"] || "")
            .split("|")
            .map((x) => x.trim())
            .filter(Boolean)
            .slice(0, 8),
          source_urls: (row?.__evidence?.source_urls || []).slice(0, 3),
          sheet
        });
      }
    }

    qualifiedCompanies.sort((a, b) => {
      const rank = { A: 0, B: 1, C: 2 };
      const gradeDiff = (rank[a.grade] ?? 9) - (rank[b.grade] ?? 9);
      return gradeDiff || a.organization.localeCompare(b.organization, "ru");
    });

    for (const company of qualifiedCompanies) {
      console.log("[TEST12_QUALIFIED_COMPANY] " + JSON.stringify(company));
    }

    console.log("[TEST12_QUALIFICATION] " + JSON.stringify({
      raw_mentions: candidatePool.length,
      identity_clusters: identityResolution.clusters,
      canonical_after_inn: canonicalPool.length,
      after_global_dedupe: qaRecords.length,
      A: qualified.counts.A,
      B: qualified.counts.B,
      C: qualified.counts.C,
      excluded: qualified.counts.excluded,
      qualified: qualifiedCompanies.length
    }));

    await progress({ phase: "completed", step: 2, percent: 100 });
    return {
      mode: "test12",
      result: qualified.result,
      region,
      counts: {
        total_rows: totalRows,
        unique: discoveryUnique,
        stage1_rows: rowCount(parts[0] || emptyResearchResult()),
        stage1_unique: uniqueResearchCount(parts[0] || emptyResearchResult()),
        stage2_rows: rowCount(parts[1] || emptyResearchResult()),
        stage2_unique: uniqueResearchCount(parts[1] || emptyResearchResult()),
        raw_mentions: candidatePool.length,
        identity_clusters: identityResolution.clusters,
        canonical_after_inn: canonicalPool.length,
        after_global_dedupe: qaRecords.length,
        A: qualified.counts.A,
        B: qualified.counts.B,
        C: qualified.counts.C,
        qualified: qualifiedCompanies.length,
        excluded_after_qualification: qualified.counts.excluded
      },
      qualified_companies: qualifiedCompanies,
      contacts: { total: 0, checked: 0, skipped: 0, ok: 0, unavailable: 0, notFound: 0 }
    };
  }

  await assertNotCancelled();
  startStep(statuses[9]);
  const candidatePool = flattenCandidates(parts);

  statuses[9].detail = `identity resolution · подготовка ${candidatePool.length} упоминаний`;
  await progress({ phase: "dedupe", step: 10, percent: 81 });

  const identityResolution = await resolveCandidateIdentities({
    client,
    candidates: candidatePool,
    region,
    prompt: prompts[9],
    assertNotCancelled,
    onProgress: async ({ completed, total, confirmedInnMentions, failedClusters }) => {
      statuses[9].detail =
        `identity resolution · ${completed} / ${total} кластеров · ИНН подтверждён для ${confirmedInnMentions} упоминаний` +
        (failedClusters ? ` · ошибок: ${failedClusters}` : "");
      await progress({
        phase: "dedupe",
        step: 10,
        percent: 81 + Math.floor((completed / Math.max(1, total)) * 3)
      });
    }
  });

  const canonicalPool = canonicalizeCandidates(identityResolution.candidates);
  console.log("[IDENTITY_SUMMARY] " + JSON.stringify({
    region,
    mentions: candidatePool.length,
    probable_clusters: identityResolution.clusters,
    confirmed_inn_mentions: identityResolution.confirmedInnMentions,
    failed_clusters: identityResolution.failedClusters,
    canonical_after_inn: canonicalPool.length
  }));

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
Это пакет CANONICAL-компаний после discovery 1–9 и отдельного identity-resolution прохода.
До этого шага похожие упоминания использовались только как вероятные кластеры для поиска юридической идентичности. Программно объединены только строки с одинаковым подтверждённым ИНН.
Строки без подтверждённого ИНН НЕ были окончательно объединены только по названию, городу, домену или похожести и должны разбираться на глобальном QA по совокупности признаков.
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
Выполни глобальную дедупликацию и QA только по переданным данным.
НЕ выполняй A/B/C-квалификацию: она будет отдельным следующим проходом после дедупликации.
Не переписывай весь массив компаний: верни только remove_ids, moves и patches.
Разные подтверждённые ИНН никогда не объединяй.
При удалении дубля обязательно перенеси его evidence в сохраняемую строку.
Работай без web_search.

КОММЕРЧЕСКИЕ СТРОКИ JSON:
${JSON.stringify(qaRecords)}`,
    FINAL_QA_MODEL,
    FINAL_QA_MAX_OUTPUT_TOKENS
  );

  const dedupedResult = applyFinalQa(qaRecords, qa);
  const dedupedRecords = makeQaRecords(dedupedResult);

  statuses[9].detail = `финальная A/B/C qualification · ${dedupedRecords.length} уникальных строк`;
  await progress({ phase: "dedupe", step: 10, percent: 89 });

  const finalDecisions = await runFinalQualification({
    client,
    records: dedupedRecords,
    region,
    assertNotCancelled,
    diagnosticPrefix: "full final qualification"
  });
  const qualifiedFinal = applyFinalQualification(dedupedRecords, finalDecisions);
  const finalResult = qualifiedFinal.result;

  console.log("[FINAL_QUALIFICATION_SUMMARY] " + JSON.stringify({
    region,
    input_rows: dedupedRecords.length,
    A: qualifiedFinal.counts.A,
    B: qualifiedFinal.counts.B,
    C: qualifiedFinal.counts.C,
    excluded: qualifiedFinal.counts.excluded,
    output_rows: rowCount(finalResult)
  }));

  await assertNotCancelled();
  const finalCompaniesForEnrichment = [
    ...finalResult.direct_buyers,
    ...finalResult.intermediaries,
    ...finalResult.leasing
  ];
  let targetedSearches = 0;

  for (const row of finalCompaniesForEnrichment) {
    const gaps = missingResearchFields(row);
    if (!gaps.length) continue;

    await assertNotCancelled();
    targetedSearches++;
    statuses[9].detail =
      `точечное enrichment после qualification ${targetedSearches} · ${row["Организация"] || ""}`;
    await progress({ phase: "dedupe", step: 10, percent: 89 });

    const enriched = await askTargetedSearch(
      client,
      prompts[9] +
        targetedSearchContract() +
        `\n\nРЕГИОН: ${region}
КОМПАНИЯ:
${JSON.stringify(row)}
НЕДОСТАЮЩИЕ СВЕДЕНИЯ:
${JSON.stringify(gaps)}
Компания уже прошла identity, global dedupe и финальную A/B/C qualification.
Сделай один точечный web_search только по этой компании. Ищи только перечисленные недостающие сведения. Не перепроверяй заполненные поля без необходимости.`
    );
    applyTargetedPatch(row, enriched);
  }

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
  statuses[9].detail =
    `выполнен · ${rowCount(finalResult)} организаций · identity-кластеров: ${identityResolution.clusters} · точечных поисков: ${targetedSearches}`;
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
