import { LAYOUT_SIZES, MOBILE_MAX_WIDTH, resolveLayout } from './layoutMode';

const base = {
  rosterWidth: 320,
  rosterCollapsedByUser: null as boolean | null,
};

const at = (width: number, over: Partial<typeof base> = {}) =>
  resolveLayout({ ...base, ...over, width });

describe('порядок уступок при сужении окна', () => {
  test('на широком окне открыты все три области, рельс с подписями', () => {
    const state = at(1600);
    expect(state.mode).toBe('standard');
    expect(state.rosterCompact).toBe(false);
    expect(state.railExpanded).toBe(true);
    expect(state.railWidth).toBe(LAYOUT_SIZES.navRailWide);
  });

  test('первыми уступают ПОДПИСИ на рельсе, а не список и не переписка', () => {
    // Раздел без подписи опознаётся по иконке и подсказке, список чатов без
    // имён и превью — никак. Поэтому оформление платит первым.
    const width = LAYOUT_SIZES.navRailWide + LAYOUT_SIZES.rosterMin + LAYOUT_SIZES.chatMin - 1;
    const state = at(width);

    expect(state.railExpanded).toBe(false);
    expect(state.railWidth).toBe(LAYOUT_SIZES.navRail);
    // Список при этом ещё полный: до него очередь не дошла.
    expect(state.rosterCompact).toBe(false);
    expect(state.mode).toBe('standard');
    expect(state.chatWidth).toBeGreaterThanOrEqual(LAYOUT_SIZES.chatMin);
  });

  test('следом уступает место список чатов, а не переписка', () => {
    // Полный список со своим минимумом уже не оставляет переписке её минимума.
    const width = LAYOUT_SIZES.navRail + LAYOUT_SIZES.rosterMin + LAYOUT_SIZES.chatMin - 30;
    const state = at(width);

    expect(state.mode).toBe('compact');
    expect(state.rosterCompact).toBe(true);
    expect(state.rosterWidth).toBe(LAYOUT_SIZES.rosterCompact);
    expect(state.chatWidth).toBeGreaterThanOrEqual(LAYOUT_SIZES.chatMin);
  });

  test('когда не собирается даже «рельс + иконки + переписка» — сразу мобильный', () => {
    const width = LAYOUT_SIZES.navRail + LAYOUT_SIZES.rosterCompact + LAYOUT_SIZES.chatMin - 1;
    expect(at(width).mode).toBe('mobile');
  });

  test('промежуточного режима без глобальной навигации не существует', () => {
    // На любой ширине это либо десктоп с рельсом, либо мобильный с нижней
    // навигацией — «десктоп без навигации» не должен появляться нигде.
    for (let width = 300; width <= 2000; width += 7) {
      expect(['standard', 'compact', 'mobile']).toContain(at(width).mode);
    }
  });

  test('подписи на рельсе никогда не появляются раньше, чем помещаются', () => {
    // Каждая уступка обязана быть монотонной: сузил окно — подписи ушли и
    // сами не вернулись, пока место не появилось снова.
    let lastExpanded = false;
    for (let width = MOBILE_MAX_WIDTH + 1; width <= 2400; width += 1) {
      const state = at(width);
      if (lastExpanded) expect(state.railExpanded).toBe(true);
      lastExpanded = state.railExpanded;
      if (state.railExpanded) {
        expect(width).toBeGreaterThanOrEqual(
          LAYOUT_SIZES.navRailWide + LAYOUT_SIZES.rosterMin + LAYOUT_SIZES.chatMin
        );
      }
    }
  });

  test('свёрнутый вручную список ОТДАЁТ рельсу место под подписи', () => {
    // Свернул список сам — значит освободил место, и рельс вправе его занять.
    // Это не нарушение порядка уступок: порядок про НЕХВАТКУ места, а тут её
    // нет. Ширина взята такая, где с полным списком подписи не помещаются.
    const width = LAYOUT_SIZES.navRailWide + LAYOUT_SIZES.rosterMin + LAYOUT_SIZES.chatMin - 60;
    expect(at(width).railExpanded).toBe(false);
    expect(at(width, { rosterCollapsedByUser: true }).railExpanded).toBe(true);
  });

  test('четвёртой области не существует ни на одной ширине', () => {
    // Правая колонка убрана вместе со всей своей механикой. Проверка тут не
    // ради типов (их и так проверяет компилятор), а ради того, чтобы возврат
    // «маленькой панельки справа» нельзя было протащить незаметно: он обязан
    // начинаться с осознанной правки этого теста.
    for (let width = 300; width <= 2400; width += 17) {
      const state = at(width);
      expect(Object.keys(state).sort())
        .toEqual(['chatWidth', 'mode', 'railExpanded', 'railWidth', 'rosterCompact', 'rosterWidth']);
    }
  });
});

