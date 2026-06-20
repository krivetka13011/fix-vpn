/// <reference types="vite/client" />

interface TelegramWebAppUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
}

interface TelegramWebApp {
  ready: () => void;
  expand: () => void;
  close: () => void;
  initData: string;
  initDataUnsafe: {
    user?: TelegramWebAppUser;
  };
  themeParams: Record<string, string>;
  MainButton: {
    text: string;
    show: () => void;
    hide: () => void;
    onClick: (cb: () => void) => void;
    offClick: (cb: () => void) => void;
    setText: (t: string) => void;
    enable: () => void;
    disable: () => void;
    showProgress: (leaveActive?: boolean) => void;
    hideProgress: () => void;
  };
  HapticFeedback: {
    impactOccurred: (style: "light" | "medium" | "heavy") => void;
  };
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  enableClosingConfirmation?: () => void;
  openTelegramLink?: (url: string) => void;
  openLink?: (url: string, options?: { try_browser?: boolean; try_instant_view?: boolean }) => void;
  showAlert?: (message: string, callback?: () => void) => void;
}

interface Window {
  Telegram?: { WebApp: TelegramWebApp };
}
