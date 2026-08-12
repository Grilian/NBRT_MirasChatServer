const axios = require('axios');
const { accessTokenFor } = require('./googleOAuth');

// Тонкая обёртка над Calendar API v3. Ровно те пять вызовов, которые нужны
// синхронизации, — без клиентской библиотеки, см. комментарий в googleOAuth.js.

const BASE = 'https://www.googleapis.com/calendar/v3';
const TIMEOUT_MS = 30000;

/**
 * Ошибка от Google с сохранённым кодом ответа. Код нужен вызывающему:
 * 410 значит «курсор протух, начни заново» и обрабатывается молча, а 401/403 —
 * настоящая поломка доступа, которую надо показать администратору.
 */
class GoogleApiError extends Error {
  constructor(message, status, reason) {
    super(message);
    this.name = 'GoogleApiError';
    this.status = status;
    this.reason = reason || null;
  }
}

function wrap(e) {
  if (!e.response) return new GoogleApiError(e.message || 'Google недоступен', 0);
  const data = e.response.data || {};
  const detail = data.error || {};
  const reason = Array.isArray(detail.errors) && detail.errors[0] ? detail.errors[0].reason : null;
  return new GoogleApiError(
    detail.message || e.message || 'Ошибка Google Календаря',
    e.response.status,
    reason
  );
}

async function request(account, { method, path, params, data }) {
  const token = await accessTokenFor(account);
  try {
    const response = await axios({
      method,
      url: `${BASE}${path}`,
      params,
      data,
      headers: { Authorization: `Bearer ${token}` },
      timeout: TIMEOUT_MS,
    });
    return response.data;
  } catch (e) {
    throw wrap(e);
  }
}

/** Календари аккаунта — для выбора того, который синхронизируем. */
async function listCalendars(account) {
  const data = await request(account, {
    method: 'get',
    path: '/users/me/calendarList',
    params: { maxResults: 250, minAccessRole: 'writer' },
  });
  return (data.items || []).map((item) => ({
    id: item.id,
    name: item.summaryOverride || item.summary,
    primary: !!item.primary,
    access_role: item.accessRole,
  }));
}

/**
 * Страница событий.
 *
 * syncToken — инкрементальный проход: приезжает только изменившееся с прошлого
 * раза, включая удалённое (status: 'cancelled'). При первом проходе его нет, и
 * тогда ограничиваемся временем — см. sync_from.
 *
 * singleEvents НЕ включаем намеренно: нам нужны сами серии с их RRULE, а не
 * развёрнутые вхождения. Разворачиванием занимается наш calendarEvents.js, и
 * тысяча строк вместо одной серии сломала бы и его, и хранение.
 */
async function listEvents(account, { syncToken, timeMin, pageToken }) {
  const params = {
    maxResults: 250,
    showDeleted: true,
    singleEvents: false,
    pageToken: pageToken || undefined,
  };
  if (syncToken) params.syncToken = syncToken;
  else params.timeMin = new Date(timeMin).toISOString();

  return request(account, {
    method: 'get',
    path: `/calendars/${encodeURIComponent(account.calendar_id)}/events`,
    params,
  });
}

async function insertEvent(account, body) {
  return request(account, {
    method: 'post',
    path: `/calendars/${encodeURIComponent(account.calendar_id)}/events`,
    data: body,
  });
}

async function patchEvent(account, googleEventId, body) {
  return request(account, {
    method: 'patch',
    path: `/calendars/${encodeURIComponent(account.calendar_id)}/events/${encodeURIComponent(googleEventId)}`,
    data: body,
  });
}

/**
 * Удаление. 404 и 410 — событие уже удалено на той стороне; это успех, а не
 * ошибка: цель «его там нет» достигнута, и повторять нечего.
 */
async function deleteEvent(account, googleEventId) {
  try {
    await request(account, {
      method: 'delete',
      path: `/calendars/${encodeURIComponent(account.calendar_id)}/events/${encodeURIComponent(googleEventId)}`,
    });
  } catch (e) {
    if (e instanceof GoogleApiError && (e.status === 404 || e.status === 410)) return;
    throw e;
  }
}

module.exports = {
  GoogleApiError,
  listCalendars,
  listEvents,
  insertEvent,
  patchEvent,
  deleteEvent,
};
