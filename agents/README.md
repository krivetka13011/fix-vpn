## 🤖 ИИ-ОС FIX VPN — Агентная инфраструктура

> Универсальная система специализированных агентов для любых проектов. Копируйте папку `agents/` в любой репозиторий — она не привязана к конкретному стеку.

## 🧑‍💻 Команда из 4 ботов

Каждая роль имеет собственного Telegram-бота, через которого общается с владельцем и командой. Владелец только ставит задачи и принимает решения — всю работу выполняют агенты.

| Бот | Роль | Зона ответственности | Агент |
|-----|------|---------------------|-------|
| 🎨 **Дизайнер** (`@Designer_kr_bot`) | Проектирование | UI/UX, ТЗ, макеты, спецификации, архитектура систем, API-контракты, Mermaid-диаграммы | Architect |
| 💻 **Разработчик** (`@Developer_kr_bot`) | Реализация | Код, интеграции, компоненты, билд, исправление багов, рефакторинг | Coder |
| 🧪 **Тестировщик** (`@Tester_kr_bot`) | Проверка | Security-аудит, smoke/e2e тесты, проверка качества, блокировка деплоя при уязвимостях | Security |
| 👑 **Админ** (`@Ad_199197hdhdhdbmin_kr_bot`) | Деплой и решения | Деплой в production, rollback, финальные решения, координация команды | Deployer |

## 🔄 Универсальное распределение задач

Система работает с **любыми проектами** (не только VPN). Вот как задачи автоматически распределяются по ролям:

### 🎨 Дизайнер (проектирование)
- **Новая фича/экран** → пишет ТЗ, wireframe, спецификацию компонентов
- **Новый API** → проектирует контракты (request/response), схему БД
- **Рефакторинг** → анализ текущей архитектуры, план изменений
- **Интеграция** → исследует документацию стороннего сервиса, пишет план
- **Баг** → анализирует, воспроизводит, описывает шаги для Разработчика
- **Результат**: `context/pending_tasks.md` с тегом `[READY_FOR_CODER]`

### 💻 Разработчик (реализация)
- **ТЗ от Дизайнера** → реализует код, UI/UX, интеграции
- **Баг-fix** → исправляет по шагам от Дизайнера
- **Технический долг** → рефакторит по плану
- **MCP-интеграции** → подключает UI-компоненты через Magic MCP
- **После каждого изменения**: `npm run build` (билд должен быть зелёным)
- **Результат**: `context/completed_tasks.md` с тегом `[READY_FOR_REVIEW]`

### 🧪 Тестировщик (проверка)
- **Готовый код** → `python scripts/smoke_check.py` + `python scripts/e2e_telegram.py`
- **Security-аудит** → сканирует git diff, зависимости, хардкод секретов
- **CRITICAL-уязвимость** → `[SECURITY_BLOCKED]` + возврат Разработчику
- **Всё чисто** → `[SECURITY_APPROVED]` + передача Админу
- **Результат**: `context/completed_tasks.md` с вердиктом

### 👑 Админ (деплой и решения)
- **Security approved** → деплой в production (push в master → CI/CD)
- **Post-deploy** → повторный прогон smoke + e2e
- **FAIL после деплоя** → rollback к предыдущей версии
- **Конфликты в команде** → финальное решение
- **Результат**: `[DEPLOYED]` или `[ROLLBACK_EXECUTED]`

## 🔑 Доступы к сервисам

Все доступы хранятся в `.env` (в `.gitignore`, не коммитится). Агенты используют их для автономной работы.

| Сервис | Назначение | Переменная в `.env` |
|--------|-----------|---------------------|
| **GitHub** | Commits, PR, Issues, Actions (CI/CD) | `GITHUB_TOKEN`, `GITHUB_REPO` |
| **Cloudflare** | Workers deploy, D1, KV, Pages | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` |
| **3X-UI панель** | VPN-сервер (клиенты, inbound) | `XUI_PANEL_URL`, `XUI_PANEL_USER`, `XUI_PANEL_PASS` |
| **Supabase** | База данных (users, subscriptions) | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY` |
| **Telegram** | Боты команды | `*_BOT_TOKEN`, `TEAM_CHAT_ID`, `OWNER_USER_ID` |
| **Vercel** | Лендинги (опционально) | `VERCEL_TOKEN` |
| **OpenAI** | AI-ассистент для ТЗ/ревью (опционально) | `OPENAI_API_KEY` |

### Настройка доступов

1. **GitHub PAT**: https://github.com/settings/personal-access-tokens/new
   - Fine-grained, репозиторий `krivetka13011/fix-vpn`
   - Права: Contents (R/W), Workflows (R/W), Actions (R/W), Pull requests (R/W), Metadata (R)
2. **Cloudflare**: https://dash.cloudflare.com/profile/api-tokens
   - Права: Workers Scripts (Edit), D1 (Edit), Workers KV (Edit), Pages (Edit)
3. Остальные — по инструкции в `.env.example`

## 📡 Поток работы команды

```
Владелец (Telegram) → 👑 Админ принимает задачу
                    → 🎨 Дизайнер (ТЗ + спецификация)
                    → 💻 Разработчик (код + билд)
                    → 🧪 Тестировщик (security + e2e)
                    → 👑 Админ (деплой + проверка)
                    → ✅ Результат в Telegram
```

Владелец только ставит задачу в чат и принимает финальный результат. Все промежуточные этапы команда выполняет автономно.

## 🎯 Триггеры и теги (контракт между ботами)

