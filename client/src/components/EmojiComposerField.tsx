import React, { forwardRef, useCallback, useImperativeHandle, useRef } from 'react';
import {
  CustomEmojiMap, createEmojiNode, domToText, isEmojiNode, textToFragment,
} from '../utils/customEmoji';

/** Картиночный смайлик, выбранный в панели: данные уже есть, искать нечего. */
export interface PickedCustomEmoji {
  name: string;
  filePath: string;
  fallback: string;
}

export interface EmojiComposerHandle {
  getText: () => string;
  hydrate: (text: string) => void;
  clear: () => void;
  focus: () => void;
  insertPicked: (value: string | PickedCustomEmoji, options?: { focus?: boolean }) => void;
}

interface Props {
  customEmoji: CustomEmojiMap;
  placeholder: string;
  disabled?: boolean;
  onChangeText: (text: string) => void;
  onSubmit: () => void;
  onEscape?: () => void;
  /** Стрелка вверх в пустом поле — правка последнего своего сообщения. */
  onArrowUpEmpty?: () => void;
  onPasteImageFile?: (file: File) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

// Код, только что дописанный перед курсором. В отличие от общего SHORTCODE
// якорится на конец строки: превращаем в картинку ровно то, что человек сейчас
// набрал, а не первый попавшийся код где-то раньше в тексте.
const TYPED_SHORTCODE = /:([a-z0-9_]{2,32}):$/;

const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/**
 * Поле ввода, в котором кастомный смайлик виден картинкой, а не кодом :name:.
 *
 * Почему contentEditable, а не <textarea>: в textarea нельзя показать картинку
 * посреди текста в принципе — там только символы. При этом наружу поле отдаёт
 * ровно тот же текст с кодами, что и раньше: формат хранения переписки не
 * меняется, сервер и БД о существовании этого поля не знают.
 *
 * Содержимое НЕ рисуется React'ом (нет ни value, ни dangerouslySetInnerHTML):
 * перерисовка на каждое нажатие сбрасывала бы курсор в начало. React владеет
 * только самим пустым контейнером, наполнение — императивное.
 */
const EmojiComposerField = forwardRef<EmojiComposerHandle, Props>(({
  customEmoji, placeholder, disabled,
  onChangeText, onSubmit, onEscape, onArrowUpEmpty, onPasteImageFile, onFocus, onBlur,
}, ref) => {
  const boxRef = useRef<HTMLDivElement>(null);
  // Свежая карта нужна обработчикам, которые читают её в момент нажатия.
  const mapRef = useRef(customEmoji);
  mapRef.current = customEmoji;

  const emitChange = useCallback(() => {
    const box = boxRef.current;
    if (box) onChangeText(domToText(box));
  }, [onChangeText]);

  /** Курсор схлопывается сразу за узлом. */
  const caretAfter = (node: Node) => {
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  };

  const insertNode = useCallback((node: Node, focusAfter = true) => {
    const box = boxRef.current;
    if (!box) return;
    const selection = window.getSelection();
    // Курсор мог остаться в другом месте страницы (клик по панели смайликов) —
    // тогда вставляем в конец, а не в чужой узел.
    const inside = selection && selection.rangeCount > 0
      && box.contains(selection.getRangeAt(0).commonAncestorContainer);

    const last = node.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? node.lastChild : node;
    if (inside) {
      const range = selection!.getRangeAt(0);
      range.deleteContents();
      range.insertNode(node);
    } else {
      box.appendChild(node);
    }
    if (last) caretAfter(last);
    if (focusAfter) box.focus();
    emitChange();
  }, [emitChange]);

  useImperativeHandle(ref, () => ({
    getText: () => (boxRef.current ? domToText(boxRef.current) : ''),
    hydrate: (text: string) => {
      const box = boxRef.current;
      if (!box) return;
      box.textContent = '';
      box.appendChild(textToFragment(text, mapRef.current));
      box.focus();
      if (box.lastChild) caretAfter(box.lastChild);
      emitChange();
    },
    clear: () => {
      const box = boxRef.current;
      if (!box) return;
      box.textContent = '';
      emitChange();
    },
    focus: () => {
      const box = boxRef.current;
      if (!box) return;
      box.focus();
      const selection = window.getSelection();
      const inside = selection && selection.rangeCount > 0
        && box.contains(selection.getRangeAt(0).commonAncestorContainer);
      if (!inside && box.lastChild) caretAfter(box.lastChild);
    },
    insertPicked: (value, options) => {
      const focusAfter = options?.focus !== false;
      if (typeof value === 'string') {
        insertNode(document.createTextNode(value), focusAfter);
        return;
      }
      insertNode(createEmojiNode(value.name, value.filePath, value.fallback), focusAfter);
    },
  }), [emitChange, insertNode]);

  // Живая замена кода картинкой: как только дописано закрывающее двоеточие и
  // имя известно — текст исчезает, на его месте узел смайлика. Человек не
  // должен видеть технический вид кода вообще.
  const convertTypedShortcode = () => {
    const selection = window.getSelection();
    if (!selection || !selection.isCollapsed || selection.rangeCount === 0) return;

    const node = selection.anchorNode;
    if (!node || node.nodeType !== Node.TEXT_NODE) return;
    const box = boxRef.current;
    if (!box || !box.contains(node)) return;

    const offset = selection.anchorOffset;
    const match = TYPED_SHORTCODE.exec((node as Text).data.slice(0, offset));
    if (!match) return;

    const item = mapRef.current[match[1]];
    if (!item) return; // неизвестный код остаётся текстом — как и везде

    const range = document.createRange();
    range.setStart(node, offset - match[0].length);
    range.setEnd(node, offset);
    range.deleteContents();

    const emoji = createEmojiNode(match[1], item.filePath, item.fallback);
    range.insertNode(emoji);
    caretAfter(emoji);
  };

  const handleInput = (e: React.FormEvent<HTMLDivElement>) => {
    // Во время набора через IME (иероглифы) трогать содержимое нельзя —
    // это сорвало бы незавершённый ввод.
    if (!(e.nativeEvent as InputEvent).isComposing) convertTypedShortcode();
    emitChange();
  };

  // Соседний с курсором смайлик, если курсор к нему вплотную. Пустые текстовые
  // узлы браузер оставляет после правок сам — их проскакиваем.
  const adjacentEmoji = (forward: boolean): HTMLElement | null => {
    const selection = window.getSelection();
    if (!selection || !selection.isCollapsed || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    const node = range.startContainer;
    const offset = range.startOffset;

    let probe: Node | null = null;
    if (node.nodeType === Node.TEXT_NODE) {
      const data = (node as Text).data;
      if (forward ? offset < data.length : offset > 0) return null;
      probe = forward ? node.nextSibling : node.previousSibling;
    } else {
      probe = forward ? node.childNodes[offset] : node.childNodes[offset - 1];
    }

    while (probe && probe.nodeType === Node.TEXT_NODE && !(probe as Text).data) {
      probe = forward ? probe.nextSibling : probe.previousSibling;
    }
    return isEmojiNode(probe) ? probe : null;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onSubmit();
      return;
    }

    // Перенос строки вставляем сами литеральным '\n' (контейнер с
    // white-space: pre-wrap покажет его переносом). Дать это браузеру нельзя:
    // он наплодит <div>/<br>, и обратная сборка текста усложнится на ровном месте.
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      insertNode(document.createTextNode('\n'));
      return;
    }

    if (e.key === 'Escape' && onEscape) {
      e.preventDefault();
      onEscape();
      return;
    }

    // Смайлик удаляется целиком одним нажатием. Браузеры и сами так умеют с
    // contenteditable=false, но не все и не всегда — а обещание «одно нажатие»
    // должно выполняться везде.
    if (e.key === 'Backspace' || e.key === 'Delete') {
      const victim = adjacentEmoji(e.key === 'Delete');
      if (victim) {
        e.preventDefault();
        const anchor = e.key === 'Delete' ? victim.previousSibling : null;
        victim.remove();
        if (anchor) caretAfter(anchor);
        emitChange();
      }
      return;
    }

    if (e.key === 'ArrowUp' && onArrowUpEmpty && !domToText(boxRef.current!)) {
      e.preventDefault();
      onArrowUpEmpty();
    }
  };

  // Вставка всегда обезличенная: что бы ни лежало в буфере (кусок страницы,
  // текст из Word), в поле попадает только простой текст. Иначе contentEditable
  // потащит внутрь чужую разметку со стилями и скриптами.
  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const items = e.clipboardData?.items;
    if (items && onPasteImageFile) {
      for (let i = 0; i < items.length; i += 1) {
        if (IMAGE_MIME.includes(items[i].type)) {
          e.preventDefault();
          const file = items[i].getAsFile();
          if (file) onPasteImageFile(file);
          return;
        }
      }
    }

    e.preventDefault();
    const plain = e.clipboardData?.getData('text/plain') || '';
    // Через тот же разбор, что и правка сообщения: код в буфере тоже должен
    // приехать картинкой, а не текстом.
    if (plain) insertNode(textToFragment(plain, mapRef.current));
  };

  return (
    <div
      ref={boxRef}
      className="composer-input"
      contentEditable={!disabled}
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label={placeholder}
      data-placeholder={placeholder}
      onInput={handleInput}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      onFocus={onFocus}
      onBlur={onBlur}
      // Перетаскивание файла обрабатывает форма целиком (composer), а сюда drop
      // приводил бы к вставке чужой разметки мимо onPaste.
      onDrop={(e) => e.preventDefault()}
    />
  );
});

export default EmojiComposerField;
