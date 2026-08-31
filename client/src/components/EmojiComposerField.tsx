import React, { forwardRef, useCallback, useImperativeHandle, useRef } from 'react';
import {
  CustomEmojiMap, createEmojiNode, domToText, isEmojiNode, textToFragment,
} from '../utils/customEmoji';

/** Картиночный смайлик, выбранный в панели: данные уже есть, искать нечего. */
export interface PickedCustomEmoji {
  name: string;
  filePath: string;
  fallback: string;
  /** Что реально хранится в сообщении: Unicode для системных наборов. */
  token?: string;
}

export interface EmojiComposerHandle {
  getText: () => string;
  hydrate: (text: string) => void;
  clear: () => void;
  focus: () => void;
  blur: () => void;
  saveSelection: () => void;
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
  onPointerDown?: (event: React.PointerEvent<HTMLElement>) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

interface SavedDomSelection {
  startContainer: Node;
  startOffset: number;
  endContainer: Node;
  endOffset: number;
}

function snapshotRange(range: Range): SavedDomSelection {
  return {
    startContainer: range.startContainer,
    startOffset: range.startOffset,
    endContainer: range.endContainer,
    endOffset: range.endOffset,
  };
}

function restoreRange(box: HTMLDivElement, saved: SavedDomSelection | null): Range | null {
  if (!saved || !box.contains(saved.startContainer) || !box.contains(saved.endContainer)) return null;
  try {
    const range = document.createRange();
    range.setStart(saved.startContainer, saved.startOffset);
    range.setEnd(saved.endContainer, saved.endOffset);
    return range;
  } catch {
    // DOM мог измениться внешней гидратацией/очисткой — не вставляем по устаревшей позиции.
    return null;
  }
}

// Код, только что дописанный перед курсором. В отличие от общего SHORTCODE
// якорится на конец строки: превращаем в картинку ровно то, что человек сейчас
// набрал, а не первый попавшийся код где-то раньше в тексте.
const TYPED_SHORTCODE = /:([a-z0-9_]{2,128}):$/;

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
  onChangeText, onSubmit, onEscape, onArrowUpEmpty, onPasteImageFile, onPointerDown, onFocus, onBlur,
}, ref) => {
  const boxRef = useRef<HTMLDivElement>(null);
  // Нельзя хранить сам Range: это «живой» объект, и браузер сдвигает его границы при insertNode.
  // Храним неизменяемый снимок узлов/offset — иначе несколько emoji вставляются в обратном порядке.
  const savedRangeRef = useRef<SavedDomSelection | null>(null);
  // Свежая карта нужна обработчикам, которые читают её в момент нажатия.
  const mapRef = useRef(customEmoji);
  mapRef.current = customEmoji;

  const emitChange = useCallback(() => {
    const box = boxRef.current;
    if (box) onChangeText(domToText(box));
  }, [onChangeText]);

  const saveSelection = useCallback(() => {
    const box = boxRef.current;
    const selection = window.getSelection();
    if (!box || !selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (box.contains(range.commonAncestorContainer)) savedRangeRef.current = snapshotRange(range);
  }, []);

  /** Запоминает курсор сразу за узлом; применять Selection необязательно. */
  const caretAfter = useCallback((node: Node, expose = true) => {
    const range = document.createRange();
    range.setStartAfter(node);
    range.collapse(true);
    savedRangeRef.current = snapshotRange(range);
    if (!expose) return;
    const selection = window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(range);
  }, []);

  const insertNode = useCallback((node: Node, focusAfter = true) => {
    const box = boxRef.current;
    if (!box) return;
    const selection = window.getSelection();
    // Курсор мог остаться в другом месте страницы (клик по панели смайликов) —
    // тогда вставляем в конец, а не в чужой узел.
    // После blur Android WebView часто оставляет Selection внутри contentEditable, но переносит
    // его в начало. Такой Selection уже не является живым курсором: в emoji-режиме используем
    // явно сохранённый Range, снятый до потери фокуса.
    const inside = document.activeElement === box && selection && selection.rangeCount > 0
      && box.contains(selection.getRangeAt(0).commonAncestorContainer);
    const saved = restoreRange(box, savedRangeRef.current);
    const insertionRange = inside
      ? selection!.getRangeAt(0).cloneRange()
      : saved;

    const last = node.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? node.lastChild : node;
    if (insertionRange) {
      insertionRange.deleteContents();
      insertionRange.insertNode(node);
    } else {
      box.appendChild(node);
    }
    if (focusAfter) box.focus();
    if (last) caretAfter(last, focusAfter);
    emitChange();
  }, [caretAfter, emitChange]);

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
      savedRangeRef.current = null;
      emitChange();
    },
    focus: () => {
      const box = boxRef.current;
      if (!box) return;
      box.focus();
      const saved = restoreRange(box, savedRangeRef.current);
      if (saved) {
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(saved);
        return;
      }
      const selection = window.getSelection();
      const inside = selection && selection.rangeCount > 0
        && box.contains(selection.getRangeAt(0).commonAncestorContainer);
      if (!inside && box.lastChild) caretAfter(box.lastChild);
    },
    blur: () => boxRef.current?.blur(),
    saveSelection,
    insertPicked: (value, options) => {
      const focusAfter = options?.focus !== false;
      if (typeof value === 'string') {
        insertNode(document.createTextNode(value), focusAfter);
        return;
      }
      insertNode(createEmojiNode(value.name, value.filePath, value.fallback, value.token), focusAfter);
    },
  }), [caretAfter, emitChange, insertNode, saveSelection]);

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
    saveSelection();
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
      onKeyUp={saveSelection}
      onPaste={handlePaste}
      onPointerDown={onPointerDown}
      onPointerUp={saveSelection}
      onFocus={onFocus}
      onBlur={() => {
        saveSelection();
        onBlur?.();
      }}
      // Перетаскивание файла обрабатывает форма целиком (composer), а сюда drop
      // приводил бы к вставке чужой разметки мимо onPaste.
      onDrop={(e) => e.preventDefault()}
    />
  );
});

export default EmojiComposerField;
