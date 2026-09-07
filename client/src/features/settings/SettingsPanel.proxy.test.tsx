import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SettingsPanel from './SettingsPanel';

// Настройки больше не один свиток: слева оглавление, справа один раздел.
// Значит и в тесте надо сначала открыть нужный раздел — ровно так же, как это
// теперь делает человек. Хелпер один на файл, чтобы не повторять клик
// двадцать раз.
const openSection = () => fireEvent.click(screen.getByRole('button', { name: 'Подключение' }));

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

const baseProxyState = {
  enabled: true,
  mode: 'cit' as const,
  manualHost: '',
  manualPort: '',
  citUsername: '',
  citPasswordSet: false,
  citReachable: false,
  citAuthStatus: null as 'no-credentials' | 'pending' | 'rejected' | null,
};

function mockElectronAPI(overrides: Record<string, any> = {}) {
  (window as any).electronAPI = {
    platform: 'win32',
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
    getAppVersion: vi.fn(() => Promise.resolve('1.0.0')),
    checkForUpdate: vi.fn(),
    installUpdate: vi.fn(),
    onUpdateState: vi.fn(() => () => {}),
    getProxyState: vi.fn(() => Promise.resolve(baseProxyState)),
    setProxyState: vi.fn((patch: any) => Promise.resolve({ ...baseProxyState, ...patch })),
    checkCitProxy: vi.fn(() => Promise.resolve(false)),
    onProxyStateChanged: vi.fn(() => () => {}),
    ...overrides,
  };
}

// isElectron в SettingsPanel.tsx вычисляется заново на каждый рендер (см.
// isElectronEnv() в самом компоненте) именно для того, чтобы разные тесты в
// этом файле могли ставить/убирать window.electronAPI перед каждым сценарием
// без танцев с vi.resetModules() — тот заодно пересоздаёт модуль 'react' и
// ломает хуки на два несовместимых экземпляра React.

