"""Telegram-Hub: координация команды из 4 ботов FIX VPN.

Роли:
  - Дизайнер    (DESIGNER_BOT_TOKEN)  — проектирует UI/UX, пишет ТЗ.
  - Разработчик (DEVELOPER_BOT_TOKEN) — реализует код, прогоняет билд.
  - Тестировщик (TESTER_BOT_TOKEN)    — smoke + e2e, security-проверки.
  - Админ       (ADMIN_BOT_TOKEN)     — деплой, rollback, финальные решения.

Поток:
  Owner → TEAM_CHAT → Дизайнер (ТЗ) → Разработчик (код) → Тестировщик (security) → Админ (деплой)

Usage:
  python scripts/telegram_hub.py                      # одноразовый опрос
  python scripts/telegram_hub.py --poll               # постоянный опрос (long-polling)
  python scripts/telegram_hub.py --send "сообщение"   # отправить от имени Админа
  python scripts/telegram_hub.py --status             # статус всех ботов

Requires .env (gitignored): DESIGNER_BOT_TOKEN, DEVELOPER_BOT_TOKEN,
                            TESTER_BOT_TOKEN, ADMIN_BOT_TOKEN, TEAM_CHAT_ID.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import requests

REPO_ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = REPO_ROOT / ".env"
STATE_PATH = REPO_ROOT / "context" / "state.json"
DIALOG_HISTORY_PATH = REPO_ROOT / "context" / "dialog_history.json"
PENDING_PATH = REPO_ROOT / "context" / "pending_tasks.md"
COMPLETED_PATH = REPO_ROOT / "context" / "completed_tasks.md"
MAX_HISTORY_MESSAGES = 20

# Роли ботов — каждая роль общается в TEAM_CHAT от своего имени.
ROLES = {
    "designer": {
        "label": "🎨 Дизайнер",
        "env_key": "DESIGNER_BOT_TOKEN",
        "agent": "architect",
        "trigger_tag": "[NEW_TASK]",
        "output_tag": "[READY_FOR_CODER]",
    },
    "developer": {
        "label": "💻 Разработчик",
        "env_key": "DEVELOPER_BOT_TOKEN",
        "agent": "coder",
        "trigger_tag": "[READY_FOR_CODER]",
        "output_tag": "[READY_FOR_REVIEW]",
    },
    "tester": {
        "label": "🧪 Тестировщик",
        "env_key": "TESTER_BOT_TOKEN",
        "agent": "security",
        "trigger_tag": "[READY_FOR_REVIEW]",
        "output_tag": "[SECURITY_APPROVED]",
    },
    "admin": {
        "label": "👑 Админ",
        "env_key": "ADMIN_BOT_TOKEN",
        "agent": "deployer",
        "trigger_tag": "[SECURITY_APPROVED]",
        "output_tag": "[DEPLOYED]",
    },
}

# ============================================================
# System Prompts — «личность» каждого бота
# ============================================================
SYSTEM_PROMPTS = {
    "designer": (
        "Ты — 🎨 Дизайнер в команде разработки. "
        "Проектируешь UI/UX, пишешь технические задания, спецификации компонентов, "
        "архитектуру систем и API-контракты. "
        "Отвечаешь кратко, по делу, с примерами кода/макетов. "
        "Пишешь на русском. Используй Markdown для форматирования."
    ),
    "developer": (
        "Ты — 💻 Разработчик в команде. "
        "Пишешь код (TypeScript, Python), интегрируешь компоненты, "
        "исправляешь баги, прогоняешь билд. "
        "Объясняешь решения технически точно, с фрагментами кода в блоках ```язык. "
        "Пишешь на русском. Строго следуешь конвенциям проекта."
    ),
    "tester": (
        "Ты — 🧪 Тестировщик в команде. "
        "Проверяешь безопасность, прогоняешь smoke и e2e тесты, "
        "сканируешь git diff на утечки секретов. "
        "Отвечаешь структурированно: Шаг → Ожидание → Результат. "
        "Пишешь на русском. Блокируешь деплой при уязвимостях."
    ),
    "admin": (
        "Ты — 👑 Админ и координатор команды. "
        "Принимаешь задачи от владельца, распределяешь их между Дизайнером, "
        "Разработчиком и Тестировщиком. "
        "Деплоишь в production, откатываешь при сбоях. "
        "Пишешь на русском. Принимаешь финальные решения."
    ),
}


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("telegram_hub")


def load_env(path: Path = ENV_PATH) -> bool:
    """Загрузить .env без перезаписи существующих переменных.

    Args:
        path: Путь к файлу .env.

    Returns:
        True, если файл найден и загружен.
    """
    if not path.is_file():
        return False
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())
    return True


def get_bot_token(role: str) -> str | None:
    """Получить токен бота по роли.

    Args:
        role: Ключ роли (designer, developer, tester, admin).

    Returns:
        Токен или None, если не задан.
    """
    env_key = ROLES[role]["env_key"]
    token = os.environ.get(env_key)
    if not token:
        log.warning("Токен %s не задан в .env", env_key)
    return token


def load_dialog_history() -> list[dict]:
    """Загрузить историю диалога из context/dialog_history.json.

    Returns:
        Список сообщений [{role, content}, ...].
    """
    if not DIALOG_HISTORY_PATH.is_file():
        return []
    try:
        with open(DIALOG_HISTORY_PATH, encoding="utf-8") as handle:
            return json.load(handle)
    except (json.JSONDecodeError, OSError):
        return []


def save_dialog_history(history: list[dict]) -> None:
    """Сохранить историю диалога, обрезая до MAX_HISTORY_MESSAGES.

    Args:
        history: Список сообщений диалога.
    """
    DIALOG_HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    trimmed = history[-MAX_HISTORY_MESSAGES:]
    with open(DIALOG_HISTORY_PATH, "w", encoding="utf-8") as handle:
        json.dump(trimmed, handle, indent=2, ensure_ascii=False)


def append_dialog(role_name: str, content: str) -> None:
    """Добавить сообщение в историю диалога.

    Args:
        role_name: "user", "assistant", или "system".
        content: Текст сообщения.
    """
    history = load_dialog_history()
    history.append({"role": role_name, "content": content})
    save_dialog_history(history)


def download_telegram_file(role: str, file_id: str, suffix: str = "") -> Path | None:
    """Скачать файл из Telegram (голосовое, фото, документ).

    Args:
        role: Роль бота (для токена).
        file_id: ID файла в Telegram.
        suffix: Расширение файла (например, .ogg, .jpg).

    Returns:
        Путь к скачанному файлу или None при ошибке.
    """
    token = get_bot_token(role)
    if not token:
        return None
    data = telegram_api(token, "getFile", file_id=file_id)
    if not data.get("ok"):
        log.error("getFile failed: %s", data.get("description"))
        return None
    file_path = data["result"]["file_path"]
    url = f"https://api.telegram.org/file/bot{token}/{file_path}"
    try:
        response = requests.get(url, timeout=30)
        response.raise_for_status()
    except requests.RequestException as exc:
        log.error("File download failed: %s", exc)
        return None
    tmp_dir = REPO_ROOT / "context" / "tmp_media"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    local_path = tmp_dir / f"{file_id[-12:]}{suffix}"
    with open(local_path, "wb") as handle:
        handle.write(response.content)
    log.info("Файл скачан: %s (%d байт)", local_path, len(response.content))
    return local_path


def transcribe_voice(role: str, file_id: str) -> str | None:
    """Транскрибировать голосовое сообщение через Whisper API (Z.ai).

    Args:
        role: Роль бота (для токена Telegram).
        file_id: ID голосового файла в Telegram.

    Returns:
        Распознанный текст или None при ошибке.
    """
    audio_path = download_telegram_file(role, file_id, suffix=".ogg")
    if not audio_path:
        return None
    api_key = os.environ.get("GLM_API_KEY", "")
    base_url = os.environ.get("GLM_BASE_URL", "https://api.z.ai/api/paas/v4")
    url = f"{base_url}/audio/transcriptions"
    try:
        with open(audio_path, "rb") as handle:
            response = requests.post(
                url,
                headers={"Authorization": f"Bearer {api_key}"},
                files={"file": handle},
                data={"model": "whisper-1"},
                timeout=60,
            )
        data = response.json()
        text = data.get("text", "")
        if text:
            log.info("Голосовое распознано: %s...", text[:80])
            return text.strip()
        log.error("Whisper вернул пустой ответ: %s", data)
        return None
    except requests.RequestException as exc:
        log.error("Whisper request failed: %s", exc)
        return None
    finally:
        try:
            audio_path.unlink()
        except OSError:
            pass


def extract_message_text(update: dict, role: str) -> tuple[str | None, str | None]:
    """Извлечь текст из сообщения (текст, голосовое, подпись фото).

    Args:
        update: Объект update из getUpdates.
        role: Роль бота для скачивания медиа.

    Returns:
        Кортеж (text, caption): текст сообщения и подпись к медиа.
        Если голосовое — возвращается распознанный текст в text.
    """
    message = update.get("message") or update.get("channel_post")
    if not message:
        return None, None

    text = message.get("text", "").strip() or None
    caption = message.get("caption", "").strip() or None

    # Голосовое сообщение
    voice = message.get("voice") or message.get("audio")
    if voice:
        file_id = voice.get("file_id")
        if file_id:
            log.info("Голосовое сообщение, file_id=%s...", file_id[:20])
            transcribed = transcribe_voice(role, file_id)
            if transcribed:
                return transcribed, caption

    return text, caption


def ask_glm(role: str, user_message: str, history: list[dict] | None = None) -> str:
    """Запросить ответ у GLM от имени роли бота.

    Использует OpenAI-compatible API Zhipu AI (GLM).

    Args:
        role: Роль бота (определяет system prompt).
        user_message: Текст сообщения пользователя.
        history: Предыдущие сообщения диалога (список {role, content}).

    Returns:
        Ответ модели или сообщение об ошибке.
    """
    api_key = os.environ.get("GLM_API_KEY", "")
    if not api_key:
        return "[Ошибка: GLM_API_KEY не задан в .env]"

    base_url = os.environ.get("GLM_BASE_URL", "https://api.z.ai/api/paas/v4")
    model = os.environ.get("GLM_MODEL", "glm-4.5-flash")
    url = f"{base_url}/chat/completions"

    messages = [{"role": "system", "content": SYSTEM_PROMPTS[role]}]
    if history:
        messages.extend(history)
    messages.append({"role": "user", "content": user_message})

    try:
        response = requests.post(
            url,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={"model": model, "messages": messages, "temperature": 0.7},
            timeout=60,
        )
        data = response.json()
        if "choices" in data and data["choices"]:
            return data["choices"][0]["message"]["content"].strip()
        return f"[Ошибка GLM: {data.get('error', data)}]"
    except requests.RequestException as exc:
        log.error("GLM request failed: %s", exc)
        return f"[Сетевая ошибка GLM: {exc}]"
    except (KeyError, ValueError) as exc:
        log.error("GLM parse error: %s", exc)
        return f"[Ошибка разбора ответа GLM: {exc}]"


def telegram_api(token: str, method: str, **params) -> dict:
    """Вызвать метод Telegram Bot API.

    Args:
        token: Токен бота.
        method: Метод API (sendMessage, getUpdates и т.д.).
        **params: Параметры метода.

    Returns:
        Ответ API как dict. Пустой dict при ошибке.
    """
    url = f"https://api.telegram.org/bot{token}/{method}"
    try:
        response = requests.post(url, json=params, timeout=30)
        data = response.json()
        if not data.get("ok"):
            log.error("Telegram API error (%s): %s", method, data.get("description"))
        return data
    except requests.RequestException as exc:
        log.error("Сетевая ошибка (%s): %s", method, exc)
        return {}


def send_message(role: str, text: str, chat_id: int | None = None) -> bool:
    """Отправить сообщение от имени бота-роли в чат команды.

    Args:
        role: Роль бота (designer, developer, tester, admin).
        text: Текст сообщения (HTML).
        chat_id: ID чата. По умолчанию — TEAM_CHAT_ID из .env.

    Returns:
        True при успехе.
    """
    token = get_bot_token(role)
    if not token:
        return False
    chat = chat_id or int(os.environ.get("TEAM_CHAT_ID", "0"))
    if not chat:
        log.error("TEAM_CHAT_ID не задан")
        return False
    data = telegram_api(
        token,
        "sendMessage",
        chat_id=chat,
        text=text,
        parse_mode="HTML",
    )
    return bool(data.get("ok"))


def get_bot_info(role: str) -> dict:
    """Получить информацию о боте (имя, username).

    Args:
        role: Роль бота.

    Returns:
        Словарь с полями ok, username, first_name или ошибка.
    """
    token = get_bot_token(role)
    if not token:
        return {"ok": False, "error": "no token"}
    data = telegram_api(token, "getMe")
    if data.get("ok"):
        result = data["result"]
        return {
            "ok": True,
            "role": role,
            "label": ROLES[role]["label"],
            "username": f"@{result.get('username', '')}",
            "name": result.get("first_name", ""),
        }
    return {"ok": False, "role": role, "error": data.get("description", "unknown")}


def load_last_update_id() -> int:
    """Загрузить ID последнего обработанного обновления из state.json.

    Returns:
        Offset для getUpdates (last_update_id + 1) или 0.
    """
    if not STATE_PATH.is_file():
        return 0
    try:
        with open(STATE_PATH, encoding="utf-8") as handle:
            state = json.load(handle)
        return int(state.get("hub_last_update_id", 0))
    except (json.JSONDecodeError, ValueError, OSError):
        return 0


def save_last_update_id(update_id: int) -> None:
    """Сохранить ID последнего обновления в state.json.

    Args:
        update_id: ID обновления для сохранения.
    """
    state = {}
    if STATE_PATH.is_file():
        try:
            with open(STATE_PATH, encoding="utf-8") as handle:
                state = json.load(handle)
        except (json.JSONDecodeError, OSError):
            pass
    state["hub_last_update_id"] = update_id
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(STATE_PATH, "w", encoding="utf-8") as handle:
        json.dump(state, handle, indent=2, ensure_ascii=False)


def poll_updates(role: str = "admin", timeout: int = 30) -> list[dict]:
    """Опросить обновления от бота (long-polling).

    Args:
        role: Роль бота для опроса (обычно admin как точка входа задач).
        timeout: Таймаут long-polling в секундах.

    Returns:
        Список новых сообщений.
    """
    token = get_bot_token(role)
    if not token:
        return []
    offset = load_last_update_id() + 1
    data = telegram_api(token, "getUpdates", offset=offset, timeout=timeout)
    if not data.get("ok"):
        return []
    updates = data.get("result", [])
    if updates:
        save_last_update_id(updates[-1]["update_id"])
    return updates


@dataclass
class TaskCommand:
    """Команда от владельца, распарсенная из сообщения."""

    text: str
    chat_id: int
    from_id: int
    is_owner: bool


def parse_command(update: dict) -> TaskCommand | None:
    """Извлечь команду из Telegram-обновления.

    Args:
        update: Объект update из getUpdates.

    Returns:
        TaskCommand или None, если это не сообщение.
    """
    message = update.get("message") or update.get("channel_post")
    if not message:
        return None
    text = message.get("text", "").strip()
    chat_id = message.get("chat", {}).get("id", 0)
    from_id = message.get("from", {}).get("id", 0)
    owner_id = int(os.environ.get("OWNER_USER_ID", "0"))
    return TaskCommand(
        text=text,
        chat_id=chat_id,
        from_id=from_id,
        is_owner=(from_id == owner_id),
    )


def append_to_pending(text: str) -> None:
    """Записать новую задачу в context/pending_tasks.md.

    Args:
        text: Описание задачи от владельца.
    """
    PENDING_PATH.parent.mkdir(parents=True, exist_ok=True)
    timestamp = time.strftime("%Y-%m-%d %H:%M")
    entry = f"\n## Задача от {timestamp}\n- **Цель**: {text}\n- **Статус**: [NEW_TASK]\n\n"
    mode = "a" if PENDING_PATH.is_file() else "w"
    with open(PENDING_PATH, mode, encoding="utf-8") as handle:
        handle.write(entry)


def run_pipeline_step(role: str) -> bool:
    """Выполнить шаг пайплайна для указанной роли.

    Каждый бот уведомляет чат о начале своей работы и результате.

    Args:
        role: Роль (designer, developer, tester, admin).

    Returns:
        True, если шаг выполнен без ошибок.
    """
    label = ROLES[role]["label"]
    send_message(role, f"{label}: получила задачу, начинаю работу...")
    # Реальная работа выполняется агентом (Cline) через .clinerules.
    # Здесь — только уведомление команды.
    return True


def cmd_setup_names() -> int:
    """Установить названия ботов с эмодзи через setMyName.

    Returns:
        0 при успехе, 1 при ошибке.
    """
    names = {
        "designer": "🎨 Дизайнер",
        "developer": "💻 Разработчик",
        "tester": "🧪 Тестировщик",
        "admin": "👑 Админ",
    }
    print("Установка названий ботов...")
    all_ok = True
    for role, name in names.items():
        token = get_bot_token(role)
        if not token:
            all_ok = False
            continue
        data = telegram_api(token, "setMyName", name=name)
        ok = bool(data.get("ok"))
        mark = "OK" if ok else "FAIL"
        print(f"  {mark} {ROLES[role]['label']} -> {name}")
        if not ok:
            all_ok = False
    if all_ok:
        print("Все названия установлены.")
    return 0 if all_ok else 1


def cmd_setup_description() -> int:
    """Установить описания ботов через setMyDescription.

    Returns:
        0 при успехе.
    """
    descriptions = {
        "designer": (
            "🎨 Дизайнер\n\n"
            "Проектирую UI/UX, пишу технические задания, "
            "создаю макеты и спецификации для Разработчика.\n\n"
            "Мой агент: Architect"
        ),
        "developer": (
            "💻 Разработчик\n\n"
            "Реализую код, интегрирую компоненты, "
            "прогоняю билд. Работаю по ТЗ от Дизайнера.\n\n"
            "Мой агент: Coder"
        ),
        "tester": (
            "🧪 Тестировщик\n\n"
            "Проверяю безопасность, прогоняю smoke "
            "и e2e тесты. Блокирую деплой при уязвимостях.\n\n"
            "Мой агент: Security"
        ),
        "admin": (
            "👑 Админ\n\n"
            "Деплою в production, откатываю при сбоях, "
            "принимаю финальные решения. Принимаю задачи от владельца.\n\n"
            "Мой агент: Deployer"
        ),
    }
    print("Установка описаний ботов...")
    all_ok = True
    for role, desc in descriptions.items():
        token = get_bot_token(role)
        if not token:
            all_ok = False
            continue
        data = telegram_api(token, "setMyDescription", description=desc)
        ok = bool(data.get("ok"))
        mark = "OK" if ok else "FAIL"
        print(f"  {mark} {ROLES[role]['label']}")
        if not ok:
            all_ok = False
    if all_ok:
        print("Все описания установлены.")
    return 0 if all_ok else 1


def cmd_setup_rights() -> int:
    """Повысить всех ботов до админов чата и установить права по умолчанию.

    Telegram НЕ позволяет ботам добавлять других ботов в чат через API.
    Поэтому владелец должен вручную добавить всех 4 ботов в чат, затем
    запустить эту команду для повышения до админов.

    Для чтения ВСЕХ сообщений нужно также отключить Privacy Mode через @BotFather.

    Returns:
        0 при успехе, 1 при ошибке.
    """
    chat_id = int(os.environ.get("TEAM_CHAT_ID", "0"))
    if not chat_id:
        log.error("TEAM_CHAT_ID не задан")
        return 1

    admin_token = get_bot_token("admin")
    if not admin_token:
        return 1

    print("=" * 55)
    print("Шаг 1/2: Права администратора по умолчанию")
    print("=" * 55)
    admin_rights = {
        "can_manage_chat": True,
        "can_delete_messages": True,
        "can_invite_users": True,
        "can_pin_messages": True,
        "can_manage_topics": True,
    }
    for role in ROLES:
        token = get_bot_token(role)
        if not token:
            continue
        data = telegram_api(
            token,
            "setMyDefaultAdministratorRights",
            rights=admin_rights,
            for_chat_groups=True,
        )
        ok = bool(data.get("ok"))
        mark = "OK" if ok else "FAIL"
        print(f"  {mark} {ROLES[role]['label']}: права по умолчанию")

    print("\n" + "=" * 55)
    print("Шаг 2/2: Повышение ботов до админов чата")
    print("=" * 55)

    # Сначала получаем user_id всех ботов
    bot_ids: dict[str, int] = {}
    for role in ROLES:
        token = get_bot_token(role)
        if not token:
            continue
        me = telegram_api(token, "getMe")
        if me.get("ok"):
            bot_ids[role] = me["result"]["id"]

    # Получаем ID админ-бота для пропуска self-promotion
    admin_id = bot_ids.get("admin", 0)

    promoted = []
    already_admin = []
    not_in_chat = []

    for role, user_id in bot_ids.items():
        # Админ-бот не может повысить сам себя (can't promote self)
        if role == "admin":
            already_admin.append(ROLES[role]["label"])
            continue

        data = telegram_api(
            admin_token,
            "promoteChatMember",
            chat_id=chat_id,
            user_id=user_id,
            can_manage_chat=True,
            can_delete_messages=True,
            can_invite_users=True,
            can_pin_messages=True,
            can_manage_topics=True,
        )
        if data.get("ok"):
            promoted.append(ROLES[role]["label"])
            print(f"  OK {ROLES[role]['label']}: повышен до админа")
        else:
            err = data.get("description", "")
            if "PARTICIPANT_ID_INVALID" in err:
                not_in_chat.append(ROLES[role]["label"])
                print(f"  SKIP {ROLES[role]['label']}: ещё не в чате")
            else:
                print(f"  FAIL {ROLES[role]['label']}: {err}")

    # Итоговый отчёт
    print("\n" + "=" * 55)
    print("ИТОГ")
    print("=" * 55)

    if already_admin:
        print(f"  Уже админ: {', '.join(already_admin)}")
    if promoted:
        print(f"  Повышено:  {', '.join(promoted)}")
    if not_in_chat:
        print(f"  Не в чате: {', '.join(not_in_chat)}")

    if not_in_chat:
        print("\n" + "=" * 55)
        print("ВНИМАНИЕ: Некоторые боты ещё не в чате!")
        print("=" * 55)
        print("""
