# Развёртывание RegionalResearch на Time4VPS (Ubuntu/Debian)

**Архитектура:** VPS → Caddy (автоматический HTTPS на домене) → Node.js на 127.0.0.1:10000. Исследования выполняются на VPS, клиенту достаточно браузера. Отдельная системная учётная запись `regionalresearch`, постоянная SQLite база в `/opt/regionalresearch/data`, журналы в `logs/`, Python venv с `openpyxl` для строгого 5-листного XLSX. Автоматические ежедневные согласованные SQLite backups через systemd timer.

Не требуются Docker, Render, переписывание приложения на Python, отдельные личные кабинеты или платные тестовые исследования. **Поддерживаются Ubuntu 22.04/24.04 и Debian 12/13 с systemd.** Не применяйте этот скрипт на других ОС без адаптации.

## 0. Что нужно до установки

- Публичный IPv4 VPS и SSH-доступ с `sudo` (не присылайте пароли и приватные ключи).
- Желательно DNS-домен/поддомен, например `research.example.org`, с A-записью на IPv4 VPS. Дождитесь обновления DNS до настройки сертификата.
- Открытые извне TCP **22** (SSH), **80** (ACME/HTTP) и **443** (HTTPS). **10000 не открывать**. Перед включением UFW убедитесь, что разрешён ваш действующий SSH-порт (если не 22 — добавьте собственный).
- Узнайте ресурсы `free -h`, `df -h`, `nproc`; 10 параллельных полноценных исследований на слабом VPS могут переполнить память и исчерпать лимиты OpenAI. Для начала устанавливайте `MAX_ACTIVE_FULL_JOBS=2` (или 1).
- С вашего Windows компьютера: `.env` и **обезличенный** `data/SAT_reference_template.xlsx`. Не загружайте секреты в GitHub.
- Для переноса старой истории по желанию: согласованная копия `checkpoints.sqlite`. На Windows SQLite в WAL-режиме: делайте backup через SQLite API или останавливайте локальное приложение перед копированием базы вместе с нужными WAL-данными. Одну живую .sqlite копировать недостаточно.

## 1. Начальная настройка сервера

В панели Time4VPS установите Ubuntu 24.04 LTS или Debian 12 (если VPS ещё не настроен). **Переустановка стирает данные**: не переустанавливайте действующий VPS без резервной копии.

Подключитесь по SSH. На VPS:

```bash
sudo apt-get update
sudo apt-get install -y git
git clone --depth 1 --branch main \
  https://github.com/AlexK0l/RegionalResearch.git /tmp/regionalresearch-bootstrap
sudo bash /tmp/regionalresearch-bootstrap/deploy/time4vps/install.sh
```

Установщик клонирует **main** в `/opt/regionalresearch`, создаёт `regionalresearch`, Node.js 22+ (если нет), Python/openpyxl, Caddy, systemd units и директории. Не запускает исследования и не публикует HTTP. Перед исполнением скачиваемого NodeSource установочного скрипта можно самостоятельно проверить его содержимое.

Развёртывание рекомендуется выполнять **после слияния deployment PR в `main`**, чтобы сервер получал обновления из основной ветки.

## 2. Перенести .env и Excel-шаблон (выполняется на Windows ПК)

В PowerShell Windows, *не на VPS* (поменяйте `SERVER_IP` и `SSH_USER`):

```powershell
scp "D:\RegionalResearch\.env" SSH_USER@SERVER_IP:/tmp/regionalresearch.env
scp "D:\RegionalResearch\data\SAT_reference_template.xlsx" SSH_USER@SERVER_IP:/tmp/SAT_reference_template.xlsx
```

На VPS:

```bash
sudo install -o regionalresearch -g regionalresearch -m 600 \
  /tmp/regionalresearch.env /opt/regionalresearch/.env
sudo install -o regionalresearch -g regionalresearch -m 600 \
  /tmp/SAT_reference_template.xlsx /opt/regionalresearch/data/SAT_reference_template.xlsx
sudo rm -f /tmp/regionalresearch.env /tmp/SAT_reference_template.xlsx
sudo nano /opt/regionalresearch/.env
```

**Обязательно установите или проверьте** следующие строки (остальные параметры исследования оставьте прежними):

```dotenv
PORT=10000
BIND_HOST=127.0.0.1
NODE_ENV=production
OPENAI_API_KEY=ВАШ_НАСТОЯЩИЙ_КЛЮЧ
API_ACCESS_TOKEN=ДЛИННЫЙ_СЛУЧАЙНЫЙ_СЕКРЕТ
CHECKPOINT_DB_PATH=/opt/regionalresearch/data/checkpoints.sqlite
LOG_DIR=/opt/regionalresearch/logs
SAT_XLSX_TEMPLATE_PATH=/opt/regionalresearch/data/SAT_reference_template.xlsx
SAT_PYTHON_BIN=/opt/regionalresearch/.venv/bin/python
GOOGLE_AI_FALLBACK_ENABLED=false
MAX_ACTIVE_FULL_JOBS=2
```

Сгенерировать случайный токен прямо на сервере: `openssl rand -hex 32`. Скопируйте его в `API_ACCESS_TOKEN`. Это **отдельный** токен доступа пользователей, **не OpenAI API key**. Не пересылайте секреты в чат. UI сам запросит токен и хранит его в sessionStorage текущего браузера. При использовании других устройств вводите этот токен отдельно. Если используете общий компьютер, не вводите токен.

