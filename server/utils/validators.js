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

module.exports = {
  isValidLogin,
  isReservedLogin,
  isValidPassword,
  isValidDisplayName,
  isValidPhone,
  isValidBio,
};
