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