Telegram не позволяет ботам добавлять других ботов в чат через API.
Владелец должен добавить их вручную:

  1. Откройте чат команды в Telegram
  2. Нажмите на название чата → "Добавить участников"
  3. Найдите и добавьте ботов по username:
""")

        # Получаем username каждого бота
        for role in ROLES:
            token = get_bot_token(role)
            if not token:
                continue
            me = telegram_api(token, "getMe")
            if me.get("ok"):
                uname = f"@{me['result'].get('username', '')}"
                in_chat = ROLES[role]["label"] not in not_in_chat or role == "admin"
                mark = "[уже в чате]" if in_chat else "[добавить]"
                print(f"     {mark} {ROLES[role]['label']}: {uname}")

        print("""
  4. После добавления всех ботов снова запустите:
     python scripts/telegram_hub.py --setup-rights

  5. Для чтения ВСЕХ сообщений (текст, медиа, файлы, голосовые)
     отключите Privacy Mode через @BotFather для каждого бота:
       @BotFather → /setprivacy → выберите бота → Disable
     Затем удалите и заново добавьте ботов в чат (Privacy Mode
     применяется только при добавлении).
""")

    if not not_in_chat:
        print("\nВсе боты — админы чата!")

    return 0 if not not_in_chat else 1


def cmd_status() -> int:
    """Вывести статус всех ботов команды.

    Returns:
        0 при успехе, 1 при ошибке.
    """
    print("=" * 50)
    print("Статус команды FIX VPN")
    print("=" * 50)
    all_ok = True
    for role in ROLES:
        info = get_bot_info(role)
        if info.get("ok"):
            print(f"  {info['label']}: {info['username']} — {info['name']}")
        else:
            print(f"  {ROLES[role]['label']}: ОШИБКА — {info.get('error')}")
            all_ok = False
    chat_id = os.environ.get("TEAM_CHAT_ID", "не задан")
    owner_id = os.environ.get("OWNER_USER_ID", "не задан")
    print(f"\n  Чат команды: {chat_id}")
    print(f"  Владелец: {owner_id}")
    print("=" * 50)
    return 0 if all_ok else 1


def cmd_send(text: str, to_owner: bool = False) -> int:
    """Отправить сообщение от имени Админа.

    Args:
        text: Текст сообщения.
        to_owner: Отправить в ЛС владельцу вместо чата команды.

    Returns:
        0 при успехе.
    """
    if to_owner:
        owner_id = int(os.environ.get("OWNER_USER_ID", "0"))
        if not owner_id:
            log.error("OWNER_USER_ID не задан")
            return 1
        ok = send_message("admin", f"👑 <b>Админ</b>\n\n{text}", chat_id=owner_id)
    else:
        ok = send_message("admin", f"👑 <b>Админ</b>\n\n{text}")
    return 0 if ok else 1


def route_to_role(text: str) -> str:
    """Определить роль-исполнителя по содержанию сообщения.

    Args:
        text: Текст задачи от владельца.

    Returns:
        Ключ роли: designer, developer, tester или admin.
    """
    lower = text.lower()
    if any(w in lower for w in ["баг", "ошибка", "fix", "чинить", "не работает", "сломал"]):
        return "developer"
    if any(w in lower for w in ["тест", "провер", "audit", "безопасн", "security", " smoke", "e2e"]):
        return "tester"
    if any(w in lower for w in ["депло", "deploy", "выкат", "prod", "откат", "rollback"]):
        return "admin"
    if any(w in lower for w in ["дизайн", "макет", "ui", "ux", "тз", "спецификац", "api контракт"]):
        return "designer"
    # По умолчанию — Дизайнер (проектирует ТЗ первым шагом)
    return "designer"


def cmd_poll_once() -> int:
    """Однократный опрос обновлений и запуск пайплайна.

    При получении задачи от владельца:
    1. Текст извлекается (текст, голосовое → Whisper, подпись фото).
    2. Задача маршрутизируется к нужной роли.
    3. Роль генерирует ответ через GLM (с учётом истории диалога).
    4. Ответ отправляется в чат, диалог сохраняется в историю.

    Returns:
        0 при успехе.
    """
    updates = poll_updates(timeout=0)
    if not updates:
        print("Нет новых сообщений")
        return 0
    for update in updates:
        cmd = parse_command(update)
        if not cmd:
            continue
        if not cmd.is_owner:
            log.warning("Сообщение от не-владельца (id=%s), игнорирую", cmd.from_id)
            continue

        # Служебные команды
        if cmd.text and cmd.text.startswith("/"):
            if cmd.text.lower() in ("/clear", "/reset", "/new"):
                save_dialog_history([])
                send_message("admin", "🧹 <b>История диалога очищена.</b> Новая задача с чистого листа.")
                log.info("История очищена по команде %s", cmd.text)
            continue

        # Извлечение текста (включая голосовые через Whisper)
        text, _caption = extract_message_text(update, "admin")
        if not text:
            log.warning("Не удалось извлечь текст из обновления %s", update.get("update_id"))
            continue

        log.info("Команда от владельца: %s", text[:80])

        # Запись задачи в pending (тихо, без уведомления в чат)
        append_to_pending(text)

        # Маршрутизация к роли
        role = route_to_role(text)
        label = ROLES[role]["label"]

        # Загрузка истории для контекста (чтобы дополнять задачу)
        history = load_dialog_history()

        # Запрос к GLM от имени роли — с историей диалога
        glm_reply = ask_glm(role, text, history=history)
        log.info("GLM (%s) ответил: %s...", role, glm_reply[:80])

        # Сохранение в историю: пользователь + ответ ассистента
        append_dialog("user", text)
        append_dialog("assistant", f"[{role}] {glm_reply}")

        # Отправка только ответа GLM (без "принял задачу")
        send_message(role, f"{label}:\n\n{glm_reply}")
    return 0


def cmd_poll_loop(interval: int = 5) -> int:
    """Постоянный опрос (long-polling) в цикле.

    Args:
        interval: Интервал между опросами в секундах.

    Returns:
        Код выхода (0 при прерывании пользователем).
    """
    log.info("Запуск Telegram-Hub в режиме постоянного опроса (Ctrl+C для остановки)")
    try:
        while True:
            cmd_poll_once()
            time.sleep(interval)
    except KeyboardInterrupt:
        log.info("Остановлено пользователем")
        return 0


def main() -> int:
    """Точка входа CLI.

    Returns:
        Код выхода (0 при успехе).
    """
    parser = argparse.ArgumentParser(description="Telegram-Hub: команда FIX VPN")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--poll", action="store_true", help="Постоянный опрос")
    group.add_argument("--poll-once", action="store_true", help="Одноразовый опрос")
    group.add_argument("--status", action="store_true", help="Статус ботов")
    group.add_argument("--setup-names", action="store_true", help="Установить названия с эмодзи")
    group.add_argument("--setup-desc", action="store_true", help="Установить описания ролей")
    group.add_argument("--setup-rights", action="store_true", help="Повысить ботов до админов чата")
    group.add_argument("--send", metavar="TEXT", help="Отправить сообщение от Админа")
    parser.add_argument(
        "--interval",
        type=int,
        default=5,
        help="Интервал опроса, сек (по умолчанию 5)",
    )
    parser.add_argument(
        "--to-owner",
        action="store_true",
        help="Отправить --send в ЛС владельцу (а не в чат команды)",
    )
    args = parser.parse_args()

    if not load_env():
        print("ОШИБКА: файл .env не найден. Создайте из .env.example", file=sys.stderr)
        return 1

    if args.setup_names:
        return cmd_setup_names()
    if args.setup_desc:
        return cmd_setup_description()
    if args.setup_rights:
        return cmd_setup_rights()
    if args.status:
        return cmd_status()
    if args.send:
        return cmd_send(args.send, to_owner=args.to_owner)
    if args.poll_once:
        return cmd_poll_once()
    if args.poll:
        return cmd_poll_loop(args.interval)
    return 0


if __name__ == "__main__":
    sys.exit(main())