describe('SettingsPanel — прокси', () => {
  afterEach(() => {
    delete (window as any).electronAPI;
  });

  test('раздел «Подключение» не показывается вне Electron', async () => {
    // Сетью вне десктопного клиента распоряжается не приложение, и пункт, за
    // которым пусто, неотличим от сломанного — поэтому в оглавлении его нет
    // вовсе, а не «есть, но пустой».
    delete (window as any).electronAPI;
    render(<SettingsPanel {...baseProps} />);
    // Даём отработать возможные микрозадачи монтирования.
    await act(async () => {});
    expect(screen.queryByRole('button', { name: 'Подключение' })).not.toBeInTheDocument();
    expect(screen.queryByText('Прокси')).not.toBeInTheDocument();
  });

  test('ЦИТ недоступен — адрес показан бледным текстом с подсказкой', async () => {
    mockElectronAPI({ getProxyState: vi.fn(() => Promise.resolve(baseProxyState)) });
    render(<SettingsPanel {...baseProps} />);
    openSection();

    const address = await screen.findByText('PAC ЦИТ — i.tatar.ru:8080');
    expect(address).toHaveClass('is-muted');
    expect(screen.getByText('Не настроен — подключите Wi-Fi для настройки')).toBeInTheDocument();
  });

  test('ЦИТ доступен — адрес обычным цветом, без предупреждения', async () => {
    mockElectronAPI({
      getProxyState: vi.fn(() => Promise.resolve({ ...baseProxyState, citReachable: true })),
    });
    render(<SettingsPanel {...baseProps} />);
    openSection();

    const address = await screen.findByText('PAC ЦИТ — i.tatar.ru:8080');
    expect(address).not.toHaveClass('is-muted');
    expect(screen.queryByText('Не настроен — подключите Wi-Fi для настройки')).not.toBeInTheDocument();
  });

  test('переключение на «Вручную» и сохранение адреса с портом уходит в setProxyState', async () => {
    const setProxyState = vi.fn((patch: any) => Promise.resolve({
      ...baseProxyState, mode: 'manual', ...patch,
    }));
    mockElectronAPI({
      getProxyState: vi.fn(() => Promise.resolve({ ...baseProxyState, mode: 'manual' })),
      setProxyState,
    });
    const { container } = render(<SettingsPanel {...baseProps} />);
    openSection();

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
    const setProxyState = vi.fn((patch: any) => Promise.resolve({ ...baseProxyState, ...patch }));
    mockElectronAPI({
      getProxyState: vi.fn(() => Promise.resolve({ ...baseProxyState, enabled: false })),
      setProxyState,
    });
    render(<SettingsPanel {...baseProps} />);
    openSection();

    const row = (await screen.findByText('Использовать прокси')).closest('.settings-row') as HTMLElement;
    const checkbox = row.querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(checkbox);

    await waitFor(() => expect(setProxyState).toHaveBeenCalledWith({ enabled: true }));
  });

  test('выключенный прокси не показывает ни режимы, ни поля', async () => {
    mockElectronAPI({
      getProxyState: vi.fn(() => Promise.resolve({ ...baseProxyState, enabled: false })),
    });
    render(<SettingsPanel {...baseProps} />);
    openSection();

    await screen.findByText('Использовать прокси');
    expect(screen.queryByText('Системный')).not.toBeInTheDocument();
    expect(screen.queryByText('Вручную')).not.toBeInTheDocument();
    expect(screen.queryByText('ЦИТ')).not.toBeInTheDocument();
  });

  test('режим «Системный» доступен и логин/пароль показываются и для него тоже', async () => {
    const setProxyState = vi.fn((patch: any) => Promise.resolve({ ...baseProxyState, mode: 'system', ...patch }));
    mockElectronAPI({
      getProxyState: vi.fn(() => Promise.resolve({ ...baseProxyState, mode: 'system' })),
      setProxyState,
    });
    render(<SettingsPanel {...baseProps} />);
    openSection();

    await screen.findByText('Системный прокси');
    expect(screen.getByText('Используются настройки сети из самой ОС')).toBeInTheDocument();
    // Логин/пароль — общие для «Системный» и «ЦИТ», раз относятся к самому
    // серверу, а не к способу его поиска.
    expect(screen.getByText('Логин и пароль прокси')).toBeInTheDocument();
  });

  test('переключение на «Системный» отправляет mode: system', async () => {
    const setProxyState = vi.fn((patch: any) => Promise.resolve({ ...baseProxyState, ...patch }));
    mockElectronAPI({
      getProxyState: vi.fn(() => Promise.resolve(baseProxyState)),
      setProxyState,
    });
    render(<SettingsPanel {...baseProps} />);
    openSection();

    fireEvent.click(await screen.findByText('Системный'));
    await waitFor(() => expect(setProxyState).toHaveBeenCalledWith({ mode: 'system' }));
  });

  test('вручную логин/пароль не показываются — свой сервер без общей авторизации', async () => {
    mockElectronAPI({
      getProxyState: vi.fn(() => Promise.resolve({ ...baseProxyState, mode: 'manual' })),
    });
    render(<SettingsPanel {...baseProps} />);
    openSection();

    await screen.findByText('Использовать прокси');
    expect(screen.queryByText('Логин и пароль прокси')).not.toBeInTheDocument();
  });

  test('прокси отклонил логин — показывается предупреждение', async () => {
    mockElectronAPI({
      getProxyState: vi.fn(() => Promise.resolve({
        ...baseProxyState, citUsername: 'govtatar\\ivanov', citPasswordSet: true, citAuthStatus: 'rejected',
      })),
    });
    render(<SettingsPanel {...baseProps} />);
    openSection();

    expect(await screen.findByText(/Прокси не принял логин или пароль/)).toBeInTheDocument();
  });

  test('нет предупреждения, пока статус авторизации неизвестен', async () => {
    mockElectronAPI({ getProxyState: vi.fn(() => Promise.resolve(baseProxyState)) });
    render(<SettingsPanel {...baseProps} />);
    openSection();

    await screen.findByText('Логин и пароль прокси');
    expect(screen.queryByText(/Прокси не принял/)).not.toBeInTheDocument();
  });

  test('логин и пароль ЦИТ сохраняются вместе одним запросом', async () => {
    const setProxyState = vi.fn((patch: any) => Promise.resolve({ ...baseProxyState, ...patch }));
    mockElectronAPI({
      getProxyState: vi.fn(() => Promise.resolve(baseProxyState)),
      setProxyState,
    });
    const { container } = render(<SettingsPanel {...baseProps} />);
    openSection();

    await screen.findByText('Логин и пароль прокси');
    const loginInput = container.querySelector('input[placeholder^="Домен"]') as HTMLInputElement;
    const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement;
    expect(loginInput).not.toBeNull();
    expect(passwordInput).not.toBeNull();

    fireEvent.change(loginInput, { target: { value: 'ivanov' } });
    fireEvent.change(passwordInput, { target: { value: 'secret123' } });
    fireEvent.click(screen.getByText('Сохранить', { selector: '.proxy-manual-actions button' }));

    await waitFor(() => expect(setProxyState).toHaveBeenCalledWith({ citUsername: 'ivanov', citPassword: 'secret123' }));
  });

  test('пустой пароль при сохранении не перезаписывает уже сохранённый', async () => {
    const setProxyState = vi.fn((patch: any) => Promise.resolve({ ...baseProxyState, citPasswordSet: true, ...patch }));
    mockElectronAPI({
      getProxyState: vi.fn(() => Promise.resolve({ ...baseProxyState, citUsername: 'ivanov', citPasswordSet: true })),
      setProxyState,
    });
    const { container } = render(<SettingsPanel {...baseProps} />);
    openSection();

    await screen.findByText('Логин и пароль прокси');
    // Плейсхолдер подсказывает, что пароль уже есть, а поле остаётся пустым —
    // подставлять сохранённый секрет обратно в интерфейс нельзя.
    const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement;
    expect(passwordInput.value).toBe('');
    expect(passwordInput.placeholder).toContain('сохранён');

    fireEvent.click(screen.getByText('Сохранить', { selector: '.proxy-manual-actions button' }));

    await waitFor(() => expect(setProxyState).toHaveBeenCalledWith({ citUsername: 'ivanov' }));
    const call = setProxyState.mock.calls[0][0];
    expect(call).not.toHaveProperty('citPassword');
  });

  test('кнопка «Убрать пароль» отправляет пустую строку явно', async () => {
    const setProxyState = vi.fn((patch: any) => Promise.resolve({ ...baseProxyState, citPasswordSet: false, ...patch }));
    mockElectronAPI({
      getProxyState: vi.fn(() => Promise.resolve({ ...baseProxyState, citPasswordSet: true })),
      setProxyState,
    });
    render(<SettingsPanel {...baseProps} />);
    openSection();

    const clearBtn = await screen.findByText('Убрать пароль');
    fireEvent.click(clearBtn);

    await waitFor(() => expect(setProxyState).toHaveBeenCalledWith({ citPassword: '' }));
  });

  test('без сохранённого пароля кнопки «Убрать пароль» нет', async () => {
    mockElectronAPI({
      getProxyState: vi.fn(() => Promise.resolve({ ...baseProxyState, citPasswordSet: false })),
    });
    render(<SettingsPanel {...baseProps} />);
    openSection();

    await screen.findByText('Логин и пароль прокси');
    expect(screen.queryByText('Убрать пароль')).not.toBeInTheDocument();
  });
});
