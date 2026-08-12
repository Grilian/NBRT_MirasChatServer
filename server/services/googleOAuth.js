const crypto = require('crypto');
const axios = require('axios');
const db = require('../db');

// OAuth-часть синхронизации с Google Календарём: настройки приложения, обмен
// кода на токены, обновление протухшего access_token и хранение всего этого.
//
// Библиотеку googleapis намеренно не берём: из всего её объёма нам нужны три
// http-запроса, а axios уже стоит ради интеграции с МИРАС.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

// Только календарь и адрес аккаунта — чтобы в окне согласия было видно, что
// приложение не просит доступ к почте и файлам.
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/userinfo.email',
];

// Аккаунт организации. Персональные подключения (если появятся) — те же строки
// с настоящим user_id, см. комментарий к таблице в db.js.
const ORG_ACCOUNT = 0;

const SETTING_CLIENT_ID = 'google_calendar_client_id';
const SETTING_CLIENT_SECRET = 'google_calendar_client_secret';
const SETTING_REDIRECT_URI = 'google_calendar_redirect_uri';

// ===== Шифрование токенов =====
//
// refresh_token — это бессрочный доступ к гугл-аккаунту организации, и файл
// базы уезжает в бэкапы целиком. Ключ берём из отдельной переменной среды, а
// при её отсутствии — из JWT_SECRET: заводить ещё один обязательный секрет
// ради этой одной возможности значило бы уронить сервер там, где раньше он
// поднимался.
function encryptionKey() {
  const secret = process.env.GOOGLE_TOKEN_KEY || process.env.JWT_SECRET || 'your_super_secret_key';
  return crypto.scryptSync(secret, 'miraschat-google-tokens', 32);
}

function encryptToken(plain) {
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

/**
 * Расшифровка. null — прочитать нечем: сменили JWT_SECRET, подсунули чужую
 * базу или строка испорчена. Наверх это уходит как «аккаунт не подключён» —
 * лечится повторным подключением, и падать тут незачем.
 */
function decryptToken(stored) {
  if (!stored) return null;
  const parts = String(stored).split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      encryptionKey(),
      Buffer.from(parts[1], 'base64')
    );
    decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[3], 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

// ===== Настройки приложения =====

function getSetting(key) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  if (value === null || value === '') {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
    return;
  }
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, String(value), Date.now());
}

/**
 * Что панель ввела в разделе «Google Календарь». secret тоже шифруем: он
 * позволяет обменять украденный код авторизации на токены.
 */
function getClientConfig() {
  return {
    clientId: getSetting(SETTING_CLIENT_ID),
    clientSecret: decryptToken(getSetting(SETTING_CLIENT_SECRET)),
    redirectUri: getSetting(SETTING_REDIRECT_URI),
  };
}

function saveClientConfig({ clientId, clientSecret, redirectUri }) {
  if (clientId !== undefined) setSetting(SETTING_CLIENT_ID, String(clientId || '').trim() || null);
  if (redirectUri !== undefined) {
    setSetting(SETTING_REDIRECT_URI, String(redirectUri || '').trim() || null);
  }
  // Пустая строка от панели значит «не меняли»: секрет наружу не отдаётся, и
  // форма присылает его обратно пустым. Стереть можно только явным null.
  if (clientSecret !== undefined) {
    const value = clientSecret === null ? null : String(clientSecret).trim();
    if (value === null) setSetting(SETTING_CLIENT_SECRET, null);
    else if (value) setSetting(SETTING_CLIENT_SECRET, encryptToken(value));
  }
}

function isConfigured() {
  const config = getClientConfig();
  return !!(config.clientId && config.clientSecret && config.redirectUri);
}

// ===== Одноразовый state =====
//
// На адрес возврата Google приходит без наших заголовков — токена панели там
// нет и быть не может. Значит единственное, чем доказывается «этот код
// авторизации запросили из панели, а не подсунули со стороны», — случайный
// state, выданный при старте и погашенный при разборе.
const STATE_TTL_MS = 10 * 60 * 1000;
const pendingStates = new Map();

function issueState(superAdminId) {
  const now = Date.now();
  for (const [key, entry] of pendingStates) {
    if (entry.expiresAt < now) pendingStates.delete(key);
  }
  const state = crypto.randomBytes(24).toString('base64url');
  pendingStates.set(state, { superAdminId, expiresAt: now + STATE_TTL_MS });
  return state;
}

/** Гасит state и говорит, был ли он настоящим. Повторный разбор всегда false. */
function consumeState(state) {
  const entry = pendingStates.get(state);
  if (!entry) return false;
  pendingStates.delete(state);
  return entry.expiresAt >= Date.now();
}

// ===== Поток авторизации =====

