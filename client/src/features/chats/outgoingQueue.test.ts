import {
  createOutgoingMessage,
  loadOutgoingQueue,
  retryDelayMs,
  saveOutgoingQueue,
} from './outgoingQueue';

describe('persistent outgoing queue', () => {
  beforeEach(() => localStorage.clear());

  test('survives a fresh load and stays isolated per account', () => {
    const item = createOutgoingMessage(7, { chatId: 'chat_7_9', text: 'hello' });
    saveOutgoingQueue(7, [item]);

    expect(loadOutgoingQueue(7)).toEqual([item]);
    expect(loadOutgoingQueue(8)).toEqual([]);
  });

  test('ignores damaged persisted data', () => {
    localStorage.setItem('miras-outgoing-v1:7', '{broken');
    expect(loadOutgoingQueue(7)).toEqual([]);
  });

  test('uses bounded exponential retry delays', () => {
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      expect(retryDelayMs(1)).toBe(1000);
      expect(retryDelayMs(3)).toBe(4000);
      expect(retryDelayMs(20)).toBe(30000);
    } finally {
      Math.random = originalRandom;
    }
  });
});
