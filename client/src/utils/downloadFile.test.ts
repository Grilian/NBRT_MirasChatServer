// Скачивание в трёх средах. Проверяем именно РАЗВИЛКУ и то, что отказ
// возвращается текстом: молчащая кнопка на Android («нажимаю на файл — ничего
// не происходит») и была настоящей жалобой.

// Модуль догружается через `await import` ПОСЛЕ объявления моков: плагин
// регистрируется в момент импорта, и обычный import наверху файла успел бы
// схватить настоящий @capacitor/core. Пустой export делает файл модулем.
export {};

// Имя обязано начинаться с mock — иначе vitest не пускает переменную внутрь
// фабрики vi.mock (защита от неинициализированных моков).
const mockDownload = vi.fn();

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => ({ download: (...args: unknown[]) => mockDownload(...args) }),
}));

const mockState = { nativeMobile: false };
vi.mock('./mobileNotify', () => ({
  get isNativeMobile() { return mockState.nativeMobile; },
}));

// Модуль читает isNativeMobile при вызове, но плагин регистрирует при импорте,
// поэтому импортируем после моков.
const { downloadFile, safeDownloadName } = await import('./downloadFile');

beforeEach(() => {
  mockDownload.mockReset();
  mockState.nativeMobile = false;
  delete (window as any).electronAPI;
});

test('имя файла чистится от разделителей пути и управляющих символов', () => {
  expect(safeDownloadName('папка/смета.pdf')).toBe('папка_смета.pdf');
  expect(safeDownloadName('..\\..\\секрет.txt')).toBe('.._.._секрет.txt');
  expect(safeDownloadName('')).toBe('file');
  expect(safeDownloadName(null, 'запасное.bin')).toBe('запасное.bin');
});

test('на Android зовёт системный загрузчик и говорит, куда положил', async () => {
  mockState.nativeMobile = true;
  mockDownload.mockResolvedValue({ id: 7, location: 'Загрузки' });

  const result = await downloadFile('https://example.com/a.pdf', 'смета за август.pdf');

  expect(mockDownload).toHaveBeenCalledWith({
    url: 'https://example.com/a.pdf',
    filename: 'смета за август.pdf',
  });
  expect(result).toEqual({ ok: true, location: 'Загрузки' });
});

test('отказ загрузчика возвращается человеку текстом, а не тишиной', async () => {
  mockState.nativeMobile = true;
  mockDownload.mockRejectedValue(new Error('Системный загрузчик недоступен'));

  const result = await downloadFile('https://example.com/a.pdf', 'a.pdf');

  expect(result.ok).toBe(false);
  expect(result.error).toBe('Системный загрузчик недоступен');
});

test('в десктопе скачивает главный процесс и отдаёт путь', async () => {
  const desktop = vi.fn().mockResolvedValue({ ok: true, path: 'C:\\Users\\Gri\\Downloads\\a.pdf' });
  (window as any).electronAPI = { downloadFile: desktop };

  const result = await downloadFile('https://example.com/a.pdf', 'a.pdf');

  expect(desktop).toHaveBeenCalledWith('https://example.com/a.pdf', 'a.pdf');
  expect(result).toEqual({ ok: true, location: 'C:\\Users\\Gri\\Downloads\\a.pdf' });
});

test('без адреса ничего не качаем', async () => {
  const result = await downloadFile(null, 'a.pdf');
  expect(result).toEqual({ ok: false, error: 'Файл недоступен' });
  expect(mockDownload).not.toHaveBeenCalled();
});
