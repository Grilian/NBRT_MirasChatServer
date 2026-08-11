import { dismissLayerWithoutUnderlayActivation } from './dismissLayer';

test('dismisses a layer without activating the element underneath', () => {
  const button = document.createElement('button');
  const activated = jest.fn();
  const dismissed = jest.fn();
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
