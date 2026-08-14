import { LAYOUT_SIZES, MOBILE_MAX_WIDTH, resolveLayout, widthNeededForRightPanel } from './layoutMode';

const base = {
  rosterWidth: 320,
  rightPanelRequested: false,
  rosterCollapsedByUser: null as boolean | null,
};

const at = (width: number, over: Partial<typeof base> = {}) =>
  resolveLayout({ ...base, ...over, width });

describe('порядок уступок при сужении окна', () => {
  test('на широком окне открыты все четыре области', () => {
    const state = at(1600, { rightPanelRequested: true });
    expect(state.mode).toBe('full');
    expect(state.rightPanelOpen).toBe(true);
    expect(state.rosterCompact).toBe(false);
  });

  test('первой уступает место правая область, а не переписка', () => {
    // Ширины хватает на рельс + список + переписку, но не на ветку рядом.
    const width = LAYOUT_SIZES.navRail + 320 + LAYOUT_SIZES.chatMin + 100;
    const state = at(width, { rightPanelRequested: true });

    expect(state.mode).toBe('standard');
    expect(state.rightPanelOpen).toBe(false);
    // Закрыл адаптив, а не человек — значит при возврате места вернуть саму.
    expect(state.rightPanelAutoClosed).toBe(true);
    // Освободившееся место досталось переписке.
    expect(state.chatWidth).toBeGreaterThanOrEqual(LAYOUT_SIZES.chatMin);
  });

  test('следом список чатов уходит в иконки', () => {
    // Полный список со своим минимумом уже не оставляет переписке её минимума.
    const width = LAYOUT_SIZES.navRail + LAYOUT_SIZES.rosterMin + LAYOUT_SIZES.chatMin - 30;
    const state = at(width);

    expect(state.mode).toBe('compact');
    expect(state.rosterCompact).toBe(true);
    expect(state.rosterWidth).toBe(LAYOUT_SIZES.rosterCompact);
  });

  test('когда не собирается даже «рельс + иконки + переписка» — сразу мобильный', () => {
    const width = LAYOUT_SIZES.navRail + LAYOUT_SIZES.rosterCompact + LAYOUT_SIZES.chatMin - 1;
    expect(at(width).mode).toBe('mobile');
  });

  test('промежуточного режима без глобальной навигации не существует', () => {
    // На любой ширине это либо десктоп с рельсом, либо мобильный с нижней
    // навигацией — «десктоп без навигации» не должен появляться нигде.
    for (let width = 300; width <= 2000; width += 7) {
      const state = at(width, { rightPanelRequested: true });
      expect(['full', 'standard', 'compact', 'mobile']).toContain(state.mode);
    }
  });
});

describe('переписка не сжимается ниже рабочего минимума', () => {
  test('на всех десктопных ширинах переписке остаётся не меньше минимума', () => {
    for (let width = MOBILE_MAX_WIDTH + 1; width <= 2200; width += 13) {
      for (const rosterWidth of [240, 320, 460, 560]) {
        const state = at(width, { rosterWidth, rightPanelRequested: true });
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

  test('закрытую человеком правую область окно обратно не открывает', () => {
    const state = at(1800, { rightPanelRequested: false });
    expect(state.rightPanelOpen).toBe(false);
    // Раз не просили — и восстанавливать нечего.
    expect(state.rightPanelAutoClosed).toBe(false);
  });

  test('закрытая адаптивом правая область возвращается сама при возврате места', () => {
    const narrow = at(900, { rightPanelRequested: true });
    expect(narrow.rightPanelOpen).toBe(false);
    expect(narrow.rightPanelAutoClosed).toBe(true);

    const wide = at(1600, { rightPanelRequested: true });
    expect(wide.rightPanelOpen).toBe(true);
  });
});

describe('расширение окна под правую область', () => {
  test('считает ширину, при которой ветка встанет рядом, а не поверх', () => {
    const needed = widthNeededForRightPanel(320, false);
    expect(needed).toBe(
      LAYOUT_SIZES.navRail + 320 + LAYOUT_SIZES.chatMin + LAYOUT_SIZES.rightMin
    );
    // На этой ширине панель обязана поместиться на самом деле.
    expect(at(needed, { rightPanelRequested: true }).rightPanelOpen).toBe(true);
  });

  test('для компактного списка нужно меньше места', () => {
    expect(widthNeededForRightPanel(320, true))
      .toBeLessThan(widthNeededForRightPanel(320, false));
  });
});

describe('переходы обратимы', () => {
  test('сужение и обратное расширение возвращают то же состояние', () => {
    const input = { ...base, rightPanelRequested: true, rosterWidth: 340 };
    const wideBefore = resolveLayout({ ...input, width: 1500 });
    resolveLayout({ ...input, width: 700 });
    const wideAfter = resolveLayout({ ...input, width: 1500 });
    expect(wideAfter).toEqual(wideBefore);
  });
});
