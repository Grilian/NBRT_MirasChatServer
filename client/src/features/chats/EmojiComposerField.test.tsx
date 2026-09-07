import React, { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import EmojiComposerField, { EmojiComposerHandle } from './EmojiComposerField';

function renderComposer() {
  const ref = createRef<EmojiComposerHandle>();
  render(
    <>
      <EmojiComposerField
        ref={ref}
        customEmoji={{}}
        placeholder="message"
        onChangeText={() => {}}
        onSubmit={() => {}}
      />
      <button type="button">outside</button>
    </>,
  );
  return { ref, box: screen.getByRole('textbox') as HTMLDivElement };
}

test('inserts panel emoji at the saved caret after the editor loses focus', () => {
  const { ref, box } = renderComposer();
  box.textContent = 'abcd';
  box.focus();

  const range = document.createRange();
  range.setStart(box.firstChild!, 2);
  range.collapse(true);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  ref.current!.saveSelection();

  screen.getByRole('button').focus();
  const staleStart = document.createRange();
  staleStart.setStart(box.firstChild!, 0);
  staleStart.collapse(true);
  selection.removeAllRanges();
  selection.addRange(staleStart);

  ref.current!.insertPicked('🙂', { focus: false });
  expect(box.textContent).toBe('ab🙂cd');

  ref.current!.insertPicked('👍', { focus: false });
  expect(box.textContent).toBe('ab🙂👍cd');
});

test('replaces a selected fragment and keeps the next insertion after the emoji', () => {
  const { ref, box } = renderComposer();
  box.textContent = 'abcd';
  box.focus();

  const range = document.createRange();
  range.setStart(box.firstChild!, 1);
  range.setEnd(box.firstChild!, 3);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  ref.current!.saveSelection();
  screen.getByRole('button').focus();

  ref.current!.insertPicked('🙂', { focus: false });
  ref.current!.insertPicked('👍', { focus: false });
  expect(box.textContent).toBe('a🙂👍d');
});

test('imperative blur releases focus after Android hides the keyboard', () => {
  const { ref, box } = renderComposer();
  box.focus();
  expect(document.activeElement).toBe(box);

  ref.current!.blur();
  expect(document.activeElement).not.toBe(box);
});

// insertPicked теперь возвращает вставленный узел — без него попапу выбора
// пака (MessageInput.tsx) нечего было бы подменять и не над чем всплывать.
test('insertPicked returns the inserted image node, or null for a plain text insertion', () => {
  const { ref, box } = renderComposer();
  box.focus();

  const textNode = ref.current!.insertPicked('🙂', { focus: false });
  expect(textNode).toBeNull();

  const imageNode = ref.current!.insertPicked(
    { name: 'u_1f973', filePath: '/uploads/emoji/apple_1f973.webp', fallback: '🥳' },
    { focus: false },
  );
  expect(imageNode).not.toBeNull();
  expect(imageNode).toBeInstanceOf(HTMLImageElement);
  expect(box.contains(imageNode)).toBe(true);
});

// applyVariant меняет уже вставленную картинку на другое оформление того же
// смайлика — курсор и остальной текст не трогаются, код в тексте обновляется.
test('applyVariant swaps the image and code of an already-inserted node in place', () => {
  const { ref, box } = renderComposer();
  box.focus();

  const node = ref.current!.insertPicked(
    { name: 'u_1f973', filePath: '/uploads/emoji/apple_1f973.webp', fallback: '🥳', token: ':apple_variant:' },
    { focus: false },
  )!;
  expect(ref.current!.getText()).toBe(':apple_variant:');

  ref.current!.applyVariant(node, '/uploads/emoji/google_1f973.webp', ':e~1f973~google-fonts:');

  expect((node as HTMLImageElement).src).toContain('google_1f973.webp');
  expect(ref.current!.getText()).toBe(':e~1f973~google-fonts:');
});

test('applyVariant on a node from outside this field is a no-op', () => {
  const { ref } = renderComposer();
  const foreign = document.createElement('img');
  ref.current!.applyVariant(foreign, '/uploads/emoji/google_1f973.webp', ':e~1f973~google-fonts:');
  expect(foreign.src).toBe('');
});
