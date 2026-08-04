// Пресеты статуса профиля — фиксированным набором, а не тем, что пришлёт
// сервер: эмодзи и подпись живут только здесь, в базе хранится лишь ключ
// (см. server/routes/users.js, STATUS_PRESETS), иначе правки текста/эмодзи
// пришлось бы синхронизировать на всех платформах через миграцию данных.
export type StatusPreset = 'vacation' | 'lunch' | 'sick' | 'dayoff';

export const STATUS_PRESETS: Record<StatusPreset, { emoji: string; label: string }> = {
  vacation: { emoji: '🏖️', label: 'В отпуске' },
  lunch: { emoji: '🍽️', label: 'На обеде' },
  sick: { emoji: '🤒', label: 'Болею' },
  dayoff: { emoji: '🛌', label: 'Выходной' },
};

export const STATUS_PRESET_ORDER: StatusPreset[] = ['vacation', 'lunch', 'sick', 'dayoff'];

// На сколько ставится статус. null — бессрочно (как было до появления срока).
// Верхняя граница совпадает с серверной проверкой (STATUS_MAX_DURATION_MS):
// дальше двух недель это уже не статус, а строчка профиля, про которую забудут.
export const STATUS_DURATION_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: 'Без срока' },
  { value: 60 * 60 * 1000, label: 'На час' },
  { value: 4 * 60 * 60 * 1000, label: 'На 4 часа' },
  { value: 24 * 60 * 60 * 1000, label: 'На день' },
  { value: 7 * 24 * 60 * 60 * 1000, label: 'На неделю' },
];

/** Момент снятия статуса из выбранной длительности — то, что уходит на сервер. */
export function statusExpiryFrom(durationMs: number | null): number | null {
  return durationMs === null ? null : Date.now() + durationMs;
}

/** Что показать рядом с именем — пресет, свой текст или ничего. */
export function describeStatus(
  preset: string | null | undefined,
  custom: string | null | undefined
): { emoji: string; label: string } | null {
  if (custom && custom.trim()) return { emoji: '💬', label: custom.trim() };
  if (preset && preset in STATUS_PRESETS) return STATUS_PRESETS[preset as StatusPreset];
  return null;
}
