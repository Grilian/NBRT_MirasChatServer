const assert = require('node:assert/strict');
const test = require('node:test');
const { trimDanglingShortcode } = require('../utils/shortcode');

// Обрезка сообщения по MAX_MESSAGE_LENGTH не должна оставлять в базе огрызок
// кода: картинкой он уже не станет, а лежать там будет вечно.
//
// С 07.09.2026 код в тексте ровно один — выбор оформления `:e~<ключ>~<пак>:`.
// Прежние `:name:` сняты вместе с картиночными смайликами.

test('оборванный код выбора оформления срезается с конца строки', () => {
  assert.equal(trimDanglingShortcode('смотри :e~1f469-200d-1f4bb~google-fonts'), 'смотри ');
  assert.equal(trimDanglingShortcode('край :e~1f6'), 'край ');
  // Даже голое начало кода — уже огрызок.
  assert.equal(trimDanglingShortcode('вот :e~'), 'вот ');
});

test('целый код и обычный текст не трогаются', () => {
  assert.equal(trimDanglingShortcode('привет :e~1f600~apple:'), 'привет :e~1f600~apple:');
  assert.equal(trimDanglingShortcode('обычный текст'), 'обычный текст');
  assert.equal(trimDanglingShortcode('вот:'), 'вот:');
});

test('время в конце строки больше не калечится', () => {
  // Прежний шаблон ловил любое `:слово` в конце, и «встреча в 10:30»
  // превращалась во «встреча в 10»: `:30` было неотличимо от начала кода
  // `:30sec:`. Неточность была известной и закреплялась тестом. Теперь
  // огрызком считается только то, что начинается с `e~`, и совпадений с
  // человеческим текстом не остаётся.
  assert.equal(trimDanglingShortcode('встреча в 10:30'), 'встреча в 10:30');
  assert.equal(trimDanglingShortcode('привет :cat'), 'привет :cat');
  assert.equal(trimDanglingShortcode('порт localhost:8080'), 'порт localhost:8080');
});

test('пустое и отсутствующее значение не роняют обрезку', () => {
  assert.equal(trimDanglingShortcode(''), '');
  assert.equal(trimDanglingShortcode(null), '');
  assert.equal(trimDanglingShortcode(undefined), '');
});
