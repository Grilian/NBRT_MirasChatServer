import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { nameFor } from '../utils/user';
import { formatDaySeparator, formatMoscowDateTime, formatMoscowTime, moscowDayKey } from '../utils/time';
import { isNativeMobile } from '../utils/mobileNotify';
import { onKeyboardShow } from '../utils/mobileKeyboard';
import { resolveUploadUrl } from '../utils/uploads';
import { CustomEmojiMap, renderTextWithEmoji, toPlainText } from '../utils/customEmoji';
import Avatar from './Avatar';
import ReactionDetailsModal, { MessageReaction } from './ReactionDetailsModal';
import ImageLightbox from './ImageLightbox';
import PollCard from './PollCard';
import { Poll } from '../types/poll';

interface Message {
  id: number;
  text: string;
  file_path?: string | null;
  file_width?: number | null;
  file_height?: number | null;
  sender_id: number;
  username: string;
  display_name?: string | null;
  created_at: string;
  status?: 'sent' | 'delivered' | 'read';
  edited_at?: string | null;
  deleted?: boolean | number;
  /** Когда прочитали — только в личной переписке (см. readReceipts.js). */
  read_at?: number | null;
  /** Сколько человек прочитало — приходит только в каналах-объявлениях. */
  read_count?: number;
  reply_to_id?: number | null;
  reply_to_text?: string | null;
  reply_to_file?: string | null;
  reply_to_author?: string | null;
  reply_to_deleted?: number | boolean | null;
  forwarded_from_name?: string | null;
  forwarded_from_chat?: string | null;
  reactions?: MessageReaction[];
  poll?: Poll;
}

interface ChatWindowProps {
  chatId: string | null;
  messages: Message[];
  currentUserId: number;
  /** Показывать имя автора над сообщением — нужно только в общем чате */
  showAuthors?: boolean;
  onScrollTop?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  /** Непрочитанные в этом чате — цифра на кнопке «вниз», как в Telegram */
  unreadCount?: number;
  /** Начать правку — текст уезжает в поле ввода (см. startEdit). */
  onStartEdit: (id: number, text: string) => void;
  /** Сообщение, которое сейчас правят, — подсвечиваем его в ленте. */
  editingId?: number | null;
  onDeleteMessage: (id: number) => void;
  /** Создатель группы может удалять чужие сообщения — не только свои. */
  onDeleteMessages?: (ids: number[]) => void;
  /** Завести поручение по тексту сообщения — открывает раздел «Задачи». */
  onCreateTask?: (text: string) => void;
  /** Ответить на сообщение — панель над полем ввода, как при правке. */
  onStartReply?: (msg: { id: number; text: string; author: string; hasImage: boolean }) => void;
  /** Переслать выбранные сообщения — открывает выбор чата. */
  onForward?: (ids: number[]) => void;
  /** Набор базовых реакций из панели управления. */
  reactionEmoji?: string[];
  /** Каталог кастомных смайликов: :name: → путь к картинке. */
  customEmoji?: CustomEmojiMap;
  /** Поставить/снять свою реакцию (повторная та же — снимает). */
  onToggleReaction?: (messageId: number, emoji: string) => void;
  /** Снять реакцию конкретного человека (своя — всегда, чужая — под своим). */
  onRemoveReaction?: (messageId: number, userId: number) => void;
  /** Переслать в личный чат «Избранное» одним нажатием, минуя выбор чата. */
  onForwardToSelf?: (ids: number[]) => void;
  /** Название личного чата из панели управления — оно в пункте меню. */
  selfChatName?: string;
  onVotePoll?: (pollId: number, optionIds: number[]) => void;
  onAddPollOption?: (pollId: number, text: string) => void;
  onStopPoll?: (pollId: number) => void;
}

const LONG_PRESS_MS = 450;

// Сколько лиц показываем в чипе реакции, прежде чем перейти на число.
const REACTION_FACES_MAX = 3;

// Сколько реакций помещается в один ряд плашки над меню; остальные прячутся
// за стрелку. Не «сколько влезет по ширине» — число фиксировано, чтобы ряд
// не перестраивался от длины набора и не прыгал при открытии меню.
const REACTIONS_IN_ROW = 6;

/**
 * Одинаковые реакции складываем в один чип. Порядок групп — по первому
 * поставившему, чтобы чипы не прыгали местами при каждой новой реакции.
 */
function groupReactions(reactions: MessageReaction[]) {
  const groups: { emoji: string; list: MessageReaction[] }[] = [];
  for (const reaction of reactions) {
    const existing = groups.find((g) => g.emoji === reaction.emoji);
    if (existing) existing.list.push(reaction);
    else groups.push({ emoji: reaction.emoji, list: [reaction] });
  }
  return groups;
}

// Пункт контекстного меню сообщения. 'info' — не действие, а отметка
// («Прочитано в …»), поэтому у неё нет ни иконки, ни обработчика.
type MenuItem =
  | { kind: 'action'; key: string; label: string; icon: React.ReactNode; onClick: () => void; danger?: boolean }
  | { kind: 'info'; key: string; label: string };

// Идущие подряд сообщения одного человека Telegram склеивает в блок: имя
// показывается один раз сверху, «хвостик» — только у последнего. Разрыв
// больше пяти минут считаем новым блоком, даже если писал тот же человек.
const GROUP_WINDOW_MS = 5 * 60 * 1000;

function TickIcon({ status }: { status: 'sent' | 'delivered' | 'read' }) {
  const doubleTick = status === 'delivered' || status === 'read';
  return (
    <span className={'ticks' + (status === 'read' ? ' read' : '')}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
        {doubleTick ? (
          <><path d="m1 13 4 4L15 7" /><path d="m9 13 4 4L23 7" /></>
        ) : (
          <path d="m4 13 5 5L20 7" />
        )}
      </svg>
    </span>
  );
}

interface RenderedRow {
  message: Message;
  /** Первое сообщение в блоке одного автора — над ним подпись автора */
  startsGroup: boolean;
  /** Последнее сообщение в блоке — у него рисуется хвостик пузыря */
  endsGroup: boolean;
  /** Разделитель дня перед этим сообщением */
  daySeparator: string | null;
}