describe('переписка не сжимается ниже рабочего минимума', () => {
  test('на всех десктопных ширинах переписке остаётся не меньше минимума', () => {
    for (let width = MOBILE_MAX_WIDTH + 1; width <= 2200; width += 13) {
      for (const rosterWidth of [240, 320, 460, 560]) {
        const state = at(width, { rosterWidth });
        if (state.mode === 'mobile') continue;
        expect(state.chatWidth).toBeGreaterThanOrEqual(LAYOUT_SIZES.chatMin);
      }
    }
  });

  test('слишком широкий список ужимается сам, а не забирает место у переписки', () => {
    // Человек растянул список до 560, но окно узкое.
    const width = LAYOUT_SIZES.navRail + 560 + LAYOUT_SIZES.chatMin - 120;
    const state = at(width, { rosterWidth: 560 });

    expect(state.rosterCompact).toBe(false);
    expect(state.rosterWidth).toBeLessThan(560);
    expect(state.rosterWidth).toBeGreaterThanOrEqual(LAYOUT_SIZES.rosterMin);
    expect(state.chatWidth).toBeGreaterThanOrEqual(LAYOUT_SIZES.chatMin);
  });

  test('ширины областей никогда не превышают окно', () => {
    for (let width = MOBILE_MAX_WIDTH + 1; width <= 2200; width += 11) {
      for (const rosterWidth of [240, 320, 460, 560]) {
        const s = at(width, { rosterWidth });
        if (s.mode === 'mobile') continue;
        expect(s.railWidth + s.rosterWidth + s.chatWidth).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe('ручное решение человека сильнее адаптива', () => {
  test('свёрнутый вручную список остаётся свёрнутым и на широком окне', () => {
    const state = at(1800, { rosterCollapsedByUser: true });
    expect(state.rosterCompact).toBe(true);
    expect(state.mode).toBe('compact');
  });

  test('развёрнутый вручную список всё же сворачивается, если места нет', () => {
    // Иначе пришлось бы ужимать переписку — а это запрещено при любом выборе.
    const width = LAYOUT_SIZES.navRail + LAYOUT_SIZES.rosterMin + LAYOUT_SIZES.chatMin - 40;
    expect(at(width, { rosterCollapsedByUser: false }).rosterCompact).toBe(true);
  });
});

describe('переходы обратимы', () => {
  test('сужение и обратное расширение возвращают то же состояние', () => {
    const input = { ...base, rosterWidth: 340 };
    const wideBefore = resolveLayout({ ...input, width: 1500 });
    resolveLayout({ ...input, width: 700 });
    const wideAfter = resolveLayout({ ...input, width: 1500 });
    expect(wideAfter).toEqual(wideBefore);
  });
});

describe('порог мобильного режима', () => {
  test('MOBILE_MAX_WIDTH — последняя мобильная ширина, а не первая десктопная', () => {
    // Число обязано совпадать с `@media (max-width: 760px)`: разойдись они —
    // появится ширина, где половина стилей мобильная, а половина десктопная.
    expect(at(MOBILE_MAX_WIDTH).mode).toBe('mobile');
    expect(at(MOBILE_MAX_WIDTH + 1).mode).not.toBe('mobile');
  });
});
