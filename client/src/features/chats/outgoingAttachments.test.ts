import { storeOutgoingAttachment } from './outgoingAttachments';

describe('outgoing image persistence', () => {
  test('reports a source file removed before send', async () => {
    const removedFile = {
      name: 'removed.jpg',
      type: 'image/jpeg',
      arrayBuffer: () => Promise.reject(new DOMException('File is gone', 'NotReadableError')),
    } as unknown as File;

    await expect(storeOutgoingAttachment('msg_removed_file_test', removedFile))
      .rejects.toThrow('source_file_unavailable');
  });
});