| Тег | Кто ставит | Значение |
|-----|------------|----------|
| `[NEW_TASK]` | Владелец | Новая задача от владельца |
| `[READY_FOR_CODER]` | Дизайнер | ТЗ готово, передаём Разработчику |
| `[NEEDS_CLARIFICATION]` | Разработчик | ТЗ неполно, возврат Дизайнеру |
| `[BLOCKED]` | Разработчик | Техническая проблема |
| `[READY_FOR_REVIEW]` | Разработчик | Код готов, передаём Тестировщику |
| `[SECURITY_APPROVED]` | Тестировщик | Проверки пройдены, можно деплоить |
| `[SECURITY_BLOCKED]` | Тестировщик | Уязвимость, возврат Разработчику |
| `[DEPLOYED]` | Админ | В production, проверено |
| `[DEPLOY_BLOCKED_*]` | Админ | Нет approval / нет сборки |
| `[ROLLBACK_EXECUTED]` | Админ | Откат после падения |

## 📁 Контекстные файлы (`context/`)

| Файл | Кто ведёт | Назначение |
|------|-----------|------------|
| `pending_tasks.md` | Дизайнер | ТЗ для Разработчика |
| `completed_tasks.md` | Разработчик/Тестировщик/Админ | Статус задач (теги) |
| `state.json` | Все | Текущее состояние (ветка, деплой, security) |
| `architecture.md` | Дизайнер | Диаграммы, компоненты, контракты API |

## 🧩 Skills (навыки)

Skills — переиспользуемые правила в `.cursor/rules/`, которые расширяют возможности агентов.

### Активные навыки
- **UI UX Pro Max** (`ui-ux-pro-max.mdc`) — Mobile-first, Telegram Mini App дизайн.
- **Grill Me** (`grill-me.mdc`) — Интервью для уточнения требований.
- **Panel Client Enable** (`panel-client-enable.mdc`) — Жизненный цикл клиентов 3X-UI.
- **Security** (`security.mdc`) — Базовый чеклист безопасности.
- **Autonomous Verify** (`autonomous-verify.mdc`) — smoke + e2e после изменений.
- **Everything Claude Code** (`everything-claude-code.mdc`) — Инженерные конвенции.

## 🔌 MCP-серверы (Model Context Protocol)

### Активные
- **magic-mcp** (`@21st-dev/magic`) — Генерация UI-компонентов (React/TSX).

### Рекомендуемые (не активированы)
- **github-mcp** — PR review, issue management.
- **postgres-mcp** / **d1-mcp** — Прямой запрос к БД для отладки.
- **mermaid-mcp** — Генерация диаграмм для Дизайнера.

## 🔧 Настройка прав ботов в чате

Telegram **не позволяет** ботам добавлять других ботов в чат или повышать себя до админов через API. Это делает только человек-владелец чата.

### Шаг 1: Добавить ботов в чат (вручную)

1. Откройте чат команды в Telegram.
2. Нажмите на название чата → **Добавить участников**.
3. Найдите и добавьте каждого бота по username:
   - 🎨 `@Designer_kr_bot`
   - 💻 `@Developer_kr_bot`
   - 🧪 `@Tester_kr_bot`
   - 👑 `@Ad_199197hdhdhdbmin_kr_bot` (уже в чате)
4. Повторите для всех 4 ботов.

### Шаг 2: Повысить ботов до админов чата (автоматически)

После добавления всех ботов запустите:

```bash
python scripts/telegram_hub.py --setup-rights
```

Админ-бот (он уже админ) повысит остальных ботов до админов чата с правами: `manage_chat`, `delete_messages`, `invite_users`, `pin_messages`, `manage_topics`.

### Шаг 3: Отключить Privacy Mode (для чтения ВСЕХ сообщений)

По умолчанию боты видят только команды, reply на свои сообщения и @упоминания.

**Чтобы боты видели ВСЕ сообщения** (текст, медиа, файлы, голосовые, видео):

1. Откройте **@BotFather** в Telegram.
2. Отправьте `/setprivacy`.
3. Выберите бота.
4. Выберите **Disable**.
5. Повторите для всех 4 ботов.
6. **Удалите и заново добавьте ботов в чат** — Privacy Mode применяется только при добавлении.

### Шаг 4: Проверить

```bash
python scripts/telegram_hub.py --status
python scripts/telegram_hub.py --setup-rights
```

## 🚀 Быстрый старт для нового проекта

1. Скопируй папку `agents/` в корень нового репозитория.
2. Создай `.env` из `.env.example` с токенами ботов и доступами к сервисам.
3. Создай `context/` с файлами: `pending_tasks.md`, `completed_tasks.md`, `state.json`, `architecture.md`.
4. Настрой доступы в `.env` (GitHub, Cloudflare и т.д.).
5. Запусти: `python scripts/telegram_hub.py --status` — проверь, что все боты на связи.
6. Напиши задачу в чат команды — Админ примет её и запустит пайплайн.

## 🛠 Команды Telegram-Hub

```bash
# Проверить статус всех ботов
python scripts/telegram_hub.py --status

# Установить названия ботов с эмодзи
python scripts/telegram_hub.py --setup-names

# Установить описания ролей
python scripts/telegram_hub.py --setup-desc

# Повысить ботов до админов чата и установить права
python scripts/telegram_hub.py --setup-rights

# Отправить сообщение от имени Админа в чат команды
python scripts/telegram_hub.py --send "Привет, команда!"

# Отправить сообщение в ЛС владельцу
python scripts/telegram_hub.py --send "Проверка связи" --to-owner

# Одноразовый опрос обновлений
python scripts/telegram_hub.py --poll-once

# Постоянный опрос (long-polling, Ctrl+C для остановки)
python scripts/telegram_hub.py --poll