Примечание: исходный файл `.env.example` содержит несколько сотен строк и значения по умолчанию; **не меняйте правила исследования и лимиты стоимости ради переезда**. `OPENAI_MAX_RESEARCH_COST_USD` — порог расчётной стоимости **одного** исследования, не общий лимит биллинга десяти исследований.

Проверка готовности (не расходует OpenAI):

```bash
sudo bash /opt/regionalresearch/deploy/time4vps/check-ready.sh
sudo systemctl enable --now regionalresearch
sudo systemctl status regionalresearch --no-pager
curl -fsS http://127.0.0.1:10000/health
```

## 3. HTTPS и доступ снаружи

Настройте A-запись DNS: `research.example.org → публичный IPv4 VPS`. Если есть AAAA-запись, IPv6 тоже должен вести на этот VPS и обслуживать порт 443, иначе удалите ошибочный AAAA.

Создайте `/etc/caddy/Caddyfile`:

```caddyfile
research.example.org {
    encode zstd gzip
    reverse_proxy 127.0.0.1:10000
}
```

**Не используйте Caddy basic_auth поверх /api**, потому что существующий браузерный клиент использует заголовок `Authorization: Bearer ...` для API-токена. В результате две схемы авторизации могут конфликтовать. Вместо этого применяйте **обязательный длинный API_ACCESS_TOKEN**, а Node.js оставьте на localhost. Открывать landing page без токена допустимо, но *все* endpoints `/api` (кроме `/api/config`) закрыты приложением.

Внимательно настраивайте firewall **до включения**, чтобы не потерять SSH. Для UFW со стандартным SSH-портом 22:

```bash
sudo apt-get install -y ufw
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

Если SSH использует нестандартный порт, замените `22` на реальный. В панели провайдера Time4VPS также проверьте внешние правила firewall.

После корректного DNS:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
sudo journalctl -u caddy -n 50 --no-pager
```

Caddy автоматически запросит и продлит публичный TLS-сертификат при доступности домена и портов 80/443. Проверка с телефона по мобильной сети: `https://research.example.org`. Для платного API должна появляться форма/запрос токена, а HTTP API без токена должен возвращать 401. Пример:

```bash
curl -I https://research.example.org/
curl -s -o /dev/null -w '%{http_code}\n' https://research.example.org/api/jobs
# Ожидаемый код: 401
```

Не проверяйте продакшен нажатием «Запустить исследование»: это вызовет **платную** работу. Для Excel достаточно уже выполненного ранее `npm run smoke:xlsx` на сохранённом шаблоне или offline fixture.

## 4. Автозапуск и резервное копирование

```bash
sudo systemctl enable --now regionalresearch-backup.timer
sudo systemctl list-timers regionalresearch-backup.timer
sudo systemctl start regionalresearch-backup.service
sudo journalctl -u regionalresearch-backup.service -n 30 --no-pager
sudo ls -lh /var/lib/regionalresearch/backups
```

Backup создаётся через SQLite `Connection.backup()`, корректно учитывает WAL и не останавливает исследования. Хранятся 14 последних резервных копий на VPS. **Для защиты от потери VPS требуется периодически копировать эти backups во внешнее хранилище**; копии только на том же сервере не защищают от потери диска/аккаунта.

Если переносите текущие старые checkpoints: перед копированием сделайте согласованный SQLite backup на Windows (или остановите локальное приложение) и перенесите backup как `checkpoints.sqlite` до старта службы VPS. Не пересоздавайте базу, если хотите сохранить историю. Если она уже создана на VPS, сначала сохраните её в отдельный файл.

## 5. Обновления

Обновляйте ПО **когда нет активных исследований**. Одно исследование может занимать долгое время; автоматическое обновление во время работы оборвёт его (checkpoint позволит продолжить вручную).

```bash
sudo systemctl stop regionalresearch
sudo -u regionalresearch git -C /opt/regionalresearch switch main
sudo -u regionalresearch git -C /opt/regionalresearch pull --ff-only origin main
sudo -u regionalresearch npm --prefix /opt/regionalresearch ci
sudo bash /opt/regionalresearch/deploy/time4vps/check-ready.sh
sudo systemctl start regionalresearch
```

При обновлении `.env`, `data/` и `logs/` не перезаписываются Git: они в `.gitignore`. В случае аварии: `sudo journalctl -u regionalresearch -n 100 --no-pager`; состояние SQLite можно увидеть в `GET /health` **локально**.

## Ограничения архитектуры

- Job queue работает **в RAM одного процесса**. Запущенные задания после перезапуска/падения VPS не возобновляются автоматически. SQLite checkpoints сохраняются на диске, и исследование нужно вручную возобновить через интерфейс.
- Результаты завершённых работ доступны в памяти Node до перезапуска и в пределах времени хранения; **скачайте XLSX/JSON, прежде чем перезапускать**. Сам финальный `final_result` сохраняется в SQLite checkpoint, поэтому восстановление возможно отдельно, но API выгрузки старого завершённого job после рестарта нет.
- При `MAX_ACTIVE_FULL_JOBS=10` выполняется до 10 полных исследований разных областей одновременно **на одном VPS**. Эта цифра не гарантирует отсутствие OpenAI 429 и достаточную RAM/CPU. Сначала проверьте `free -h` и начните с 2.
- Одно приложение, один token для доступа, никаких отдельных пользователей. Не передавайте токен посторонним лицам. В целях личного доступа со всех устройств можно дополнительно ограничить доступ через VPN/Tailscale, но для HTTPS по домену достаточно указанной конфигурации.
