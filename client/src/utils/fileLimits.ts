// Предел размера отправляемого файла.
//
// Число и текст держим в одном месте и на клиенте, и на сервере
// (server/routes/messages.js): проверка обязана быть на сервере — клиентскую
// обойти тривиально, — но и на клиенте она нужна, иначе человек ждёт загрузку
// стомегабайтного файла только чтобы получить отказ в конце.
export const FILE_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Текст отказа. По требованию человек должен узнать не «файл слишком большой»,
 * а что система работает в тестовом режиме и большие файлы пока нельзя.
 */
export const FILE_TOO_LARGE_MESSAGE =
  'Система работает в тестовом режиме, пока большие файлы отправлять нельзя. '
  + 'Предельный размер — 50 МБ.';

/** Человеческий размер файла: 1.4 МБ вместо 1468006. */
export function formatFileSize(bytes: number | null | undefined): string {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1024) return `${value} Б`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} КБ`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} МБ`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} ГБ`;
}

/**
 * Значок по типу файла. Не пытаемся угадать по MIME (там половина файлов
 * приезжает как application/octet-stream) — смотрим на расширение, оно
 * человеку и так видно в имени.
 */
export function fileGlyph(name: string | null | undefined): string {
  const ext = /\.([a-zA-Z0-9]+)$/.exec(String(name || ''))?.[1]?.toLowerCase() || '';
  if (['pdf'].includes(ext)) return '📕';
  if (['doc', 'docx', 'rtf', 'odt'].includes(ext)) return '📘';
  if (['xls', 'xlsx', 'csv', 'ods'].includes(ext)) return '📗';
  if (['ppt', 'pptx', 'odp'].includes(ext)) return '📙';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return '🗜️';
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(ext)) return '🎵';
  if (['mp4', 'mkv', 'avi', 'mov', 'webm'].includes(ext)) return '🎬';
  if (['txt', 'md', 'log'].includes(ext)) return '📄';
  return '📎';
}
