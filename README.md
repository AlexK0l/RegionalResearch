# RegionalResearch

Веб-приложение для регионального поиска потенциальных покупателей CAT.

## Как работает

1. Пользователь выбирает регион.
2. Шаги 1–9 выполняют последовательный поиск через OpenAI Responses API с web_search.
3. Шаг 10 объединяет результаты и выполняет дедупликацию.
4. Шаг 11 открывает Chromium через Playwright и пытается найти публичные контакты компаний через интерфейс Google AI Mode.
5. После завершения формируется итоговый XLSX.

## Структура

- `server.js` — Express Web Service и API заданий.
- `src/` — исследовательский pipeline, Google AI Mode и генерация XLSX.
- `prompts/` — инструкции шагов 1–10.
- `public/` — пользовательский интерфейс.
- `render.yaml` — конфигурация Render.

## Локальный запуск

```bash
npm install
npx playwright install chromium
OPENAI_API_KEY=... npm start
```

По умолчанию приложение слушает `PORT` или порт `10000`.

## Render

Основная ветка: `main`.

Build command:

```bash
npm install && npx playwright install chromium
```

Start command:

```bash
node server.js
```

Переменные окружения:

```env
OPENAI_API_KEY=...
OPENAI_MAX_OUTPUT_TOKENS=128000
OPENAI_FINAL_BATCH_SIZE=60
COMPUTER_MODEL=gpt-5.6-luna
COMPUTER_FALLBACK_MODEL=gpt-5.6-sol
GOOGLE_AI_MAX_TURNS=6
GOOGLE_AI_VIEWPORT_WIDTH=1024
GOOGLE_AI_VIEWPORT_HEIGHT=768
GOOGLE_AI_SCREENSHOT_DETAIL=low
```

Шаги 1–9 ограничиваются 50 000 output tokens. Шаг 10 обрабатывает общий пул пакетами по 60 кандидатов, затем отдельным компактным QA-вызовом выполняет глобальную дедупликацию между пакетами и формирует статистику. Значение `OPENAI_MAX_OUTPUT_TOKENS` служит общим верхним потолком для API-вызовов.

Google API не используется. Google AI Mode запускается только для компаний, где после основного исследования отсутствует подтверждённый телефон или ЛПР. Одна Chromium-сессия переиспользуется между компаниями. Основная computer-use модель — GPT-5.6 Luna; GPT-5.6 Sol используется как fallback при технической недоступности/неудаче Luna. Лимит computer-use — 6 ходов, viewport 1024×768, screenshot detail — low. Если Google показывает CAPTCHA, требует вход или не предоставляет AI Mode, приложение не пытается обходить защиту.
