// Общая подготовка тестового окружения. Подключается один раз через
// `test.setupFiles` в vite.config.ts — до этого каждый из тридцати трёх
// тестовых файлов импортировал jest-dom сам, и забыть строку в новом файле
// значило получить непонятную ошибку про отсутствующий матчер.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom один на файл, а тестов в файле много: без размонтирования предыдущее
// дерево остаётся в документе, и `getByText` находит узел из прошлого теста.
afterEach(() => {
  cleanup();
});

// jsdom не реализует matchMedia вовсе, а приложение спрашивает его при
// ЗАГРУЗКЕ модулей (utils/autoFocus вычисляет AUTOFOCUS_ON_OPEN на верхнем
// уровне). Без заглушки падает не тест, а сам импорт — и понять по ошибке,
// что дело в среде, а не в коде, довольно трудно. Тесты, которым нужен другой
// ответ, переопределяют matchMedia у себя, как и раньше.
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// Тот же случай: ResizeObserver нет в jsdom, а лента доскручивается по нему.
if (!('ResizeObserver' in window)) {
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
