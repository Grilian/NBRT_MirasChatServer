import { dismissLayerWithoutUnderlayActivation } from './dismissLayer';

test('dismisses a layer without activating the element underneath', () => {
  const button = document.createElement('button');
  const activated = vi.fn();
  const dismissed = vi.fn();
  button.addEventListener('click', activated);
  document.body.appendChild(button);

  const pointerDown = new Event('pointerdown', { bubbles: true, cancelable: true });
  button.addEventListener('pointerdown', (event) => {
    dismissLayerWithoutUnderlayActivation(event, dismissed);
  }, { once: true });

  button.dispatchEvent(pointerDown);
  button.click();

  expect(dismissed).toHaveBeenCalledTimes(1);
  expect(activated).not.toHaveBeenCalled();
  button.remove();
});

test('swallows the Android pointer/touch/mouse tail of the dismissed gesture', () => {
  const target = document.createElement('button');
  const touchStarted = vi.fn();
  const touchEnded = vi.fn();
  const activated = vi.fn();
  const dismissed = vi.fn();
  target.addEventListener('touchstart', touchStarted);
  target.addEventListener('touchend', touchEnded);
  target.addEventListener('click', activated);
  target.addEventListener('pointerdown', (event) => {
    dismissLayerWithoutUnderlayActivation(event, dismissed);
  }, { once: true });
  document.body.appendChild(target);

  target.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
  target.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
  target.dispatchEvent(new Event('pointerup', { bubbles: true, cancelable: true }));
  target.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
  target.dispatchEvent(new Event('mousedown', { bubbles: true, cancelable: true }));
  target.dispatchEvent(new Event('mouseup', { bubbles: true, cancelable: true }));
  target.click();

  expect(dismissed).toHaveBeenCalledTimes(1);
  expect(touchStarted).not.toHaveBeenCalled();
  expect(touchEnded).not.toHaveBeenCalled();
  expect(activated).not.toHaveBeenCalled();
  target.remove();
});

test('does not swallow the next tap when Android omits the synthetic click', () => {
  vi.useFakeTimers();
  const closingTarget = document.createElement('button');
  const nextTarget = document.createElement('button');
  const dismissed = vi.fn();
  const nextTouchStarted = vi.fn();
  closingTarget.addEventListener('pointerdown', (event) => {
    dismissLayerWithoutUnderlayActivation(event, dismissed);
  }, { once: true });
  nextTarget.addEventListener('touchstart', nextTouchStarted);
  document.body.append(closingTarget, nextTarget);

  closingTarget.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
  closingTarget.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
  closingTarget.dispatchEvent(new Event('pointerup', { bubbles: true, cancelable: true }));
  closingTarget.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
  // click намеренно отсутствует — именно так воспроизводится WebView-баг.
  vi.advanceTimersByTime(40);

  nextTarget.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));

  expect(dismissed).toHaveBeenCalledTimes(1);
  expect(nextTouchStarted).toHaveBeenCalledTimes(1);
  closingTarget.remove();
  nextTarget.remove();
  vi.useRealTimers();
});
