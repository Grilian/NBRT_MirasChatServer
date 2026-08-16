import {
  RIGHT_PANEL_MAX_WIDTH, RIGHT_PANEL_MIN_WIDTH, ROSTER_MAX_WIDTH, ROSTER_MIN_WIDTH,
} from './uiPrefs';

// Единая адаптивная раскладка приложения: FULL → STANDARD → COMPACT → MOBILE.
//
// Главный принцип: размер окна меняет СПОСОБ ПРЕДСТАВЛЕНИЯ приложения, а не
// создаёт другую его версию. Поэтому режим — это одно вычисляемое значение на
// всё приложение, а не набор независимых медиазапросов по месту: раньше список
// чатов переключался по одному порогу, панель ветки по другому, и между ними
// существовали состояния, которых никто не проектировал (например, ветка,
// наехавшая на переписку поверх неё).
//
// Переход происходит не по «красивому» разрешению, а тогда, когда текущий
// набор областей перестаёт помещаться со своими минимальными рабочими
// ширинами. Поэтому расчёт принимает фактическую ширину списка чатов: у того,
// кто растянул список до 500px, переход наступит раньше — и это правильно, он
// сам распорядился местом.

/** Ширины областей, px. Подобраны замером реальной вёрстки, а не «на глаз». */
export const LAYOUT_SIZES = {
  /** Рельс разделов — фиксированный, см. .chat-layout в theme.css. */
  navRail: 68,
  /** Пределы полного списка чатов — те же, что у ручного изменения ширины. */
  rosterMin: ROSTER_MIN_WIDTH,
  rosterMax: ROSTER_MAX_WIDTH,
  /** Компактный список: аватар 40px + поля. Индикаторы влезают, подписи нет. */
  rosterCompact: 68,
  /**
   * Минимум переписки.
   *
   * Число не произвольное и не «поудобнее»: пузырь ограничен 70% ширины, и при
   * 520px это ~364px, то есть 45–50 знаков в строке — нижняя граница удобного
   * чтения. Заодно это ровно то значение, при котором у COMPACT появляется
   * собственная полоса: полный список перестаёт помещаться на 852px, а
   * мобильный режим начинается только с 760px. Возьми меньше 428 — и режим
   * «рельс + иконки + переписка» стал бы недостижим сужением окна, потому что
   * приложение проскакивало бы сразу в мобильный.
   */
  chatMin: 520,
  /** Пределы правой области — те же, что у её ручного изменения ширины. */
  rightMin: RIGHT_PANEL_MIN_WIDTH,
  rightMax: RIGHT_PANEL_MAX_WIDTH,
} as const;

/**
 * Порог мобильного режима. Обязан совпадать с `@media (max-width: 760px)` в
 * theme.css: ниже него всё оформление (нижняя навигация вместо рельса,
 * полноэкранная ветка, свои отступы) уже описано там, и вторая точка
 * переключения рядом означала бы состояние, где половина стилей мобильная, а
 * половина ещё десктопная.
 */
export const MOBILE_MAX_WIDTH = 760;

export type LayoutMode = 'full' | 'standard' | 'compact' | 'mobile';

export interface LayoutInput {
  /** Ширина окна (viewport). */
  width: number;
  /** Ширина полного списка чатов, выбранная пользователем. */
  rosterWidth: number;
  /** Пользователь открыл ветку/сведения/файлы — это его намерение, а не факт. */
  rightPanelRequested: boolean;
  /**
   * Пользователь САМ свернул список в иконки. `null` — не высказывался, и
   * тогда состоянием распоряжается адаптив.
   */
  rosterCollapsedByUser: boolean | null;
  /** Ширина правой области, выбранная пользователем. */
  rightPanelWidth?: number;
}

