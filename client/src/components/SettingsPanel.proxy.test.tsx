import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const baseProxyState = {
  enabled: true,
  mode: 'cit' as const,
  manualHost: '',
  manualPort: '',
  citPacUrl: 'http://i.tatar.ru/wpad.dat',
  citReachable: false,
};

function mockElectronAPI(overrides: Record<string, any> = {}) {
  (window as any).electronAPI = {
    platform: 'win32',
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
    getAppVersion: jest.fn(() => Promise.resolve('1.0.0')),
    checkForUpdate: jest.fn(),
    installUpdate: jest.fn(),
    onUpdateState: jest.fn(() => () => {}),
    getProxyState: jest.fn(() => Promise.resolve(baseProxyState)),
    setProxyState: jest.fn((patch: any) => Promise.resolve({ ...baseProxyState, ...patch })),
    checkCitProxy: jest.fn(() => Promise.resolve(false)),
    onProxyStateChanged: jest.fn(() => () => {}),
    ...overrides,
  };
}

// isElectron в SettingsPanel.tsx вычисляется заново на каждый рендер (см.
// isElectronEnv() в самом компоненте) именно для того, чтобы разные тесты в
// этом файле могли ставить/убирать window.electronAPI перед каждым сценарием
// без танцев с jest.resetModules() — тот заодно пересоздаёт модуль 'react' и
// ломает хуки на два несовместимых экземпляра React.

describe('SettingsPanel — прокси', () => {
  afterEach(() => {
    delete (window as any).electronAPI;
  });

  test('раздел «Прокси» не показывается вне Electron', async () => {
    delete (window as any).electronAPI;
    render(<SettingsPanel {...baseProps} />);
    // Даём отработать возможные микрозадачи монтирования.
    await act(async () => {});
    expect(screen.queryByText('Прокси')).not.toBeInTheDocument();
  });

  test('ЦИТ недоступен — адрес показан бледным текстом с подсказкой', async () => {
    mockElectronAPI({ getProxyState: jest.fn(() => Promise.resolve(baseProxyState)) });
    render(<SettingsPanel {...baseProps} />);

    const address = await screen.findByText('http://i.tatar.ru/wpad.dat');
    expect(address).toHaveClass('is-muted');
    expect(screen.getByText('Не настроен — подключите Wi-Fi для настройки')).toBeInTheDocument();
  });

  test('ЦИТ доступен — адрес обычным цветом, без предупреждения', async () => {
    mockElectronAPI({
      getProxyState: jest.fn(() => Promise.resolve({ ...baseProxyState, citReachable: true })),
    });
    render(<SettingsPanel {...baseProps} />);

    const address = await screen.findByText('http://i.tatar.ru/wpad.dat');
    expect(address).not.toHaveClass('is-muted');
    expect(screen.queryByText('Не настроен — подключите Wi-Fi для настройки')).not.toBeInTheDocument();
  });

  test('переключение на «Вручную» и сохранение адреса с портом уходит в setProxyState', async () => {
    const setProxyState = jest.fn((patch: any) => Promise.resolve({
      ...baseProxyState, mode: 'manual', ...patch,
    }));
    mockElectronAPI({
      getProxyState: jest.fn(() => Promise.resolve({ ...baseProxyState, mode: 'manual' })),
      setProxyState,
    });
    const { container } = render(<SettingsPanel {...baseProps} />);

    await screen.findByText('Использовать прокси');
    const hostInput = container.querySelector('input[placeholder="proxy.example.ru"]') as HTMLInputElement;
    const portInput = container.querySelector('input[placeholder="8080"]') as HTMLInputElement;
    expect(hostInput).not.toBeNull();

    fireEvent.change(hostInput, { target: { value: '10.1.5.5' } });
    fireEvent.change(portInput, { target: { value: '3128' } });
    fireEvent.click(screen.getByText('Сохранить'));

    await waitFor(() => expect(setProxyState).toHaveBeenCalledWith({ manualHost: '10.1.5.5', manualPort: '3128' }));
  });

  test('включение переключателя «Использовать прокси» отправляет enabled: true', async () => {
    const setProxyState = jest.fn((patch: any) => Promise.resolve({ ...baseProxyState, ...patch }));
    mockElectronAPI({
      getProxyState: jest.fn(() => Promise.resolve({ ...baseProxyState, enabled: false })),
      setProxyState,
    });
    render(<SettingsPanel {...baseProps} />);

    const row = (await screen.findByText('Использовать прокси')).closest('.settings-row') as HTMLElement;
    const checkbox = row.querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(checkbox);

    await waitFor(() => expect(setProxyState).toHaveBeenCalledWith({ enabled: true }));
  });

  test('выключенный прокси не показывает ни режимы, ни поля', async () => {
    mockElectronAPI({
      getProxyState: jest.fn(() => Promise.resolve({ ...baseProxyState, enabled: false })),
    });
    render(<SettingsPanel {...baseProps} />);

    await screen.findByText('Использовать прокси');
    expect(screen.queryByText('Вручную')).not.toBeInTheDocument();
    expect(screen.queryByText('ЦИТ')).not.toBeInTheDocument();
  });
});
