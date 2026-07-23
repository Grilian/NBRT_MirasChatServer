// API base URL включает "/api" (см. api/client.ts) — статика с аватарами
// отдаётся сервером рядом, без этого суффикса.
const UPLOADS_BASE_URL = (process.env.REACT_APP_API_BASE_URL || 'http://192.168.24.2/MirasChatServer/api')
  .replace(/\/api\/?$/, '');

export function resolveUploadUrl(avatarPath?: string | null): string | null {
  if (!avatarPath) return null;
  return `${UPLOADS_BASE_URL}${avatarPath}`;
}
