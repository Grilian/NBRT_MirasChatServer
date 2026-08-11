const mockSetOverlay = jest.fn().mockResolvedValue({ navigationBarHeight: 24 });

export {};

jest.mock('@capacitor/core', () => ({
  registerPlugin: () => ({ setOverlay: mockSetOverlay }),
}));
jest.mock('@capacitor/keyboard', () => ({
  Keyboard: {
    addListener: jest.fn().mockResolvedValue({ remove: jest.fn() }),
    hide: jest.fn().mockResolvedValue(undefined),
    show: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('./mobileNotify', () => ({ isNativeMobile: true }));

const {
  acquireChatKeyboardResizeMode,
  acquireStandardKeyboardResizeMode,
} = require('./mobileKeyboard');

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
