import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import SettingsPanel from './SettingsPanel';

// Настройки больше не один свиток: слева оглавление, справа один раздел.
// Значит и в тесте надо сначала открыть нужный раздел — ровно так же, как это
// теперь делает человек. Хелпер один на файл, чтобы не повторять клик
// двадцать раз.
const openSection = () => fireEvent.click(screen.getByRole('button', { name: 'Приложение' }));

vi.mock('@/shared/api/client', () => ({
  __esModule: true,
  default: {
    get: vi.fn(() => Promise.resolve({ data: {} })),
    post: vi.fn(() => Promise.resolve({ data: {} })),
    delete: vi.fn(() => Promise.resolve({ data: {} })),
  },
}));

const baseProps = {
  username: 'Тест',
  avatarPath: null,
  onClose: () => {},
  onOpenProfile: () => {},
  onDeleteAccount: () => {},
  onLogout: () => {},
};

// electron-updater умеет тихо поставить только NSIS (Windows) и AppImage;
// мы раздаём на Linux .deb/.tar.gz, поэтому там обновление скачивается само,
// а установка требует явного клика — открывается системный установщик
// (см. desktop/src/main.js: checkLinuxUpdate/installLinuxUpdate). Эти тесты
// проверяют только UI-часть: main-процесс в jsdom недоступен.
function mockElectronAPI(updateState: any, overrides: Record<string, any> = {}) {
  (window as any).electronAPI = {
    platform: 'linux',
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn(() => Promise.resolve(false)),
    onMaximizedChange: vi.fn(() => () => {}),
    getAutoLaunch: vi.fn(() => Promise.resolve(false)),
    setAutoLaunch: vi.fn((v: boolean) => Promise.resolve(v)),
    setUnreadBadge: vi.fn(),
    focusWindow: vi.fn(),
    flashWindow: vi.fn(),
    onFocusChange: vi.fn(() => () => {}),
    getAppVersion: vi.fn(() => Promise.resolve('1.11.5')),
    checkForUpdate: vi.fn(),
    installUpdate: vi.fn(),
    onUpdateState: vi.fn((cb: (s: any) => void) => { cb(updateState); return () => {}; }),
    getProxyState: vi.fn(() => Promise.resolve({
      enabled: false, mode: 'cit', manualHost: '', manualPort: '',
      citPacUrl: 'http://i.tatar.ru/wpad.dat', citReachable: false,
    })),
    setProxyState: vi.fn(),
    checkCitProxy: vi.fn(() => Promise.resolve(false)),
    onProxyStateChanged: vi.fn(() => () => {}),
    ...overrides,
  };
}

describe('SettingsPanel — обновления на Linux', () => {
  afterEach(() => {
    delete (window as any).electronAPI;
  });

  test('linux-downloading показывает прогресс без кнопки', async () => {
    mockElectronAPI({ status: 'linux-downloading', percent: 42 });
    render(<SettingsPanel {...baseProps} />);
    openSection();

    expect(await screen.findByText('Загрузка обновления')).toBeInTheDocument();
    expect(screen.getByText('42%')).toBeInTheDocument();
    expect(screen.queryByText('Установить')).not.toBeInTheDocument();
  });

  test('linux-ready показывает кнопку «Установить», которая вызывает installUpdate', async () => {
    const installUpdate = vi.fn();
    mockElectronAPI({ status: 'linux-ready', version: '1.12.0' }, { installUpdate });
    render(<SettingsPanel {...baseProps} />);
    openSection();

    const row = await screen.findByText('Обновление 1.12.0 скачано');
    expect(screen.getByText('Установить')).toBeInTheDocument();

    fireEvent.click(row.closest('button') as HTMLElement);
    expect(installUpdate).toHaveBeenCalledTimes(1);
  });

  test('idle не показывает ни прогресс, ни кнопку установки', async () => {
    mockElectronAPI({ status: 'idle' });
    render(<SettingsPanel {...baseProps} />);
    openSection();

    await screen.findByText('Добавить в автозагрузку'); // дожидаемся отрисовки секции «Приложение»
    expect(screen.queryByText('Загрузка обновления')).not.toBeInTheDocument();
    expect(screen.queryByText(/скачано/)).not.toBeInTheDocument();
  });
});
