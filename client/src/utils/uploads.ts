// Аватары отдаются сервером под тем же /api-префиксом, что и REST-запросы —
// в проде reverse-proxy знает только про /api, отдельного правила для голого
// /uploads нет (см. server/index.js), поэтому используем базовый URL как есть.
const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || 'http://192.168.24.2/MirasChatServer/api';

export function resolveUploadUrl(avatarPath?: string | null): string | null {
  if (!avatarPath) return null;
  return `${API_BASE_URL}${avatarPath}`;
}