function buildRows(messages: Message[]): RenderedRow[] {
  return messages.map((message, index) => {
    const prev = index > 0 ? messages[index - 1] : null;
    const next = index < messages.length - 1 ? messages[index + 1] : null;

    const dayKey = moscowDayKey(message.created_at);
    const prevDayKey = prev ? moscowDayKey(prev.created_at) : null;
    const newDay = dayKey !== prevDayKey;

    const time = new Date(message.created_at).getTime();
    const groupsWithPrev = !!prev
      && !newDay
      && prev.sender_id === message.sender_id
      && time - new Date(prev.created_at).getTime() < GROUP_WINDOW_MS;
    const groupsWithNext = !!next
      && moscowDayKey(next.created_at) === dayKey
      && next.sender_id === message.sender_id
      && new Date(next.created_at).getTime() - time < GROUP_WINDOW_MS;

    return {
      message,
      startsGroup: !groupsWithPrev,
      endsGroup: !groupsWithNext,
      daySeparator: newDay ? formatDaySeparator(message.created_at) : null,
    };
  });
}

const ChatWindow: React.FC<ChatWindowProps> = ({
  chatId, messages: rawMessages, currentUserId, showAuthors, onScrollTop, hasMore, loadingMore, unreadCount,
  onStartEdit, editingId, onDeleteMessage, onDeleteMessages, onCreateTask,
  onStartReply, onForward, reactionEmoji, customEmoji = {}, onToggleReaction, onRemoveReaction,
  onForwardToSelf, selfChatName, onVotePoll, onAddPollOption, onStopPoll,
}) => {
  // Удалённое сообщение хранится на сервере (обязательство по закону — до
  // 3 лет метаданные о факте передачи), но в переписке не должно быть видно
  // вообще, включая плейсхолдер "Сообщение удалено" — поэтому просто не
  // рендерим такие строки, а не показываем их пустым пузырём.
  const messages = rawMessages.filter((m) => !m.deleted);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const [shouldScrollToBottom, setShouldScrollToBottom] = useState(true);
  const [showJumpButton, setShowJumpButton] = useState(false);
  // При первом открытии нового чата не показываем пользователю промежуточное
  // положение ленты (сначала сверху, затем несколько доводок вниз). Сам DOM
  // при этом уже отрисован и участвует в layout, поэтому размеры можно
  // измерить и выставить scrollTop до появления содержимого.
  const [initialPositioning, setInitialPositioning] = useState(true);
  const prevMessagesLengthRef = useRef(0);
  // Пока новый чат только позиционируется внизу, события scroll не должны
  // запускать подгрузку истории. Иначе начальный scrollTop=0 может быть
  // ошибочно принят за ручную прокрутку пользователя к старым сообщениям.
  const initialPinRef = useRef(false);
  const initialPinTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const [menuFor, setMenuFor] = useState<{ id: number; x: number; y: number } | null>(null);
  // Развёрнутый ряд реакций живёт только пока открыто меню: следующее
  // открытие должно начинаться с компактного вида, а не помнить прошлый.
  const [reactionsExpanded, setReactionsExpanded] = useState(false);
  // Сообщение, чьи реакции сейчас разбирают в детальном списке.
  const [reactionsFor, setReactionsFor] = useState<number | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Режим выбора доступен всем и на любых сообщениях. При уходе из чата гасим
  // его, а не оставляем висеть с id из прошлой переписки.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  // Позиция прокрутки на момент запроса следующей страницы истории —
  // подробности в useLayoutEffect ниже.
  const pendingRestoreRef = useRef<{ height: number; top: number } | null>(null);

  // Читается внутри эффектов вместо state — по значению из замыкания.
  // Обновляется в теле рендера, а не в отдельном эффекте, поэтому к моменту,
  // когда эффекты ниже выполняются, всегда содержит актуальное значение.
  const shouldScrollRef = useRef(shouldScrollToBottom);
  shouldScrollRef.current = shouldScrollToBottom;

  // Смена чата не обязана совпадать по кадру с эффектом ниже (порядок эффектов
  // в компоненте фиксирован объявлением, а не тем, что изменилось раньше), а
  // shouldScrollToBottom в этот момент мог ещё хранить значение от ПРЕЖНЕГО
  // чата — например, false, если там читали историю выше. Эффект срабатывал
  // с этим устаревшим флагом, прокрутки не было, а prevMessagesLengthRef при
  // этом уже обновлялся до длины нового чата — и повторный запуск того же
  // эффекта (после того как флаг наконец переставили в true) видел
  // messages.length, равный уже записанному, и снова не прокручивал. Чат
  // открывался неизвестно где — ровно то, что было замечено на Android.
  // Читаем свежее значение флага через ref, а не как зависимость эффекта:
  // так эффект реагирует только на реальную смену сообщений/чата, а не на
  // побочный проброс того же флага через другой эффект.
  const prevChatIdRef = useRef<string | null>(null);

  // Скроллим сам контейнер, а не нижний div через scrollIntoView().
  // scrollIntoView умеет прокручивать сразу несколько scroll-родителей и
  // зависит от геометрии marker-элемента; при открытии чата layout ещё может
  // измениться на следующем кадре (шрифты, реакции, картинки, ширина scrollbar).
  // В результате браузер сохранял старый scrollTop, а настоящее дно уезжало
  // на несколько сообщений ниже. На Windows и Android это проявлялось одинаково.
  const scrollContainerToBottom = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
  }, []);

  const stopInitialPin = useCallback(() => {
    initialPinRef.current = false;
    initialPinTimersRef.current.forEach(clearTimeout);
    initialPinTimersRef.current = [];
  }, []);

  const startInitialPin = useCallback(() => {
    stopInitialPin();
    initialPinRef.current = true;
    setInitialPositioning(true);
    scrollContainerToBottom();

    // Первые доводки происходят пока лента ещё невидима. Уже через 140 мс
    // показываем её в окончательном положении — пользователь не видит путь
    // от scrollTop=0 до низа. Более поздние страховочные доводки оставляем
    // для медиа, которые догружаются после первого layout.
    [0, 40, 100, 140, 300, 700, 1200].forEach((delay, index, arr) => {
      const timer = setTimeout(() => {
        if (!initialPinRef.current) return;
        scrollContainerToBottom();
        if (delay === 140) setInitialPositioning(false);
        if (index === arr.length - 1) initialPinRef.current = false;
      }, delay);
      initialPinTimersRef.current.push(timer);
    });
  }, [scrollContainerToBottom, stopInitialPin]);

  // Скрываем именно ленту нового чата ещё до показа первого кадра.
  // useLayoutEffect здесь принципиален: обычный useEffect успел бы показать
  // один кадр со старой/верхней позицией и моргание осталось бы.
  useLayoutEffect(() => {
    setInitialPositioning(true);
  }, [chatId]);

  useLayoutEffect(() => {
    if (messages.length === 0) {
      setInitialPositioning(false);
      return;
    }

    const chatJustOpened = prevChatIdRef.current !== chatId;
    const grew = messages.length > prevMessagesLengthRef.current;
    // Последнее добавленное — моё собственное: после отправки своего
    // сообщения лента уходит вниз всегда, даже если до этого читали историю
    // выше, — как и ожидается от «отправил и увидел, что ушло».
    const lastIsMine = grew && messages[messages.length - 1]?.sender_id === currentUserId;
    const mustStickToBottom = chatJustOpened || lastIsMine || (grew && shouldScrollRef.current);

    if (mustStickToBottom) {
      // Первый проход — до показа кадра. При открытии чата делаем ещё две
      // доводки: Chromium/WebView может закончить расчёт размеров только на
      // следующих кадрах. Это не smooth-scroll, поэтому пользователь не видит
      // промежуточного прыжка.
      if (chatJustOpened) startInitialPin();
      else scrollContainerToBottom();
    }

    prevMessagesLengthRef.current = messages.length;
    prevChatIdRef.current = chatId;
  }, [messages, chatId, currentUserId, scrollContainerToBottom, startInitialPin]);

  // Появление экранной клавиатуры на Android физически уменьшает высоту
  // WebView (adjustResize) — flex-раскладка тут же сжимает conv-body под
  // новый размер, но её scrollTop остаётся прежним числом. Раньше «дно»
  // ленты просто уезжало под новый нижний край: последние сообщения
  // оказывались за пределами видимой области, и добраться до них можно было
  // только ручной прокруткой. Довозвращаем прокрутку к концу сами — и только
  // если человек и так были внизу: если он читает историю выше, набор
  // сообщения не должен выдёргивать его обратно к последним репликам.

  useEffect(() => {
    return onKeyboardShow(() => {
      if (!shouldScrollRef.current) return;
      // Двойной rAF: колбэк плагина срабатывает раньше, чем WebView
      // фактически перестроился под новую высоту (scrollHeight ещё старый) —
      // один кадр на применение резайза, второй на коммит разметки.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
        });
      });
    });
  }, []);

  // Системная клавиатура — не единственное, что меняет доступную высоту ленты:
  // мобильная панель смайликов теперь занимает её место внутри composer. При
  // переключении сохраняем «приклеенность» к последнему сообщению, но только
  // если пользователь и до этого был внизу — чтение старой истории не рвём.
  useEffect(() => {
    const onComposerResize = () => {
      if (!shouldScrollRef.current) return;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => scrollContainerToBottom());
      });
    };
    window.addEventListener('miras-composer-resize', onComposerResize);
    return () => window.removeEventListener('miras-composer-resize', onComposerResize);
  }, [scrollContainerToBottom]);

  // Подгрузка истории добавляет сообщения СВЕРХУ, из-за чего содержимое
  // уезжает вниз, а прокрутка остаётся на месте — визуально это выглядело
  // как прыжок к совсем другому куску переписки, и читать историю было
  // невозможно. Возвращаем прокрутку к тому же сообщению: смещаем её ровно
  // на прирост высоты. useLayoutEffect — чтобы поправить до отрисовки кадра
  // и человек не увидел скачка.
  useLayoutEffect(() => {
    const pending = pendingRestoreRef.current;
    const container = messagesContainerRef.current;
    if (!pending || !container) return;
    if (container.scrollHeight <= pending.height) return;

    container.scrollTop = container.scrollHeight - pending.height + pending.top;
    pendingRestoreRef.current = null;
  }, [messages]);

  useEffect(() => {
    setShouldScrollToBottom(true);
    setShowJumpButton(false);
    prevMessagesLengthRef.current = 0;
    pendingRestoreRef.current = null;
    setMenuFor(null);
    setSelectMode(false);
    setSelectedIds(new Set());
  }, [chatId]);

  // Таймеры первоначального позиционирования не должны пережить сам компонент.
  useEffect(() => () => stopInitialPin(), [stopInitialPin]);

  // Сняли последнюю галочку — выходим из режима выделения сами, отдельной
  // кнопки «Отмена» для этого не требуют.
  useEffect(() => {
    if (selectMode && selectedIds.size === 0) setSelectMode(false);
  }, [selectMode, selectedIds]);

  // Закрытие контекстного меню по клику снаружи
  useEffect(() => {
    if (!menuFor) return;
    const onDocClick = (e: Event) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuFor(null);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('touchstart', onDocClick);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('touchstart', onDocClick);
    };
  }, [menuFor]);

  // Меню открывается ровно в точке клика/долгого нажатия — у сообщения
  // близко к правому или нижнему краю экрана оно раньше вылезало за
  // видимую область (особенно у своих реплик, прижатых вправо). Подправляем
  // после первой отрисовки, когда уже известны реальные размеры меню:
  // если что-то не помещается, отодвигаем ровно настолько, чтобы влезло.
  useLayoutEffect(() => {
    if (!menuFor || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const overflowX = rect.right - window.innerWidth;
    const overflowY = rect.bottom - window.innerHeight;
    if (overflowX <= 0 && overflowY <= 0) return;

    const nextX = overflowX > 0 ? Math.max(4, menuFor.x - overflowX) : menuFor.x;
    const nextY = overflowY > 0 ? Math.max(4, menuFor.y - overflowY) : menuFor.y;

    // Сдвигать дальше некуда — меню просто выше окна (низкий экран, а пунктов
    // в нём прибавилось). Без этой проверки эффект бесконечно переставлял
    // меню в ту же позицию: сдвиг упирался в Math.max(4, …), overflow
    // оставался, состояние менялось «на то же самое», и React рвал цикл
    // ошибкой «Maximum update depth exceeded». За переполнение по высоте
    // теперь отвечает прокрутка внутри самого меню (см. .msg-context-menu).
    if (nextX === menuFor.x && nextY === menuFor.y) return;

    setMenuFor((prev) => prev && ({ ...prev, x: nextX, y: nextY }));
  }, [menuFor]);

  const handleScroll = () => {
    if (!messagesContainerRef.current) return;

    const { scrollTop, scrollHeight, clientHeight } = messagesContainerRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
    setShouldScrollToBottom(isAtBottom);
    // Порог был 300px — на коротком экране до него попросту не долистать, и
    // кнопка не появлялась вовсе. Хватает одного «экранчика» отступа от низа.
    setShowJumpButton(scrollHeight - scrollTop - clientHeight > 120);

    if (!initialPinRef.current && scrollTop < 150 && onScrollTop && hasMore && !loadingMore) {
      pendingRestoreRef.current = { height: scrollHeight, top: scrollTop };
      onScrollTop();
    }
  };

  const jumpToBottom = () => {
    setShouldScrollToBottom(true);
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Клик по цитате уводит к исходному сообщению. Если оно ещё не подгружено
  // (осталось выше по истории) — подсвечивать нечего, молча ничего не делаем:
  // дотягивать историю до произвольного id пришлось бы отдельной ручкой.
  const [highlightedId, setHighlightedId] = useState<number | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const jumpToMessage = (id: number) => {
    const node = messagesContainerRef.current?.querySelector(`[data-msg-id="${id}"]`);
    if (!node) return;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightedId(id);
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlightedId(null), 1600);
  };

  useEffect(() => () => { if (highlightTimer.current) clearTimeout(highlightTimer.current); }, []);

  // Раньше меню открывалось только на своих сообщениях — скопировать текст
  // чужой реплики было нельзя вовсе. Теперь оно доступно на любом
  // непустом сообщении; какие пункты в нём показать (только «Копировать»
  // или ещё и «Редактировать»/«Удалить»), решает уже сам рендер меню по
  // мере сравнения sender_id с currentUserId.
  const openMenuAt = (msg: Message, x: number, y: number) => {
    if (selectMode) return;
    setReactionsExpanded(false);
    setMenuFor({ id: msg.id, x, y });
  };

  const handleContextMenu = (e: React.MouseEvent, msg: Message) => {
    e.preventDefault();
    openMenuAt(msg, e.clientX, e.clientY);
  };

  const clearLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  // Жест на Android. Три исхода одного касания:
  //  - просто отпустили без задержки и почти не двигая пальцем — тап,
  //    открывает контекстное меню (как клик на ПК, только рукой);
  //  - подержали не двигая LONG_PRESS_MS — вход в режим выделения, отмечается
  //    само тронутое сообщение;
  //  - подвинули палец раньше, чем истекло удержание, — это прокрутка ленты,
  //    жест целиком отменяется и ничему не мешает.
  // Пока режим выделения не наступил (ни долгим удержанием, ни раньше через
  // пункт меню/уже начатым выделением), любое движение пальца — чужая
  // территория: тянуть диапазон нельзя, иначе простой скролл то и дело
  // задевал бы соседние сообщения.
  //
  // Обработчики висят на всей строке .msg, а не на пузыре: по требованию
  // пустая область слева и справа от сообщения тоже должна ловить нажатие.
  const touchGesture = useRef<{
    startX: number; startY: number; anchorId: number;
    moved: boolean; sweeping: boolean; startedSelection: boolean; menuWasOpen: boolean;
    /** Что было отмечено до начала протяжки — диапазон добавляется к этому,
        иначе новая протяжка стирала бы всё, отмеченное до неё. */
    baseSelection: Set<number>;
  } | null>(null);

  // Протяжка читает актуальное выделение из ref: колбэк долгого удержания
  // живёт с того рендера, на котором завёлся таймер, и в state там уже старое.
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;

  const messageIdAtPoint = (x: number, y: number): number | null => {
    const el = document.elementFromPoint(x, y)?.closest('[data-msg-id]');
    const raw = el?.getAttribute('data-msg-id');
    return raw ? Number(raw) : null;
  };

  // Пока идёт протяжка, системное выделение текста должно молчать: иначе
  // Android поверх нашего выделения поднимает свои маркеры и меню «Копировать».
  const [touchSelecting, setTouchSelecting] = useState(false);

  // Во время протяжки-выделения лента не должна ехать под пальцем: сообщения
  // уезжали бы, а elementFromPoint читал бы точку уже по новому содержимому —
  // выделение прыгало по соседям. React вешает touchmove пассивно (17+), из
  // его обработчика preventDefault не работает, поэтому слушатель свой.
  const sweepingRef = useRef(false);

  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const lockScroll = (e: TouchEvent) => { if (sweepingRef.current) e.preventDefault(); };
    el.addEventListener('touchmove', lockScroll, { passive: false });
    return () => el.removeEventListener('touchmove', lockScroll);
    // Зависимость от chatId обязательна: без выбранного чата рендерится
    // заглушка, контейнера ещё нет, и эффект с пустыми зависимостями навесил
    // бы слушатель ровно один раз — в тот момент, когда вешать не на что.
  }, [chatId]);

  const DRAG_THRESHOLD_PX = 12;

  const handleTouchStart = (e: React.TouchEvent, msg: Message) => {
    const touch = e.touches[0];
    clearLongPress();

    // Палец лёг на кнопку внутри сообщения (картинка, цитата-переход,
    // плашка реакции, галочка выбора) — у неё своё действие. Жест не заводим
    // вовсе: иначе touchend погасил бы синтетический click ради меню, и
    // картинка перестала бы открываться по тапу.
    if ((e.target as HTMLElement).closest('button, a, input, [role="button"]')) {
      touchGesture.current = null;
      return;
    }

    touchGesture.current = {
      startX: touch.clientX, startY: touch.clientY, anchorId: msg.id,
      moved: false, sweeping: false, startedSelection: false,
      // Открытое меню закрывает обработчик клика снаружи — он сработает на
      // этом же touchstart. Без отметки тап по сообщению открывал бы меню
      // заново, и закрыть его тапом было бы невозможно вовсе.
      menuWasOpen: !!menuFor,
      baseSelection: new Set(),
    };

    // Таймер заводим и в режиме выделения: удержание там начинает новую
    // протяжку. Обычное же движение пальцем в режиме выделения остаётся
    // прокруткой — иначе до сообщений за пределами экрана было бы не
    // добраться, а отметить их нужно ровно так же, как видимые.
    longPressTimer.current = setTimeout(() => {
      const gesture = touchGesture.current;
      longPressTimer.current = null;
      if (!gesture || gesture.moved) return; // палец уже увели — это была прокрутка
      gesture.sweeping = true;
      gesture.startedSelection = true;
      gesture.baseSelection = new Set(selectedIdsRef.current);
      sweepingRef.current = true;
      setTouchSelecting(true);
      setSelectMode(true);
      setSelectedIds(new Set([...Array.from(gesture.baseSelection), gesture.anchorId]));
    }, LONG_PRESS_MS);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    const gesture = touchGesture.current;
    const touch = e.touches[0];
    if (!gesture || !touch) return;

    const movedFar = Math.abs(touch.clientX - gesture.startX) > DRAG_THRESHOLD_PX
      || Math.abs(touch.clientY - gesture.startY) > DRAG_THRESHOLD_PX;

    if (!gesture.sweeping) {
      // Долгое удержание ещё не сработало — движение сейчас означает обычную
      // прокрутку, а не жест: снимаем таймер (тапом это тоже быть перестало)
      // и не вмешиваемся, чтобы лента продолжила скроллиться как обычно.
      if (movedFar) {
        gesture.moved = true;
        clearLongPress();
      }
      return;
    }

    // Протяжка после удержания: всё между началом жеста и текущей точкой —
    // выделено, поверх того, что было отмечено до неё.
    const overId = messageIdAtPoint(touch.clientX, touch.clientY);
    if (overId === null) return;

    const ids = messages.map((m) => m.id);
    const from = ids.indexOf(gesture.anchorId);
    const to = ids.indexOf(overId);
    if (from === -1 || to === -1) return;

    const [lo, hi] = from <= to ? [from, to] : [to, from];
    setSelectedIds(new Set([...Array.from(gesture.baseSelection), ...ids.slice(lo, hi + 1)]));
  };

  const handleTouchEnd = (e: React.TouchEvent, msg: Message) => {
    const gesture = touchGesture.current;
    clearLongPress();
    touchGesture.current = null;
    sweepingRef.current = false;
    setTouchSelecting(false);

    if (!gesture) return;
    // Прокрутка — жеста не было, синтетику браузера не трогаем.
    if (gesture.moved) return;

    // Гасим синтетические mouse-события, которые браузер досылает после
    // touchend, и делаем работу тапа сами. Полагаться на них нельзя: click
    // приходит в ту же точку с задержкой, когда там уже нарисовано меню, и
    // «нажимал» пункт под пальцем (ловили как самопроизвольную пересылку); а
    // после долгого удержания он приходил по самому сообщению и тут же снимал
    // только что поставленную отметку — режим выделения захлопывался сразу.
    e.preventDefault();

    // Долгое удержание уже сделало своё дело — сообщение отмечено, тапа не было.
    if (gesture.startedSelection) return;

    const touch = e.changedTouches[0];
    if (!touch) return;

    // В режиме выделения тап отмечает/снимает, вне его — открывает меню
    // (кроме случая, когда этим же тапом меню только что закрыли).
    if (selectMode) toggleSelected(msg.id);
    else if (!gesture.menuWasOpen) openMenuAt(msg, touch.clientX, touch.clientY);
  };

  // Отмена жеста системой (входящий звонок, смена окна) — это не отпускание
  // пальца, тап тут не открываем, просто гасим состояние.
  const handleTouchCancel = () => {
    clearLongPress();
    touchGesture.current = null;
    sweepingRef.current = false;
    setTouchSelecting(false);
  };

  // Снятие реакции живёт в детальном списке (ReactionDetailsModal): со
  // стакингом чип перестал быть одним человеком, и ни крестик на нём, ни
  // удержание по нему не знают, чью реакцию убирать. Свою по-прежнему
  // снимает повторный выбор того же эмодзи в контекстном меню.

  // Состав меню задан в требованиях отдельно для ПК и Android и отдельно для
  // своего/чужого сообщения. Собираем списком, а не гирляндой из && прямо в
  // разметке: порядок пунктов там разный, и уследить за ним по месту нельзя.
  const buildMenuItems = (msg: Message, mine: boolean): MenuItem[] => {
    // Принимает сколько угодно контуров: раньше их было два, и иконки из трёх
    // частей молча теряли лишнее — «Копировать» рисовалась одним уголком.
    const icon = (...paths: string[]) => (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        {paths.map((d, i) => <path key={i} d={d} />)}
      </svg>
    );

    const reply: MenuItem | null = onStartReply ? {
      kind: 'action', key: 'reply', label: 'Ответить',
      icon: icon('m9 17-5-5 5-5', 'M20 18v-2a4 4 0 0 0-4-4H4'),
      onClick: () => {
        setMenuFor(null);
        onStartReply({ id: msg.id, text: msg.text, author: nameFor(msg), hasImage: !!msg.file_path });
      },
    } : null;

    const edit: MenuItem | null = mine && !msg.poll ? {
      kind: 'action', key: 'edit', label: 'Изменить',
      icon: icon('M12 20h9', 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z'),
      onClick: () => startEdit(msg),
    } : null;

    const pollClosed = !!msg.poll?.closed_at || (!!msg.poll?.closes_at && msg.poll.closes_at <= Date.now());
    const stopPollItem: MenuItem | null = msg.poll && Number(msg.poll.creator_id) === Number(currentUserId) && !pollClosed && onStopPoll ? {
      kind: 'action', key: 'stop-poll', label: 'Остановить опрос', danger: true,
      icon: icon('M4 4l16 16', 'M5 9h4V5', 'M15 19v-4h4'),
      onClick: () => {
        setMenuFor(null);
        if (window.confirm('Остановить опрос? После этого новые голоса принимать нельзя.')) onStopPoll(msg.poll!.id);
      },
    } : null;

    // У картинки без подписи копировать нечего — текста в сообщении нет.
    const copy: MenuItem | null = msg.text ? {
      kind: 'action', key: 'copy', label: 'Копировать',
      icon: icon(
        'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
        'M9 9h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z',
      ),
      onClick: () => copyMessageText(msg),
    } : null;

    const task: MenuItem | null = msg.text && onCreateTask ? {
      kind: 'action', key: 'task', label: 'Создать задачу',
      // Список с пунктами — как в референсе; галочка читалась как «готово».
      icon: icon('M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'),
      onClick: () => { setMenuFor(null); onCreateTask(msg.text); },
    } : null;

    const forward: MenuItem | null = onForward && !msg.poll ? {
      kind: 'action', key: 'forward', label: 'Переслать',
      icon: icon('m15 17 5-5-5-5', 'M4 18v-2a4 4 0 0 1 4-4h12'),
      onClick: () => { setMenuFor(null); onForward([msg.id]); },
    } : null;

    // Название берём из панели управления: там его меняют на «Облако» или
    // «Архив», и пункт меню обязан называть чат так же, как список чатов.
    const forwardSelf: MenuItem | null = onForwardToSelf && !msg.poll ? {
      kind: 'action', key: 'forward-self', label: `Переслать в ${selfChatName || 'Избранное'}`,
      icon: icon('M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z'),
      onClick: () => { setMenuFor(null); onForwardToSelf([msg.id]); },
    } : null;

    const remove: MenuItem = {
      kind: 'action', key: 'delete', label: 'Удалить', danger: true,
      icon: icon('M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6'),
      onClick: () => confirmDelete(msg.id),
    };

    // На Android выделение начинается долгим нажатием с протяжкой, поэтому
    // пункта в меню там нет — он только на ПК, где такого жеста нет.
    const select: MenuItem | null = !isNativeMobile ? {
      kind: 'action', key: 'select', label: 'Выделить',
      icon: icon('M9 11l3 3L22 4', 'M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11'),
      onClick: () => { setMenuFor(null); setSelectMode(true); toggleSelected(msg.id); },
    } : null;

    // Отметки показываем только при наличии данных — как и требует спека.
    // read_at есть лишь в личной переписке: в группах время прочтения у
    // каждого своё, одной метки на сообщение там не существует.
    const readInfo: MenuItem | null = mine && msg.read_at ? {
      kind: 'info', key: 'read-at', label: `Прочитано в ${formatMoscowDateTime(msg.read_at)}`,
    } : null;

    const editedInfo: MenuItem | null = msg.edited_at ? {
      kind: 'info', key: 'edited-at',
      label: `Изменено в ${formatMoscowTime(msg.edited_at)}`,
    } : null;

    const order = isNativeMobile
      ? (mine
        ? [stopPollItem, readInfo, editedInfo, reply, copy, task, forward, forwardSelf, edit, remove]
        : [reply, copy, task, forward, forwardSelf, remove])
      : (mine
        ? [stopPollItem, reply, edit, copy, task, forward, forwardSelf, remove, select, readInfo, editedInfo]
        : [reply, copy, task, forward, forwardSelf, remove, select]);

    return order.filter((item): item is MenuItem => item !== null);
  };

  const startEdit = (msg: Message) => {
    // Редактирование живёт в поле ввода, а не в самом пузыре: у длинного
    // сообщения строчка внутри пузыря превращалась в щель на пару слов, где
    // текст не помещался и его нельзя было толком просмотреть. Как в Telegram:
    // над полем ввода появляется панель «Редактирование», а сам текст
    // подставляется в обычное поле, которое умеет расти и переносить строки.
    onStartEdit(msg.id, msg.text);
    setMenuFor(null);
  };

  // Спрашивать через window.confirm больше нельзя: у удаления появилась
  // область действия («только у меня» / «у всех»), а её в системном окне не
  // покажешь. Решение принимает диалог в Chat.tsx, сюда возвращается только
  // выбранный вариант.
  const confirmDelete = (id: number) => {
    setMenuFor(null);
    onDeleteMessage(id);
  };

  const copyMessageText = (msg: Message) => {
    setMenuFor(null);
    // В буфер уходит текст с базовыми юникодными эмодзи вместо кодов: вставка
    // `:cat:` в почту или документ выглядела бы как мусор.
    navigator.clipboard?.writeText(toPlainText(msg.text, customEmoji))
      .catch((e) => console.error('Не удалось скопировать:', e));
  };

  const toggleSelected = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  const confirmBulkDelete = () => {
    if (selectedIds.size === 0 || !onDeleteMessages) return;
    onDeleteMessages(Array.from(selectedIds));
    exitSelectMode();
  };

  if (!chatId) {
    return (
      <div className="conv-empty">
        <div className="conv-empty-badge">Выберите чат, чтобы начать переписку</div>
      </div>
    );
  }

  const rows = buildRows(messages);

  return (
    <div className="conv-wrap">
      {selectMode && (
        <div className="select-toolbar">
          <button type="button" className="icon-btn" onClick={exitSelectMode} aria-label="Отмена">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
          <span className="select-toolbar-count">Выбрано: {selectedIds.size}</span>
          {onForward && (
            <button
              type="button"
              className="select-toolbar-forward"
              disabled={selectedIds.size === 0}
              onClick={() => { onForward(Array.from(selectedIds)); exitSelectMode(); }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 17 5-5-5-5" /><path d="M4 18v-2a4 4 0 0 1 4-4h12" /></svg>
              Переслать
            </button>
          )}
          <button type="button" className="select-toolbar-delete" onClick={confirmBulkDelete} disabled={selectedIds.size === 0}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></svg>
            Удалить
          </button>
        </div>
      )}
      <div
        ref={messagesContainerRef}
        className={'conv-body' + (touchSelecting || selectMode ? ' is-touch-selecting' : '') + (initialPositioning ? ' is-initial-positioning' : '')}
        onScroll={handleScroll}
        onWheel={stopInitialPin}
        onTouchStart={stopInitialPin}
        onPointerDown={stopInitialPin}
      >
        {loadingMore && <div className="load-more-hint">Загрузка…</div>}
        {messages.length === 0 && !loadingMore && (
          <div className="conv-empty-inline">
            <div className="conv-empty-badge">Сообщений пока нет</div>
          </div>
        )}

        {rows.map(({ message: msg, startsGroup, endsGroup, daySeparator }) => {
          const mine = msg.sender_id === currentUserId;
          const isEditing = editingId === msg.id;
          // Отмечать можно любое сообщение: своё удаляется как раньше, чужое —
          // как минимум скрывается у себя. Хватит ли прав убрать его у всех,
          // решают диалог удаления и сервер, а не доступность галочки.
          const selectable = true;

          const isSelected = selectedIds.has(msg.id);
          // Картинка без подписи, у которой прозрачность реальная (не просто
          // альфа-канал — см. isOpaque на сервере): прозрачные места должны
          // сливаться с фоном переписки, а не с цветным пузырём сообщения.
          // Пузырь при "снятой" подложке (has-alpha) иначе просвечивал бы
          // сквозь картинку своим акцентным цветом — получалась не чистая
          // прозрачность, а цветная заливка вместо нейтральной.
          const bareTransparentImage = !!msg.file_path && !msg.text && /_a\.webp$/.test(msg.file_path);
          const className = [
            'msg',
            mine ? 'mine' : 'theirs',
            startsGroup ? 'starts-group' : '',
            endsGroup ? 'ends-group' : '',
            selectMode && selectable ? 'is-selectable' : '',
            isSelected ? 'is-selected' : '',
            isEditing ? 'is-editing' : '',
            highlightedId === msg.id ? 'is-highlighted' : '',
            msg.poll ? 'has-poll' : '',
          ].filter(Boolean).join(' ');

          return (
            <React.Fragment key={msg.id}>
              {daySeparator && <div className="date-sep">{daySeparator}</div>}
              <div
                data-msg-id={msg.id}
                className={className}
                onClick={selectMode && selectable ? () => toggleSelected(msg.id) : undefined}
                onContextMenu={!selectMode ? (e) => handleContextMenu(e, msg) : undefined}
                // Жест продолжается и после входа в режим выделения — иначе
                // палец, доехав до второго сообщения, терял бы обработчик.
                onTouchStart={(e) => handleTouchStart(e, msg)}
                onTouchEnd={(e) => handleTouchEnd(e, msg)}
                onTouchCancel={handleTouchCancel}
                onTouchMove={handleTouchMove}
              >
                {selectMode && selectable && (
                  <input type="checkbox" className="msg-select-check" checked={isSelected} readOnly />
                )}
                <div className={'bubble' + (bareTransparentImage ? ' bubble-alpha-only' : '') + (msg.poll ? ' bubble-poll' : '')}>
                    {/* Имя автора — только в общем чате и только над первым
                        сообщением блока: в переписке один на один оно
                        повторяло бы имя из шапки на каждой реплике. */}
                    {!mine && showAuthors && startsGroup && (
                      <div className="bubble-author">{nameFor(msg)}</div>
                    )}
                    {msg.forwarded_from_name && (
                      <div className="bubble-forwarded">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 17 5-5-5-5" /><path d="M4 18v-2a4 4 0 0 1 4-4h12" /></svg>
                        Переслано от {msg.forwarded_from_name}
                      </div>
                    )}
                    {msg.reply_to_id && (
                      <button
                        type="button"
                        className="bubble-reply"
                        onClick={(e) => {
                          e.stopPropagation();
                          // В режиме выбора любая часть сообщения работает на
                          // выбор — уводить к цитате отсюда некуда.
                          if (selectMode) { toggleSelected(msg.id); return; }
                          jumpToMessage(msg.reply_to_id!);
                        }}
                        title="Перейти к сообщению"
                      >
                        <span className="bubble-reply-author">{msg.reply_to_author || 'Сообщение'}</span>
                        <span className="bubble-reply-text">
                          {msg.reply_to_deleted
                            ? 'сообщение удалено'
                            : (renderTextWithEmoji(msg.reply_to_text || '', customEmoji, `r${msg.id}`)
                              || (msg.reply_to_file ? '📷 Фото' : ''))}
                        </span>
                      </button>
                    )}
                    {msg.file_path && (
                      <button
                        type="button"
                        // Суффикс `_a` в имени ставит сервер, когда в картинке
                        // есть прозрачность (см. routes/messages.js).
                        className={'bubble-image' + (/_a\.webp$/.test(msg.file_path) ? ' has-alpha' : '')}
                        style={msg.file_width && msg.file_height ? { aspectRatio: `${msg.file_width} / ${msg.file_height}` } : undefined}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (selectMode) { toggleSelected(msg.id); return; }
                          setLightboxUrl(resolveUploadUrl(msg.file_path));
                        }}
                      >
                        <img src={resolveUploadUrl(msg.file_path) || ''} alt="" />
                      </button>
                    )}
                    {msg.poll && onVotePoll && onAddPollOption && (
                      <PollCard
                        poll={msg.poll}
                        onVote={onVotePoll}
                        onAddOption={onAddPollOption}
                        selectionMode={selectMode}
                      />
                    )}
                    {msg.text && (!msg.poll || !onVotePoll || !onAddPollOption) && (
                      <span className="bubble-text">{renderTextWithEmoji(msg.text, customEmoji, `m${msg.id}`)}</span>
                    )}
                    {/* Время и галочки — внутри пузыря, как в Telegram:
                        обтекаются текстом и не занимают отдельную строку. */}
                    <span className="bubble-meta">
                      {msg.edited_at && <span className="edited-label">изм.</span>}
                      {/* «Просмотрено» — только в каналах-объявлениях, где
                          сервер присылает read_count (см. routes/messages.js).
                          Показываем и на нуле: важно видеть, что объявление
                          пока не прочитал никто. */}
                      {msg.read_count !== undefined && (
                        <span className="bubble-seen" title={`Просмотрели: ${msg.read_count}`}>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z" /><circle cx="12" cy="12" r="3" /></svg>
                          {msg.read_count}
                        </span>
                      )}
                      <span className="bubble-time">{formatMoscowTime(msg.created_at)}</span>
                      {mine && <TickIcon status={msg.status || 'sent'} />}
                    </span>
                </div>

                {/* Реакции — под пузырём, каждая с аватаром поставившего (в
                    спеке именно так, не просто счётчик). Клик открывает
                    детальный список, крестик снимает — он появляется только
                    там, где снимать вправе (своя реакция или своё сообщение). */}
                {!!msg.reactions?.length && (
                  <div className="msg-reactions">
                    {groupReactions(msg.reactions).map(({ emoji, list }) => {
                      const isMine = list.some((r) => r.user.id === currentUserId);
                      return (
                        <span
                          key={emoji}
                          className={'reaction-chip' + (isMine ? ' is-mine' : '')}
                          role="button"
                          tabIndex={0}
                          title={list.map((r) => nameFor(r.user)).join(', ')}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (selectMode) { toggleSelected(msg.id); return; }
                            setReactionsFor(msg.id);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setReactionsFor(msg.id); }
                          }}
                        >
                          {/* Реакции ставятся из фиксированного юникодного
                              набора, но значение приходит от клиента, а сервер
                              ограничивает его только длиной — разбор кодов тут
                              страховка, чтобы `:cat:` не оказался на виду. */}
                          <span className="reaction-chip-emoji">{renderTextWithEmoji(emoji, customEmoji, `rc${msg.id}`)}</span>
                          {/* До трёх — лица внахлёст, дальше их не разобрать, и
                              число читается быстрее любой стопки аватаров. */}
                          {list.length <= REACTION_FACES_MAX ? (
                            <span className="reaction-chip-faces">
                              {list.map((r) => (
                                <Avatar
                                  key={r.user.id}
                                  name={nameFor(r.user)}
                                  avatarPath={r.user.avatar_path}
                                  size="sm"
                                />
                              ))}
                            </span>
                          ) : (
                            <span className="reaction-chip-count">{list.length}</span>
                          )}
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            </React.Fragment>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {showJumpButton && (
        <button type="button" className="jump-to-bottom" onClick={jumpToBottom} aria-label="К последним сообщениям">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14M19 12l-7 7-7-7" />
          </svg>
          {!!unreadCount && unreadCount > 0 && <span className="jump-badge">{unreadCount}</span>}
        </button>
      )}

      {menuFor && (() => {
        const menuMsg = messages.find(m => m.id === menuFor.id);
        if (!menuMsg) return null;
        const menuMine = menuMsg.sender_id === currentUserId;

        return (
          // Ряд реакций — отдельная плашка НАД карточкой меню, а не первая
          // строка внутри неё: так в референсе, и так они не участвуют в
          // прокрутке списка пунктов. Слой существует ради общей позиции —
          // подгонка по краям экрана меряет его целиком (см. useLayoutEffect),
          // иначе плашка вылезала бы за верхний край независимо от карточки.
          <div
            ref={menuRef}
            className="msg-menu-layer"
            style={{ left: menuFor.x, top: menuFor.y }}
          >
            {!!reactionEmoji?.length && onToggleReaction && (
              <div className={'msg-menu-reactions' + (reactionsExpanded ? ' is-expanded' : '')}>
                {(reactionsExpanded ? reactionEmoji : reactionEmoji.slice(0, REACTIONS_IN_ROW)).map((emoji) => {
                  const isCurrent = menuMsg.reactions?.some(
                    (r) => r.user.id === currentUserId && r.emoji === emoji
                  );
                  return (
                    <button
                      key={emoji}
                      type="button"
                      className={'msg-menu-reaction' + (isCurrent ? ' is-active' : '')}
                      onClick={() => { setMenuFor(null); onToggleReaction(menuMsg.id, emoji); }}
                    >
                      {emoji}
                    </button>
                  );
                })}

                {/* Плашка узкая, а набор реакций задаётся в панели и бывает
                    длиннее. Горизонтальная прокрутка тут не годится: колесом
                    мыши её не провернуть, и на ПК ряд выглядел обрезанным.
                    Стрелка разворачивает остальные в несколько рядов. */}
                {reactionEmoji.length > REACTIONS_IN_ROW && (
                  <button
                    type="button"
                    className={'msg-menu-reaction msg-menu-reaction-more' + (reactionsExpanded ? ' is-open' : '')}
                    onClick={() => setReactionsExpanded((v) => !v)}
                    aria-label={reactionsExpanded ? 'Свернуть реакции' : 'Показать все реакции'}
                    title={reactionsExpanded ? 'Свернуть' : 'Показать все'}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </button>
                )}
              </div>
            )}

            {/* Состав и порядок пунктов различаются по платформе и по тому,
                своё сообщение или чужое — см. buildMenuItems. Правка только
                своего (чужой текст переписывать нельзя ни при каких правах),
                удаление на любом: область (у себя/у всех) выбирается в диалоге
                и окончательно решается сервером. */}
            <div className="msg-context-menu">
              {buildMenuItems(menuMsg, menuMine).map((item) => (
                item.kind === 'info' ? (
                  <div key={item.key} className="msg-menu-info">{item.label}</div>
                ) : (
                  <button
                    key={item.key}
                    type="button"
                    className={item.danger ? 'danger' : undefined}
                    onClick={item.onClick}
                  >
                    {item.icon}
                    <span className="msg-menu-label">{item.label}</span>
                  </button>
                )
              ))}
            </div>
          </div>
        );
      })()}

      {lightboxUrl && <ImageLightbox url={lightboxUrl} onClose={() => setLightboxUrl(null)} />}

      {reactionsFor !== null && (() => {
        const msg = messages.find((m) => m.id === reactionsFor);
        if (!msg) return null;
        return (
          <ReactionDetailsModal
            reactions={msg.reactions || []}
            canRemoveOthers={msg.sender_id === currentUserId}
            currentUserId={currentUserId}
            onClose={() => setReactionsFor(null)}
            onRemove={(userId) => onRemoveReaction?.(msg.id, userId)}
          />
        );
      })()}
    </div>
  );
};

export default ChatWindow;
