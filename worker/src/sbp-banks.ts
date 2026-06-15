/** Популярные банки СБП (ID из Cardlink / НСПК). */
export const SBP_BANKS = [
  { id: "100000000111", label: "Сбербанк" },
  { id: "100000000004", label: "Т-Банк" },
  { id: "100000000005", label: "ВТБ" },
  { id: "100000000008", label: "Альфа-Банк" },
  { id: "100000000007", label: "Райффайзен" },
  { id: "100000000001", label: "Газпромбанк" },
  { id: "100000000003", label: "Банк Открытие" },
  { id: "100000000012", label: "Росбанк" },
] as const;

export function sbpBankLabel(bankId: string | null | undefined): string | null {
  if (!bankId) return null;
  return SBP_BANKS.find((row) => row.id === bankId)?.label ?? null;
}

export function sbpBankKeyboard(): Array<Array<{ text: string; callback_data: string }>> {
  return SBP_BANKS.map((row) => [
    { text: row.label, callback_data: `p:sbpbank:${row.id}` },
  ]);
}
