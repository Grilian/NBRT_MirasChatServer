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
