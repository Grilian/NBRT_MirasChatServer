// Зеркалит правила server/utils/validators.js — дублируется намеренно,
// общего пакета между клиентом и сервером нет.

const LOGIN_RE = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
const CYRILLIC_RE = /[Ѐ-ӿ]/;
const PHONE_RE = /^\+?[\d\s\-()]{5,20}$/;

export function isValidLogin(login: string): boolean {
  return LOGIN_RE.test(login);
}

export function isReservedLogin(login: string): boolean {
  return login.toLowerCase().startsWith('miras_');
}

export function isValidPassword(password: string): boolean {
  return password.length >= 5 && !CYRILLIC_RE.test(password);
}

export function isValidDisplayName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length >= 2 && trimmed.length <= 64;
}

export function isValidPhone(phone: string): boolean {
  if (!phone) return true; // необязательное поле
  return PHONE_RE.test(phone);
}

export function isValidBio(bio: string): boolean {
  return bio.length <= 160; // необязательное поле, пустая строка тоже проходит
}

export const LOGIN_HINT = '5-32 символов, латиница, цифры и подчёркивание, начинается с буквы';
export const PASSWORD_HINT = 'Не короче 5 символов, без кириллицы';
export const DISPLAY_NAME_HINT = 'Имя Фамилия';
