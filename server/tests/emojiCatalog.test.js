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
