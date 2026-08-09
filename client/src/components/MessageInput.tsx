import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { App as CapApp } from '@capacitor/app';
import api from '../api/client';
import EmojiPicker from './EmojiPicker';
import EmojiComposerField, { EmojiComposerHandle, PickedCustomEmoji } from './EmojiComposerField';
import { CustomEmojiMap, renderTextWithEmoji, trimDanglingShortcode } from '../utils/customEmoji';
import { isNativeMobile } from '../utils/mobileNotify';
import {
  getLastMobileKeyboardHeight,
  hideMobileKeyboard,
  showMobileKeyboard,
  onKeyboardHide,
  onKeyboardShow,
  onKeyboardWillHide,
  onKeyboardWillShow,
  registerMobileInputSurfaceCloser,
  setChatKeyboardResizeMode,
} from '../utils/mobileKeyboard';

export interface PendingImage {
  file_path: string;
  file_width: number;
  file_height: number;
}

export interface EditingMessage {
  id: number;
  text: string;
}

export interface ReplyingMessage {
  id: number;
  text: string;
  author: string;
  hasImage: boolean;
}

interface MessageInputProps {
  onSend: (text: string, image?: PendingImage) => void;
  onTyping?: () => void;
  disabled?: boolean;
  /** Подпись-подсказка в поле ввода, когда отправка запрещена */
  placeholder?: string;
  /** Правим сообщение — над полем ввода появляется панель, как в Telegram. */
  editing?: EditingMessage | null;
  onSubmitEdit?: (id: number, text: string) => void;
  onCancelEdit?: () => void;
  /** Стрелка вверх в пустом поле — правка последнего своего сообщения. */
  onRequestEditLast?: () => void;
  /** Отвечаем на сообщение — такая же панель над полем, как при правке. */
  replying?: ReplyingMessage | null;
  onCancelReply?: () => void;
  /** Каталог кастомных смайликов — для цитат в панелях правки и ответа. */
  customEmoji?: CustomEmojiMap;
}

// Ограничение совпадает с серверным (MAX_MESSAGE_LENGTH в server/index.js):
// лучше не дать набрать лишнее, чем молча обрезать уже отправленное.
const MAX_LENGTH = 4000;
const MAX_FIELD_HEIGHT = 180;
const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

interface StagedImage {
  /** Свой id: файлы с одинаковым именем нельзя различить по нему самому. */
  id: number;
  previewUrl: string;
  uploading: boolean;
  uploaded: PendingImage | null;
  error: string | null;
}

// Больше десяти за раз не отправляем: пачка уходит отдельными сообщениями, и
// длинная очередь превращает ленту собеседника в стену картинок.
const MAX_IMAGES_PER_SEND = 10;
let stagedSeq = 0;

