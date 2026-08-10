// Правила логина/пароля/имени — общие для регистрации, самостоятельного
// редактирования профиля и правки супер-админом, чтобы ни один из этих путей
// не мог создать учётку, не проходящую по остальным.

const LOGIN_RE = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
const CYRILLIC_RE = /[Ѐ-ӿ]/;
const PHONE_RE = /^\+?[\d\s\-()]{5,20}$/;

function isValidLogin(login) {
  return typeof login === 'string' && LOGIN_RE.test(login);
}

function isReservedLogin(login) {
  return typeof login === 'string' && login.toLowerCase().startsWith('miras_');
}

function isValidPassword(password) {
  return typeof password === 'string' && password.length >= 5 && !CYRILLIC_RE.test(password);
}

function isValidDisplayName(name) {
  return typeof name === 'string' && name.trim().length >= 2 && name.trim().length <= 64;
}

function isValidPhone(phone) {
  if (phone === undefined || phone === null || phone === '') return true; // необязательное поле
  return typeof phone === 'string' && PHONE_RE.test(phone);
}

function isValidBio(bio) {
  if (bio === undefined || bio === null || bio === '') return true; // необязательное поле
  return typeof bio === 'string' && bio.length <= 160;
}

function isValidShortText(value) {
  if (value === undefined || value === null || value === '') return true; // необязательное поле
  return typeof value === 'string' && value.length <= 100;
}

const BIRTH_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidBirthDate(value) {
  if (value === undefined || value === null || value === '') return true; // необязательное поле
  if (typeof value !== 'string' || !BIRTH_DATE_RE.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  if (Number.isNaN(date.getTime())) return false;
  // Date нормализует несуществующие даты (например, 2025-02-31 превращает
  // в март). Сверяем результат обратно со входом, чтобы такие значения не
  // попадали в профиль и календарь дней рождения.
  if (date.toISOString().slice(0, 10) !== value) return false;
  const year = date.getUTCFullYear();
  return year >= 1900 && date.getTime() <= Date.now();
}

// Тип учётной записи. 'miras' — легаси зеркала МИРАС (интеграция убрана, но
// записи в базе могли остаться), новые аккаунты через неё больше не создаются.
const ACCOUNT_TYPES = ['staff', 'internet', 'miras'];

function isValidAccountType(type) {
  return ACCOUNT_TYPES.includes(type);
}

// Окно самостоятельной установки нового пароля после того, как админ нажал
// "Сменить" — по истечении админу нужно нажимать "Сменить" заново.
const PASSWORD_RESET_WINDOW_MS = 15 * 60 * 1000;

module.exports = {
  isValidLogin,
  isReservedLogin,
  isValidPassword,
  isValidDisplayName,
  isValidPhone,
  isValidBio,
  isValidShortText,
  isValidBirthDate,
  ACCOUNT_TYPES,
  isValidAccountType,
  PASSWORD_RESET_WINDOW_MS,
};