export interface LayoutState {
  mode: LayoutMode;
  /** Список чатов показывает только аватары. */
  rosterCompact: boolean;
  /** Правая область реально показывается. */
  rightPanelOpen: boolean;
  /**
   * Правую область закрыл адаптив, а не человек: значит при возврате места её
   * надо вернуть саму. Пользовательское закрытие так не восстанавливают.
   */
  rightPanelAutoClosed: boolean;
  /** Фактическая ширина списка после ограничений, px. */
  rosterWidth: number;
  /** Фактическая ширина правой области, px. Ноль — она закрыта. */
  rightPanelWidth: number;
  /** Сколько остаётся переписке — для отладки и проверок. */
  chatWidth: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Помещается ли набор областей со своими минимумами. */
function fits(width: number, parts: number[]): boolean {
  return parts.reduce((sum, part) => sum + part, 0) <= width;
}

/**
 * Единственное место, где решается, как выглядит приложение при данной ширине.
 *
 * Порядок уступок задан требованиями и менять его нельзя: первой уходит правая
 * область, затем список чатов сжимается в иконки, и только потом — мобильный
 * режим. Переписка не ужимается ниже своего минимума ни на одном шаге: ради
 * этого всё и делается.
 */
export function resolveLayout(input: LayoutInput): LayoutState {
  const { navRail, rosterMin, rosterMax, rosterCompact, chatMin, rightMin, rightMax } = LAYOUT_SIZES;
  const width = Math.max(0, input.width);

  if (width <= MOBILE_MAX_WIDTH) {
    // В мобильном режиме ширины областей не участвуют в раскладке вовсе:
    // экран занимает ровно один экран приложения. Но намерение открыть правую
    // область сохраняем — там она показывается поверх как отдельный экран.
    return {
      mode: 'mobile',
      rosterCompact: false,
      rightPanelOpen: input.rightPanelRequested,
      rightPanelAutoClosed: false,
      rosterWidth: input.rosterWidth,
      rightPanelWidth: 0,
      chatWidth: width,
    };
  }

  const desiredRoster = clamp(input.rosterWidth, rosterMin, rosterMax);

  // Список в иконках — либо по воле человека, либо потому, что полный уже не
  // оставляет переписке её минимума. Явное «разверни» уважается ровно до тех
  // пор, пока полный список вообще помещается: иначе пришлось бы ужимать
  // переписку, а это запрещено.
  const fullRosterFits = fits(width, [navRail, rosterMin, chatMin]);
  const compact = input.rosterCollapsedByUser === true || !fullRosterFits;

  if (!fits(width, [navRail, rosterCompact, chatMin])) {
    // Даже минимальный десктоп не собирается — промежуточных режимов здесь не
    // предусмотрено, сразу мобильный.
    return {
      mode: 'mobile',
      rosterCompact: false,
      rightPanelOpen: input.rightPanelRequested,
      rightPanelAutoClosed: false,
      rosterWidth: input.rosterWidth,
      rightPanelWidth: 0,
      chatWidth: width,
    };
  }

  // Переписке достаётся всё, что осталось, но не меньше её минимума: при
  // нехватке места сужается не она, а сам список (в пределах своего минимума).
  let rosterActual = compact
    ? rosterCompact
    : clamp(width - navRail - chatMin, rosterMin, desiredRoster);

  // Прежде чем закрывать правую область, отдаём ей место списка — панели
  // обязаны сначала ужаться в своих допустимых пределах, и только потом
  // меняется структура. Иначе на очень частой ширине 1280 ветка закрывалась
  // бы «на два пикселя», хотя достаточно было сузить список с 320 до 240.
  const rosterFloor = compact ? rosterCompact : rosterMin;
  const rightFits = fits(width, [navRail, rosterFloor, chatMin, rightMin]);
  const rightPanelOpen = input.rightPanelRequested && rightFits;
  const rightPanelAutoClosed = input.rightPanelRequested && !rightFits;

  // Правая область тоже ужимается до своего минимума, прежде чем отбирать
  // место у списка: сначала уступает та панель, чью ширину человек задал
  // последней, а закрывается она только когда и минимума не остаётся.
  const desiredRight = clamp(input.rightPanelWidth ?? rightMin, rightMin, rightMax);
  const rightWidth = rightPanelOpen
    ? clamp(width - navRail - rosterFloor - chatMin, rightMin, desiredRight)
    : 0;

  if (rightPanelOpen && !compact) {
    rosterActual = clamp(width - navRail - chatMin - rightWidth, rosterMin, desiredRoster);
  }

  const chatWidth = width - navRail - rosterActual - rightWidth;

  return {
    mode: rightPanelOpen ? 'full' : (compact ? 'compact' : 'standard'),
    rosterCompact: compact,
    rightPanelOpen,
    rightPanelAutoClosed,
    rosterWidth: rosterActual,
    rightPanelWidth: rightWidth,
    chatWidth,
  };
}

/**
 * Минимальная ширина окна, при которой правая область поместится рядом с уже
 * открытыми панелями. Нужна для требования «открытие правой области в узком
 * режиме расширяет приложение вправо, а не наезжает на переписку»: десктопный
 * клиент по этому числу раздвигает своё окно.
 */
export function widthNeededForRightPanel(rosterWidth: number, rosterCompact: boolean): number {
  const { navRail, rosterMin, rosterMax, rosterCompact: compactW, chatMin, rightMin } = LAYOUT_SIZES;
  const roster = rosterCompact ? compactW : clamp(rosterWidth, rosterMin, rosterMax);
  return navRail + roster + chatMin + rightMin;
}
