import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// «Важный текст не заменяется многоточием» — правило пользователя, и документ
// концепции требует того же. При этом САМ макет его нарушает: на «Главной»
// обрезаны и подписи карточек («7 непрочита…»), и названия событий
// («Организационна…», «Экскурсия «Хра…»).
//
// Проверить это в jsdom нельзя вовсе: стили туда не загружаются, и
// `getComputedStyle` вернёт умолчания браузера независимо от того, что
// написано в файле, — такая проверка зеленела бы и на сломанной вёрстке.
// Поэтому тест читает CSS как текст. Приём в проекте уже используется —
// так же устроена проверка контраста по tokens.css.

const CSS = readFileSync(
  join(__dirname, '..', '..', 'shared', 'styles', 'roster-home.css'),
  'utf8',
);

/** Тело правила для селектора: от него до ближайшей закрывающей скобки. */
function ruleBody(selector: string): string {
  const at = CSS.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`Нет правила ${selector} — селектор переименовали?`);
  return CSS.slice(at, CSS.indexOf('}', at));
}

// Текст, который человек пришёл прочитать: подпись плитки говорит, ЧЕГО
// столько, а название события — к чему готовиться. Обрезанное «Экскурсия
// «Хра…» не отличить от другой экскурсии, и переспросить его негде.
const MUST_WRAP = ['.home-stat-label', '.home-event-title', '.home-attention-title'];

describe('на «Главной» важный текст не обрезается', () => {
  for (const selector of MUST_WRAP) {
    test(`${selector} переносится, а не режется многоточием`, () => {
      const body = ruleBody(selector);
      expect(body).not.toContain('text-overflow: ellipsis');
      expect(body).not.toContain('white-space: nowrap');
    });
  }

  test('у плиток нет фиксированной высоты — её задаёт содержимое', () => {
    // Именно фиксированная высота и вынуждает обрезать: вторая строка подписи
    // некуда не помещается, и её приходится прятать.
    const body = ruleBody('.home-stat');
    expect(body).not.toMatch(/(^|[^-])height:/);
  });
});
