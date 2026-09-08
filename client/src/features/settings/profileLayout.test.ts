import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', '..');
const css = readFileSync(join(SRC, 'shared', 'styles', 'notifications.css'), 'utf8');
const profile = readFileSync(join(__dirname, 'ProfileEdit.tsx'), 'utf8');

/**
 * Профиль пользуется оболочкой настроек, а та в редизайне стала
 * двухколоночной сеткой (оглавление слева, раздел справа). Профиль от этого
 * разложило по колонкам: аватар в одной, «Статус» в другой, форма обратно в
 * первой — «редактирование профиля поломанное полностью» (прод, 08.09.2026).
 *
 * Проверяем чтением файлов, а не отрисовкой: стилей в jsdom нет вовсе, и
 * `getComputedStyle` зеленел бы на сломанной вёрстке (см. homeText.test.ts).
 */
test('тело настроек — сетка, и профиль из неё выведен явно', () => {
  expect(css).toMatch(/\.settings-body \{[^}]*display: grid/);
  expect(css).toMatch(/\.profile-edit-body \{[^}]*display: block/);
});

test('профиль просит свой однослойный класс, а не только общий', () => {
  expect(profile).toContain('settings-body profile-edit-body');
});
