const assert = require('node:assert/strict');
const test = require('node:test');
const {
  normalizeUnicodeKey,
  unicodeKeyFromFilename,
  emojiFromUnicodeKey,
  parseStructureFile,
} = require('../services/emojiCatalog');

test('имена одиночных и составных файлов приводятся к одному Unicode-ключу', () => {
  assert.equal(unicodeKeyFromFilename('U+1F600.webp'), '1f600');
  assert.equal(unicodeKeyFromFilename('u_1f600.png'), '1f600');
  assert.equal(unicodeKeyFromFilename('folder/U+1F1E6-U+1F1E8.webp'), '1f1e6-1f1e8');
  assert.equal(normalizeUnicodeKey('1F469-200D-1F4BB'), '1f469-200d-1f4bb');
  assert.equal(emojiFromUnicodeKey('1f1e6-1f1e8'), '🇦🇨');
});

test('клавишные смайлики с ASCII в составе разбираются, одиночный ASCII — нет', () => {
  // Из набора Apple такие файлы молча выпадали: отсечка «код < 0x80» была
  // общей, а у # * и цифр 0–9 первый код именно ASCII.
  assert.equal(unicodeKeyFromFilename('Apple/U+0023-U+FE0F-U+20E3.webp'), '23-fe0f-20e3');
  assert.equal(unicodeKeyFromFilename('Apple/U+0037-U+FE0F-U+20E3.webp'), '37-fe0f-20e3');
  assert.equal(emojiFromUnicodeKey('23-fe0f-20e3'), '#️⃣');
  assert.equal(emojiFromUnicodeKey('37-fe0f-20e3'), '7️⃣');

  // Одиночный ASCII по-прежнему отвергается: `u_12` — это имя, а не U+0012.
  assert.equal(normalizeUnicodeKey('12'), null);
  assert.equal(unicodeKeyFromFilename('u_41.webp'), null);
});

test('emoji-test.txt превращается в структуру групп и порядка', () => {
  const source = [
    '# group: Smileys & Emotion',
    '# subgroup: face-smiling',
    '1F600 ; fully-qualified # 😀 E1.0 grinning face',
    '# group: Flags',
    '# subgroup: country-flag',
    '1F1E6 1F1E8 ; fully-qualified # 🇦🇨 E2.0 flag: Ascension Island',
  ].join('\n');
  const entries = parseStructureFile('emoji-test.txt', Buffer.from(source));

  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((item) => item.unicode_key), ['1f600', '1f1e6-1f1e8']);
  assert.equal(entries[1].group_name, 'Flags');
});
