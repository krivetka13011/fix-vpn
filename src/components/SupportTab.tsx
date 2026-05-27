import type { Catalog } from "../types";
import { openSupportChat } from "../utils/copy";

interface Props {
  catalog: Catalog;
}

const FAQ = [
  {
    q: "VPN не подключается",
    a: "Проверьте ключ в профиле, обновите подписку в клиенте и перезапустите Hiddify или v2rayTun. Убедитесь, что подписка активна.",
  },
  {
    q: "Ключ не копируется",
    a: "Нажмите «Скопировать ключ» в инструкции или профиле. В Telegram разрешите доступ к буферу обмена для мини-приложения.",
  },
  {
    q: "Медленная скорость",
    a: "Попробуйте тариф «Персональный сервер» — выделенный канал с высокой скоростью. Перезапустите клиент и выберите ближайший узел.",
  },
  {
    q: "Нужно больше устройств",
    a: "На базовом тарифе докупите устройства в тарифах или в профиле. На персональном сервере лимита устройств нет.",
  },
  {
    q: "Подписка не отображается",
    a: "Откройте приложение заново из бота. Если статус не обновился — напишите в поддержку с вашим ID из профиля.",
  },
];

export function SupportTab({ catalog }: Props) {
  return (
    <>
      <header className="header">
        <img src="/logo.png" alt="" className="header-logo" />
        <div>
          <div className="header-title">Поддержка</div>
          <div className="header-sub">Ответы и связь с оператором</div>
        </div>
      </header>

      <div className="card">
        {FAQ.map((item) => (
          <details key={item.q} className="faq-item">
            <summary>{item.q}</summary>
            <p>{item.a}</p>
          </details>
        ))}
      </div>

      <button
        type="button"
        className="btn-primary"
        onClick={() => openSupportChat(catalog.supportTelegramId)}
      >
        Написать в поддержку
      </button>
    </>
  );
}