const MessageInput: React.FC<MessageInputProps> = ({
  onSend, onTyping, disabled, placeholder,
  editing, onSubmitEdit, onCancelEdit, onRequestEditLast,
  replying, onCancelReply, customEmoji = {},
}) => {
  const [text, setText] = useState('');
  const [staged, setStaged] = useState<StagedImage[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [desktopEmojiOpen, setDesktopEmojiOpen] = useState(false);
  const [emojiPanelHeight, setEmojiPanelHeight] = useState(getLastMobileKeyboardHeight);
  const [mobileInputMode, setMobileInputMode] = useState<'closed' | 'keyboard' | 'emoji'>('closed');
  const [mobileEmojiVisible, setMobileEmojiVisibleState] = useState(false);
  const mobileInputModeRef = useRef(mobileInputMode);
  const keyboardHideIntentRef = useRef<'none' | 'to-emoji' | 'close'>('none');
  const keyboardHideIntentUntilRef = useRef(0);
  const emojiVisibilityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  mobileInputModeRef.current = mobileInputMode;
  const setMobileMode = useCallback((mode: 'closed' | 'keyboard' | 'emoji') => {
    const wasActive = mobileInputModeRef.current !== 'closed';
    const willBeActive = mode !== 'closed';
    if (wasActive !== willBeActive) window.dispatchEvent(new Event('miras-composer-will-resize'));
    mobileInputModeRef.current = mode;
    setMobileInputMode(mode);
  }, []);
  const setMobileEmojiVisible = useCallback((visible: boolean, delayMs = 0) => {
    if (emojiVisibilityTimerRef.current !== null) {
      clearTimeout(emojiVisibilityTimerRef.current);
      emojiVisibilityTimerRef.current = null;
    }
    if (!visible && delayMs > 0) {
      emojiVisibilityTimerRef.current = setTimeout(() => {
        emojiVisibilityTimerRef.current = null;
        setMobileEmojiVisibleState(false);
      }, delayMs);
      return;
    }
    setMobileEmojiVisibleState(visible);
  }, []);
  useEffect(() => () => {
    if (emojiVisibilityTimerRef.current !== null) clearTimeout(emojiVisibilityTimerRef.current);
  }, []);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const richRef = useRef<EmojiComposerHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Один и тот же rich-композер на desktop и mobile: только contentEditable
  // способен показывать кастомный смайлик картинкой прямо внутри набираемого
  // текста. Наружу по-прежнему уходит обычный :shortcode:, поэтому серверный
  // формат и история сообщений не меняются.
  const rich = true;

  // Место внизу резервируется, пока активен любой режим ввода — реальная
  // клавиатура или наша панель. Оба делят одну и ту же высоту, поэтому
  // переключение между ними не меняет зарезервированное место вообще.
  const emojiOpen = isNativeMobile ? mobileInputMode === 'emoji' : desktopEmojiOpen;
  const surfaceActive = isNativeMobile && mobileInputMode !== 'closed';

  // Резервируемое место меняется по CSS-transition, а не мгновенно — лента
  // сообщений должна доскроллиться вслед за ним (тем же событием, каким
  // раньше пользовалась старая swap-машина), иначе последнее сообщение
  // на пару кадров окажется под наезжающей поверхностью.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('miras-composer-resize', {
      detail: { active: surfaceActive },
    }));
  }, [surfaceActive, emojiPanelHeight]);

  // Пока открыта переписка — WebView не пересобирается под клавиатуру:
  // экранная клавиатура рисуется поверх уже смонтированной emoji-панели
  // отдельным нативным слоем, а не сдвигает вёрстку. Включаем только на
  // время жизни этого компонента (= пока открыт конкретный чат) — на
  // остальных экранах (логин, диалоги, панели) поля по-прежнему сами
  // уезжают от клавиатуры на штатном ресайзе.
  useEffect(() => {
    if (!isNativeMobile) return undefined;
    setChatKeyboardResizeMode(true);
    // После блокировки/разблокировки Android может восстановить manifest resize mode уже после
    // onResume. Повторяем overlay-команду из JS; нативный плагин дополнительно делает то же сам.
    const listenerPromise = CapApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) setChatKeyboardResizeMode(true);
    });
    const restoreOverlayAfterRotation = () => setChatKeyboardResizeMode(true);
    window.addEventListener('orientationchange', restoreOverlayAfterRotation);
    return () => {
      window.removeEventListener('orientationchange', restoreOverlayAfterRotation);
      listenerPromise.then((handle) => handle.remove()).catch(() => {});
      setChatKeyboardResizeMode(false);
    };
  }, []);

  // Высоту зарезервированного места подтягиваем из последней реальной
  // клавиатуры — тогда emoji-панель занимает ровно то же место, и взгляду
  // не за что зацепиться при переключении между ними.
  useEffect(() => {
    if (!isNativeMobile) return undefined;

    const applyNativeHeight = (height: number) => {
      if (height >= 120) setEmojiPanelHeight(Math.round(height));
    };

    const removeWillShow = onKeyboardWillShow((height) => {
      applyNativeHeight(height);
      // IME разрешено появляться только после явного запроса режима keyboard:
      // тап по закрытому полю либо кнопка клавиатуры из emoji-панели.
      if (mobileInputModeRef.current !== 'keyboard') hideMobileKeyboard();
    });
    const removeDidShow = onKeyboardShow((height) => {
      applyNativeHeight(height);
      // При emoji -> keyboard содержимое остаётся на месте, пока IME его
      // накрывает. После полного подъёма держать его видимым уже незачем.
      if (mobileInputModeRef.current === 'keyboard') setMobileEmojiVisible(false);
    });
    const removeWillHide = onKeyboardWillHide(() => {
      // Если режим уже emoji, это осознанная замена keyboard -> emoji: место
      // и содержимое остаются. Иначе IME уходит по Back — закрываем всю
      // конструкцию в начале нативной анимации, чтобы она уехала вместе с IME.
      if (keyboardHideIntentRef.current === 'to-emoji'
        && Date.now() <= keyboardHideIntentUntilRef.current) return;
      if (keyboardHideIntentRef.current === 'to-emoji') keyboardHideIntentRef.current = 'none';
      if (mobileInputModeRef.current === 'keyboard') {
        keyboardHideIntentRef.current = 'close';
        keyboardHideIntentUntilRef.current = 0;
        // Системный Back скрывает IME, но Android WebView оставляет contentEditable focused.
        // Без blur следующий тап не создаёт onFocus и новая IME считается незапрошенной.
        richRef.current?.blur();
        textareaRef.current?.blur();
        setMobileEmojiVisible(false);
        setMobileMode('closed');
      }
    });
    const removeDidHide = onKeyboardHide(() => {
      // Скрытие по аппаратной кнопке «Назад» закрывает всю общую поверхность.
      // При переходе keyboard -> emoji режим уже успел стать emoji и остаётся.
      const intent = keyboardHideIntentRef.current;
      const isCurrentEmojiTransition = intent === 'to-emoji'
        && Date.now() <= keyboardHideIntentUntilRef.current;
      keyboardHideIntentRef.current = 'none';
      keyboardHideIntentUntilRef.current = 0;
      if (isCurrentEmojiTransition) {
        // Пользователь мог успеть запросить keyboard обратно до завершения старого hide.
        // Запоздалый DidHide не закрывает новый режим, а повторяет запрос IME.
        if (mobileInputModeRef.current === 'keyboard') showMobileKeyboard();
        return;
      }
      if (mobileInputModeRef.current === 'keyboard') {
        richRef.current?.blur();
        textareaRef.current?.blur();
        setMobileMode('closed');
      }
    });

    return () => {
      removeWillShow();
      removeDidShow();
      removeWillHide();
      removeDidHide();
    };
  }, [setMobileEmojiVisible, setMobileMode]);

  useEffect(() => {
    if (!isNativeMobile) return undefined;
    return registerMobileInputSurfaceCloser(() => {
      if (mobileInputModeRef.current === 'closed') return false;
      const wasEmoji = mobileInputModeRef.current === 'emoji';
      keyboardHideIntentRef.current = 'close';
      keyboardHideIntentUntilRef.current = 0;
      setMobileMode('closed');
      // В режиме emoji нет нативной IME, поэтому сама панель уезжает вниз CSS-переходом.
      // Содержимое убираем только после него; pointer-events отключены уже режимом closed.
      setMobileEmojiVisible(false, wasEmoji ? 220 : 0);
      hideMobileKeyboard();
      return true;
    });
  }, [setMobileEmojiVisible, setMobileMode]);

  useEffect(() => {
    if (!disabled) return;
    setDesktopEmojiOpen(false);
    if (mobileInputModeRef.current === 'closed') return;
    keyboardHideIntentRef.current = 'close';
    keyboardHideIntentUntilRef.current = 0;
    setMobileEmojiVisible(false);
    setMobileMode('closed');
    hideMobileKeyboard();
  }, [disabled, setMobileEmojiVisible, setMobileMode]);

  // Поле ввода было однострочным <input>: длинное сообщение уезжало за
  // границу видимой области, а перенести строку было нельзя вовсе. Теперь
  // textarea, которая растёт под текст до разумного предела, а дальше
  // скроллится внутри себя.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_FIELD_HEIGHT)}px`;
  }, [text]);
  // Растущий div считает высоту сам — CSS max-height хватает.

  // Локальный URL превью живёт, пока картинка не отправлена или не убрана —
  // без явного revoke он утёк бы памятью браузера при частой вставке фото.
  useEffect(() => () => { staged.forEach((s) => URL.revokeObjectURL(s.previewUrl)); }, [staged]);

  // Вход в режим правки — подставляем текст и ставим курсор в конец.
  // Ключ по id, а не по самому объекту: иначе перерисовка родителя затирала бы
  // уже поправленный текст исходным.
  const editingId = editing?.id ?? null;
  useEffect(() => {
    if (editingId === null) return;
    const value = editing?.text || '';
    setText(value);
    if (rich) {
      // Коды в правке тоже показываем картинками — иначе человек правил бы
      // текст, который сам никогда не набирал.
      richRef.current?.hydrate(value);
      return;
    }
    const el = textareaRef.current;
    if (el) {
      el.focus();
      requestAnimationFrame(() => el.setSelectionRange(value.length, value.length));
    }
    // editing?.text намеренно не в зависимостях — см. комментарий выше.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);

  const clearField = () => {
    setText('');
    richRef.current?.clear();
  };

  const cancelEdit = () => {
    clearField();
    onCancelEdit?.();
  };

  // Вставка смайлика — в позицию курсора, а не в конец: иначе смайлик,
  // выбранный посреди набранной фразы, уезжал бы в её хвост.
  const insertEmoji = (picked: string | PickedCustomEmoji) => {
    if (rich) {
      richRef.current?.insertPicked(picked, { focus: !(isNativeMobile && emojiOpen) });
      onTyping?.();
      return;
    }
    // В textarea картинку не показать — туда уходит код, как и раньше.
    const emoji = typeof picked === 'string' ? picked : `:${picked.name}:`;
    const el = textareaRef.current;
    setText((prev) => {
      const start = el?.selectionStart ?? prev.length;
      const end = el?.selectionEnd ?? prev.length;
      // Обрезка по длине не должна оставить огрызок кода вида ":cat" — он уже
      // не станет картинкой и будет виден техническим текстом.
      const next = trimDanglingShortcode((prev.slice(0, start) + emoji + prev.slice(end)).slice(0, MAX_LENGTH));
      // Курсор ставим после вставленного, уже после того, как React
      // перерисует значение поля.
      requestAnimationFrame(() => {
        const caret = Math.min(start + emoji.length, next.length);
        if (!(isNativeMobile && emojiOpen)) el?.focus();
        el?.setSelectionRange(caret, caret);
      });
      return next;
    });
    onTyping?.();
  };

  // Синхронно, без кадра задержки: панель никуда не размонтируется, так что
  // ждать перестройки layout под фокус больше незачем — а лишний кадр как
  // раз и открыл бы окно, где ни клавиатура, ни панель ещё не отмечены
  // активными, и зарезервированное место успело бы схлопнуться.
  const focusMobileTextarea = useCallback(() => {
    if (!isNativeMobile) return;
    if (rich) {
      richRef.current?.focus();
      showMobileKeyboard();
      return;
    }
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    const end = el.selectionStart ?? text.length;
    el.setSelectionRange(end, end);
    showMobileKeyboard();
  }, [text.length, rich]);

  const closeEmoji = useCallback((restoreKeyboard = false) => {
    if (!isNativeMobile) {
      setDesktopEmojiOpen(false);
      return;
    }
    if (restoreKeyboard) {
      setMobileEmojiVisible(true);
      setMobileMode('keyboard');
      focusMobileTextarea();
    } else {
      const wasEmoji = mobileInputModeRef.current === 'emoji';
      keyboardHideIntentRef.current = 'close';
      keyboardHideIntentUntilRef.current = 0;
      setMobileMode('closed');
      setMobileEmojiVisible(false, wasEmoji ? 220 : 0);
    }
  }, [focusMobileTextarea, setMobileEmojiVisible, setMobileMode]);

  const toggleEmoji = useCallback(() => {
    if (disabled) return;
    if (!isNativeMobile) {
      setDesktopEmojiOpen((v) => !v);
      return;
    }
    // Панель уже смонтирована и место под неё уже зарезервировано (см.
    // surfaceActive в разметке) — переключение это просто «попросить
    // клавиатуру появиться/уйти», без какой-либо координации с панелью.
    if (mobileInputModeRef.current === 'emoji') {
      setMobileEmojiVisible(true);
      setMobileMode('keyboard');
      focusMobileTextarea();
    } else {
      if (mobileInputModeRef.current === 'keyboard') {
        keyboardHideIntentRef.current = 'to-emoji';
        keyboardHideIntentUntilRef.current = Date.now() + 1000;
      }
      setMobileEmojiVisible(true);
      setMobileMode('emoji');
      hideMobileKeyboard();
    }
  }, [disabled, focusMobileTextarea, setMobileEmojiVisible, setMobileMode]);

  const handleMobileFieldPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (!isNativeMobile) return;
    // Тап по самому полю — такой же явный запрос клавиатуры, как кнопка
    // клавиатуры в emoji-панели. Поверхность уже занимает нужную высоту, поэтому
    // переключаем только режим и оставляем стандартному pointerdown поставить
    // курсор именно туда, куда нажал пользователь.
    if (mobileInputModeRef.current === 'emoji') {
      setMobileEmojiVisible(true);
      setMobileMode('keyboard');
      requestAnimationFrame(() => showMobileKeyboard());
      return;
    }
    if (mobileInputModeRef.current === 'closed' && document.activeElement === e.currentTarget) {
      // Fallback для WebView, который скрыл IME без WillHide/DidHide: поле всё ещё focused,
      // поэтому onFocus повторно не возникнет. В этом единственном случае pointerdown сам
      // является новым явным запросом keyboard; фокус уже закреплён и потеряться не может.
      setMobileEmojiVisible(false);
      setMobileMode('keyboard');
      showMobileKeyboard();
    }
    // В closed ничего не двигаем на pointerdown: иначе поле успевает уехать вверх до pointerup,
    // WebView отменяет click и первый тап не выдаёт редактору фокус. Переход запускает onFocus ниже.
  }, [setMobileEmojiVisible, setMobileMode]);

  const handleMobileFieldFocus = useCallback(() => {
    if (!isNativeMobile) return;
    // contentEditable способен получить фокус от перестановки Selection при
    // вставке первого emoji. Такой фокус не является запросом клавиатуры.
    if (mobileInputModeRef.current === 'closed') {
      // На некоторых Android WebView focus приходит раньше pointerdown.
      // Закрытое поле всегда трактуется как явный запрос клавиатуры.
      setMobileEmojiVisible(false);
      setMobileMode('keyboard');
      // У Android WebView автоматический запрос IME иногда теряется при одновременном изменении
      // геометрии. Нативный show повторяет его после того, как focus уже закреплён за редактором.
      showMobileKeyboard();
      return;
    }
    if (mobileInputModeRef.current === 'emoji') {
      const active = document.activeElement as HTMLElement | null;
      active?.blur();
      hideMobileKeyboard();
    }
  }, [setMobileEmojiVisible, setMobileMode]);

  const uploadImage = async (file: File, id: number) => {
    const form = new FormData();
    form.append('image', file);
    // Обновляем строго по id: пока грузится одна картинка, человек успевает
    // добавить или убрать другие, и позиция в массиве уже не та.
    const patch = (change: Partial<StagedImage>) => {
      setStaged((prev) => prev.map((s) => (s.id === id ? { ...s, ...change } : s)));
    };
    try {
      const { data } = await api.post('/messages/upload-image', form);
      patch({
        uploading: false,
        uploaded: { file_path: data.file_path, file_width: data.file_width, file_height: data.file_height },
      });
    } catch (err: any) {
      patch({ uploading: false, error: err.response?.data?.error || 'Не удалось загрузить' });
    }
  };

  const stageFiles = (files: FileList | File[] | null | undefined) => {
    if (!files || disabled) return;
    const picked = Array.from(files).filter((f) => IMAGE_MIME.includes(f.type));
    if (picked.length === 0) return;

    const next = picked.map((file) => {
      const id = ++stagedSeq;
      const previewUrl = URL.createObjectURL(file);
      uploadImage(file, id);
      return { id, previewUrl, uploading: true, uploaded: null, error: null } as StagedImage;
    });
    setStaged((prev) => [...prev, ...next]);
  };

  const removeStaged = (id: number) => {
    setStaged((prev) => {
      const gone = prev.find((s) => s.id === id);
      if (gone) URL.revokeObjectURL(gone.previewUrl);
      return prev.filter((s) => s.id !== id);
    });
  };

  const submit = () => {
    const trimmed = text.trim();
    if (disabled) return;

    // В режиме правки поле сохраняет сообщение, а не отправляет новое.
    if (editing) {
      if (trimmed) onSubmitEdit?.(editing.id, trimmed);
      clearField();
      onCancelEdit?.();
      return;
    }

    if (staged.some((s) => s.uploading)) return; // ждём, пока догрузятся

    const ready = staged.filter((s) => s.uploaded).map((s) => s.uploaded!);
    if (!trimmed && ready.length === 0) return;

    if (ready.length === 0) {
      onSend(trimmed);
    } else {
      // Каждая картинка уходит своим сообщением; подпись достаётся первому,
      // как в Telegram, — иначе она либо потеряется, либо продублируется под
      // каждой картинкой.
      ready.slice(0, MAX_IMAGES_PER_SEND).forEach((image, i) => {
        onSend(i === 0 ? trimmed : '', image);
      });
    }

    clearField();
    // Всё, что не влезло в лимит, остаётся прикреплённым — человек отправит
    // следующей пачкой, а не обнаружит, что часть картинок молча пропала.
    const sentIds = new Set(
      staged.filter((s) => s.uploaded).slice(0, MAX_IMAGES_PER_SEND).map((s) => s.id),
    );
    setStaged((prev) => {
      prev.forEach((s) => { if (sentIds.has(s.id)) URL.revokeObjectURL(s.previewUrl); });
      return prev.filter((s) => !sentIds.has(s.id));
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submit();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter отправляет, Shift+Enter переносит строку — как в Telegram.
    // isComposing — набор через IME (иероглифы и т.п.): там Enter подтверждает
    // выбор символа, и отправлять по нему сообщение нельзя.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
      return;
    }

    if (e.key === 'Escape' && editing) {
      e.preventDefault();
      cancelEdit();
      return;
    }

    if (e.key === 'Escape' && replying) {
      e.preventDefault();
      onCancelReply?.();
      return;
    }

    // Стрелка вверх в пустом поле — правка последнего своего сообщения, как в
    // Telegram. Только когда поле действительно пустое: иначе она должна
    // двигать курсор по набранному тексту.
    if (e.key === 'ArrowUp' && !editing && !text && onRequestEditLast) {
      e.preventDefault();
      onRequestEditLast();
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value.slice(0, MAX_LENGTH));
    if (onTyping && e.target.value.trim()) {
      onTyping();
    }
  };

  // Rich-поле само себя не ограничивает по длине: перебор — редкий случай, и
  // резать DOM на каждое нажатие ради него незачем. Здесь поле пересобирается
  // целиком из обрезанного текста, чтобы не остался огрызок кода вида ":cat".
  const handleRichChange = (value: string) => {
    if (value.length > MAX_LENGTH) {
      const cut = trimDanglingShortcode(value.slice(0, MAX_LENGTH));
      setText(cut);
      richRef.current?.hydrate(cut);
      return;
    }
    setText(value);
    if (onTyping && value.trim()) onTyping();
  };

  // Вставка изображения из буфера (скриншот, скопированная картинка) — та же
  // механика, что в любом нормальном мессенджере: Ctrl+V прямо в поле ввода,
  // без отдельной кнопки. Текст из буфера вставляется как обычно, браузер
  // делает это сам — сюда попадает только случай с картинкой.
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (IMAGE_MIME.includes(item.type)) {
        e.preventDefault();
        const pasted = item.getAsFile();
        if (pasted) stageFiles([pasted]);
        return;
      }
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLFormElement>) => {
    e.preventDefault();
    setDragActive(false);
    // Бросить можно сразу несколько файлов — берём все.
    stageFiles(e.dataTransfer.files);
  };

  const remaining = MAX_LENGTH - text.length;
  const fieldPlaceholder = placeholder || (disabled ? 'Выберите чат…' : 'Написать сообщение…');

  return (
    <form
      onSubmit={handleSubmit}
      className={'composer' + (dragActive ? ' is-drag-over' : '') + (surfaceActive ? ' has-mobile-input-surface' : '')}
      style={{ '--mobile-emoji-height': `${emojiPanelHeight}px` } as React.CSSProperties}
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragActive(true); }}
      onDragLeave={() => setDragActive(false)}
      onDrop={handleDrop}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="composer-file-input"
        onChange={(e) => { stageFiles(e.target.files); e.target.value = ''; }}
      />

      {emojiOpen && !isNativeMobile && <EmojiPicker onPick={insertEmoji} onClose={() => closeEmoji(false)} />}

      {/* Правка, ответ и приложенная картинка — НАД полосой ввода и во всю её
          ширину, а не внутри: полоса скруглена под одну строку, и вложенная в
          неё панель ломала бы форму. */}
      {editing && (
        <div className="composer-editing">
          <svg className="composer-editing-icon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
          <div className="composer-editing-body">
            <div className="composer-editing-title">Редактирование</div>
            <div className="composer-editing-text">{renderTextWithEmoji(editing.text, customEmoji, `ce${editing.id}`)}</div>
          </div>
          <button type="button" className="composer-editing-cancel" onClick={cancelEdit} aria-label="Отменить редактирование">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
      )}

      {/* Ответ и правка одновременно невозможны: правка занимает поле ввода
          текстом исходного сообщения, отвечать в этот момент нечем. */}
      {!editing && replying && (
        <div className="composer-editing composer-replying">
          <svg className="composer-editing-icon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 17-5-5 5-5" /><path d="M20 18v-2a4 4 0 0 0-4-4H4" /></svg>
          <div className="composer-editing-body">
            <div className="composer-editing-title">Ответ · {replying.author}</div>
            <div className="composer-editing-text">
              {replying.text
                ? renderTextWithEmoji(replying.text, customEmoji, `cr${replying.id}`)
                : (replying.hasImage ? '📷 Фото' : '')}
            </div>
          </div>
          <button type="button" className="composer-editing-cancel" onClick={() => onCancelReply?.()} aria-label="Отменить ответ">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
      )}

      {staged.length > 0 && (
        <div className="composer-attachment">
          {staged.map((item, i) => (
            <div
              key={item.id}
              className={'composer-attachment-preview' + (i >= MAX_IMAGES_PER_SEND ? ' is-overflow' : '')}
              title={item.error || (i >= MAX_IMAGES_PER_SEND ? 'Уйдёт следующей отправкой' : undefined)}
            >
              <img src={item.previewUrl} alt="" />
              {item.uploading && <span className="composer-attachment-spinner" aria-hidden="true" />}
              <button
                type="button"
                className="composer-attachment-remove"
                onClick={() => removeStaged(item.id)}
                aria-label="Убрать изображение"
              >×</button>
            </div>
          ))}
          {staged.some((s) => s.error) && (
            <span className="composer-attachment-error">Часть изображений не загрузилась</span>
          )}
          {staged.length > MAX_IMAGES_PER_SEND && (
            <span className="composer-attachment-error">
              За раз уйдёт {MAX_IMAGES_PER_SEND}, остальные останутся прикреплёнными
            </span>
          )}
        </div>
      )}

      <div className="composer-row">
      <div className="composer-bar">
      <button
        type="button"
        className={'emoji-btn' + (emojiOpen ? ' is-active' : '')}
        // pointerdown вместо click и с preventDefault: панель закрывается по
        // mousedown снаружи себя, и на обычном клике она успела бы закрыться
        // раньше, чем сюда дойдёт onClick, — кнопка не работала бы вовсе.
        onPointerDown={(e) => {
          // Снимаем Range до blur/скрытия IME: Android при потере фокуса переставляет DOM Selection
          // в начало contentEditable, хотя визуальный курсор до этого находился в другом месте.
          richRef.current?.saveSelection();
          e.preventDefault();
          e.stopPropagation();
          toggleEmoji();
        }}
        disabled={disabled}
        aria-label={isNativeMobile && emojiOpen ? 'Клавиатура' : 'Смайлики'}
        title={isNativeMobile && emojiOpen ? 'Клавиатура' : 'Смайлики'}
      >
        {isNativeMobile && emojiOpen ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path d="M7 9h.01M10.5 9h.01M14 9h.01M17.5 9h.01M7 12.5h.01M10.5 12.5h.01M14 12.5h.01M17.5 12.5h.01M8 16h8" strokeLinecap="round" strokeWidth="2" />
          </svg>
        ) : (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
            <circle cx="12" cy="12" r="9" /><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" />
            <path d="M9 9.5h.01M15 9.5h.01" strokeWidth="2.6" strokeLinecap="round" />
          </svg>
        )}
      </button>

        <div className="composer-field">
          {rich ? (
            <EmojiComposerField
              ref={richRef}
              customEmoji={customEmoji}
              placeholder={fieldPlaceholder}
              disabled={disabled}
              onChangeText={handleRichChange}
              onSubmit={submit}
              onEscape={editing ? cancelEdit : (replying ? onCancelReply : undefined)}
              onArrowUpEmpty={!editing ? onRequestEditLast : undefined}
              onPasteImageFile={(file) => stageFiles([file])}
              onPointerDown={handleMobileFieldPointerDown}
              onFocus={handleMobileFieldFocus}
            />
          ) : (
            <textarea
              ref={textareaRef}
              rows={1}
              value={text}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onPointerDown={handleMobileFieldPointerDown}
              onFocus={handleMobileFieldFocus}
              placeholder={fieldPlaceholder}
              disabled={disabled}
            />
          )}
          {remaining < 200 && <span className="composer-counter">{remaining}</span>}
        </div>

        {/* В режиме правки картинку не прикрепить: сервер меняет только текст. */}
        {!editing && (
          <button
            type="button"
            className="attach-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            aria-label="Прикрепить изображение"
            title="Прикрепить изображение"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></svg>
          </button>
        )}
      </div>

      <button
        type="submit"
        className="send-btn"
        disabled={disabled || (editing
          ? !text.trim()
          : (!text.trim() && !staged.some((s) => s.uploaded)) || staged.some((s) => s.uploading))}
        aria-label={editing ? 'Сохранить' : 'Отправить'}
      >
        {editing ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 6 9 17l-5-5" /></svg>
        ) : (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M3.4 20.6 22 12 3.4 3.4 3 10l13 2-13 2z" /></svg>
        )}
      </button>
      </div>

      {isNativeMobile && (
        // Смонтирована всегда, пока открыта переписка — место под неё уже
        // зарезервировано (surfaceActive), а системная клавиатура при показе
        // просто рисуется поверх неё отдельным нативным слоем. Переключение
        // клавиатура↔панель поэтому не требует ни монтирования, ни пересборки
        // вёрстки — только сама поверхность целиком появляется/пропадает.
        <div
          className={'mobile-emoji-surface' + (surfaceActive ? ' is-surface-active' : '') + (mobileEmojiVisible ? ' is-emoji-visible' : '') + (emojiOpen ? ' is-emoji-mode' : '')}
        >
          <EmojiPicker onPick={insertEmoji} onClose={() => closeEmoji(false)} mobilePanel />
        </div>
      )}
    </form>
  );
};

export default MessageInput;