function buildAuthUrl(state) {
  const config = getClientConfig();
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    // offline + consent — единственный способ получить refresh_token. Без
    // consent Google второй раз его не пришлёт, и после первого же истечения
    // часового access_token синхронизация встала бы намертво.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function exchangeCode(code) {
  const config = getClientConfig();
  const { data } = await axios.post(TOKEN_URL, new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: 'authorization_code',
  }), { timeout: 20000 });
  return data;
}

async function fetchEmail(accessToken) {
  try {
    const { data } = await axios.get(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 20000,
    });
    return data.email || null;
  } catch {
    // Адрес — только подпись под кнопкой «Отключить». Не повод рушить
    // подключение, которое в остальном состоялось.
    return null;
  }
}

// ===== Аккаунт =====

function getAccount(userId = ORG_ACCOUNT) {
  return db.prepare('SELECT * FROM google_calendar_accounts WHERE user_id = ?').get(userId) || null;
}

function saveAccount(tokens, email, userId = ORG_ACCOUNT) {
  const now = Date.now();
  const expiresAt = now + (Number(tokens.expires_in) || 3600) * 1000;
  const existing = getAccount(userId);

  if (existing) {
    // Повторное подключение того же аккаунта: refresh_token Google присылает
    // не всегда, и затирать имеющийся пустым значением нельзя — второго уже
    // не будет без отзыва доступа вручную.
    db.prepare(`
      UPDATE google_calendar_accounts
      SET google_email = ?, access_token = ?, refresh_token = COALESCE(?, refresh_token),
          token_expires_at = ?, last_error = NULL, updated_at = ?
      WHERE id = ?
    `).run(
      email, encryptToken(tokens.access_token),
      tokens.refresh_token ? encryptToken(tokens.refresh_token) : null,
      expiresAt, now, existing.id
    );
    return getAccount(userId);
  }

  db.prepare(`
    INSERT INTO google_calendar_accounts
      (user_id, google_email, access_token, refresh_token, token_expires_at,
       sync_from, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId, email, encryptToken(tokens.access_token),
    tokens.refresh_token ? encryptToken(tokens.refresh_token) : null,
    expiresAt,
    // По умолчанию берём события за последний месяц и всё, что впереди:
    // импортировать десятилетний архив чужого календаря никто не просил.
    now - 30 * 24 * 60 * 60 * 1000,
    now, now
  );
  return getAccount(userId);
}

function disconnect(userId = ORG_ACCOUNT) {
  const account = getAccount(userId);
  if (!account) return;
  // Привязки без аккаунта бессмысленны, а надгробия — тем более: отправлять
  // их стало некуда. Сами события остаются: они уже часть общего календаря.
  db.prepare('DELETE FROM google_calendar_links WHERE account_id = ?').run(account.id);
  db.prepare('DELETE FROM google_calendar_deletions WHERE account_id = ?').run(account.id);
  db.prepare('DELETE FROM google_calendar_accounts WHERE id = ?').run(account.id);
}

function recordError(accountId, message) {
  db.prepare('UPDATE google_calendar_accounts SET last_error = ?, updated_at = ? WHERE id = ?')
    .run(message ? String(message).slice(0, 500) : null, Date.now(), accountId);
}

// Обновляем чуть заранее: запрос, отправленный за секунду до истечения,
// доедет до Google уже с просроченным токеном.
const REFRESH_MARGIN_MS = 60 * 1000;

/**
 * Живой access_token аккаунта. Бросает — значит доступ отозвали или настройки
 * приложения стёрли; вызывающий записывает это в last_error и показывает в
 * панели, потому что чинится оно только руками.
 */
async function accessTokenFor(account) {
  if (account.access_token && account.token_expires_at > Date.now() + REFRESH_MARGIN_MS) {
    const token = decryptToken(account.access_token);
    if (token) return token;
  }

  const refreshToken = decryptToken(account.refresh_token);
  if (!refreshToken) throw new Error('Нет доступа к аккаунту — подключите его заново');

  const config = getClientConfig();
  if (!config.clientId || !config.clientSecret) {
    throw new Error('Не заданы client_id и client_secret приложения');
  }

  const { data } = await axios.post(TOKEN_URL, new URLSearchParams({
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'refresh_token',
  }), { timeout: 20000 });

  const expiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
  db.prepare(`
    UPDATE google_calendar_accounts
    SET access_token = ?, token_expires_at = ?, refresh_token = COALESCE(?, refresh_token), updated_at = ?
    WHERE id = ?
  `).run(
    encryptToken(data.access_token), expiresAt,
    data.refresh_token ? encryptToken(data.refresh_token) : null,
    Date.now(), account.id
  );

  return data.access_token;
}

module.exports = {
  ORG_ACCOUNT,
  SCOPES,
  encryptToken,
  decryptToken,
  getClientConfig,
  saveClientConfig,
  isConfigured,
  issueState,
  consumeState,
  buildAuthUrl,
  exchangeCode,
  fetchEmail,
  getAccount,
  saveAccount,
  disconnect,
  recordError,
  accessTokenFor,
};
