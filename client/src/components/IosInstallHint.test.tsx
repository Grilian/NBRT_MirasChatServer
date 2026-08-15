import React from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import IosInstallHint from './IosInstallHint';

// Подсказку видит только тот, кому она адресована: iPhone в Safari, ещё не
// открывший приложение с рабочего стола. Проверяем именно отбор — показать её
// лишним людям хуже, чем не показать вовсе.

const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME = `${IPHONE_SAFARI.replace('Safari/604.1', 'CriOS/126.0 Mobile/15E148 Safari/604.1')}`;
const WINDOWS_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const setUserAgent = (value: string) => {
  Object.defineProperty(window.navigator, 'userAgent', { value, configurable: true });
};

const setStandalone = (value: boolean) => {
  Object.defineProperty(window.navigator, 'standalone', { value, configurable: true });
};

beforeEach(() => {
  window.localStorage.clear();
  setStandalone(false);
});

test('на iPhone в Safari объясняет, как поставить ярлык', () => {
  setUserAgent(IPHONE_SAFARI);
  render(<IosInstallHint />);
  expect(screen.getByText(/На экран «Домой»/)).toBeInTheDocument();
});

test('в других браузерах на iOS не показывается — там этого пункта нет в меню', () => {
  setUserAgent(IPHONE_CHROME);
  const { container } = render(<IosInstallHint />);
  expect(container).toBeEmptyDOMElement();
});

test('на настольном браузере не показывается', () => {
  setUserAgent(WINDOWS_CHROME);
  const { container } = render(<IosInstallHint />);
  expect(container).toBeEmptyDOMElement();
});

test('уже открыто с рабочего стола — подсказывать нечего', () => {
  setUserAgent(IPHONE_SAFARI);
  setStandalone(true);
  const { container } = render(<IosInstallHint />);
  expect(container).toBeEmptyDOMElement();
});

test('закрытая подсказка больше не возвращается', () => {
  setUserAgent(IPHONE_SAFARI);
  const first = render(<IosInstallHint />);
  fireEvent.click(screen.getByRole('button', { name: 'Больше не показывать' }));
  expect(first.container).toBeEmptyDOMElement();

  first.unmount();
  const second = render(<IosInstallHint />);
  expect(second.container).toBeEmptyDOMElement();
});
