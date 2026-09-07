const mockSetOverlay = vi.fn().mockResolvedValue({ navigationBarHeight: 24 });

export {};

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => ({ setOverlay: mockSetOverlay }),
}));
vi.mock('@capacitor/keyboard', () => ({
  Keyboard: {
    addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
    hide: vi.fn().mockResolvedValue(undefined),
    show: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('./mobileNotify', () => ({ isNativeMobile: true }));
const {
  acquireChatKeyboardResizeMode,
  acquireStandardKeyboardResizeMode,
} = await import('./mobileKeyboard');

beforeEach(() => mockSetOverlay.mockClear());

test('keeps chat overlay until the last composer releases it', () => {
  const releaseMain = acquireChatKeyboardResizeMode();
  const releaseThread = acquireChatKeyboardResizeMode();
  releaseThread();
  releaseMain();

  expect(mockSetOverlay.mock.calls.map(([value]) => value.active)).toEqual([true, true, true, false]);
});

test('temporarily gives a modal poll editor standard keyboard resize', () => {
  const releaseChat = acquireChatKeyboardResizeMode();
  const releasePoll = acquireStandardKeyboardResizeMode();
  releasePoll();
  releaseChat();

  expect(mockSetOverlay.mock.calls.map(([value]) => value.active)).toEqual([true, false, true, false]);
});
