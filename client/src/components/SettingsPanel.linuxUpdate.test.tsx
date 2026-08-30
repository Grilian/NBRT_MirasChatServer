import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import SettingsPanel from './SettingsPanel';

jest.mock('../api/client', () => ({
  __esModule: true,
  default: {
    get: jest.fn(() => Promise.resolve({ data: {} })),
    post: jest.fn(() => Promise.resolve({ data: {} })),
    delete: jest.fn(() => Promise.resolve({ data: {} })),
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
    minimize: jest.fn(),
    toggleMaximize: jest.fn(),
    close: jest.fn(),
    isMaximized: jest.fn(() => Promise.resolve(false)),
    onMaximizedChange: jest.fn(() => () => {}),
    getAutoLaunch: jest.fn(() => Promise.resolve(false)),
    setAutoLaunch: jest.fn((v: boolean) => Promise.resolve(v)),
    setUnreadBadge: jest.fn(),
    focusWindow: jest.fn(),
    flashWindow: jest.fn(),
    onFocusChange: jest.fn(() => () => {}),
    getAppVersion: jest.fn(() => Promise.resolve('1.11.5')),
    checkForUpdate: jest.fn(),
    installUpdate: jest.fn(),
    onUpdateState: jest.fn((cb: (s: any) => void) => { cb(updateState); return () => {}; }),
    getProxyState: jest.fn(() => Promise.resolve({
      enabled: false, mode: 'cit', manualHost: '', manualPort: '',
      citPacUrl: 'http://i.tatar.ru/wpad.dat', citReachable: false,
    })),
    setProxyState: jest.fn(),
    checkCitProxy: jest.fn(() => Promise.resolve(false)),
    onProxyStateChanged: jest.fn(() => () => {}),
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

    expect(await screen.findByText('Загрузка обновления')).toBeInTheDocument();
    expect(screen.getByText('42%')).toBeInTheDocument();
    expect(screen.queryByText('Установить')).not.toBeInTheDocument();
  });

  test('linux-ready показывает кнопку «Установить», которая вызывает installUpdate', async () => {
    const installUpdate = jest.fn();
    mockElectronAPI({ status: 'linux-ready', version: '1.12.0' }, { installUpdate });
    render(<SettingsPanel {...baseProps} />);

    const row = await screen.findByText('Обновление 1.12.0 скачано');
    expect(screen.getByText('Установить')).toBeInTheDocument();

    fireEvent.click(row.closest('button') as HTMLElement);
    expect(installUpdate).toHaveBeenCalledTimes(1);
  });

  test('idle не показывает ни прогресс, ни кнопку установки', async () => {
    mockElectronAPI({ status: 'idle' });
    render(<SettingsPanel {...baseProps} />);

    await screen.findByText('Добавить в автозагрузку'); // дожидаемся отрисовки секции «Приложение»
    expect(screen.queryByText('Загрузка обновления')).not.toBeInTheDocument();
    expect(screen.queryByText(/скачано/)).not.toBeInTheDocument();
  });
});
