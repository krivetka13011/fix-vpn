import { useEffect } from "react";

export function useTelegramMainButton(
  text: string,
  visible: boolean,
  onClick: () => void,
  loading = false
) {
  useEffect(() => {
    const btn = window.Telegram?.WebApp?.MainButton;
    if (!btn) return;

    btn.setText(text);
    if (loading) btn.showProgress();
    else btn.hideProgress();

    if (visible) btn.show();
    else btn.hide();

    btn.onClick(onClick);
    return () => {
      btn.offClick(onClick);
      btn.hide();
    };
  }, [text, visible, onClick, loading]);
}
