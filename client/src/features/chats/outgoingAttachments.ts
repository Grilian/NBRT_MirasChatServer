const DB_NAME = 'miras-chat-outgoing';
const DB_VERSION = 1;
const STORE_NAME = 'attachments';

export interface StoredOutgoingAttachment {
  clientMessageId: string;
  blob: Blob;
  name: string;
  type: string;
  savedAt: number;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexeddb_unavailable'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'clientMessageId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('indexeddb_open_failed'));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('indexeddb_request_failed'));
  });
}

export async function storeOutgoingAttachment(clientMessageId: string, file: File): Promise<void> {
  // Чтение заставляет браузер проверить, что выбранный файл всё ещё доступен.
  // Некоторые WebView держат только ссылку на исходный путь: если фото успели
  // удалить до отправки, простой put мог сохранить уже нечитаемый File.
  let blob: Blob;
  try {
    blob = new Blob([await file.arrayBuffer()], { type: file.type || 'application/octet-stream' });
  } catch {
    throw new Error('source_file_unavailable');
  }

  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    await requestResult(transaction.objectStore(STORE_NAME).put({
      clientMessageId,
      blob,
      name: file.name || 'image',
      type: file.type || blob.type,
      savedAt: Date.now(),
    } as StoredOutgoingAttachment));
  } finally {
    database.close();
  }
}

export async function getOutgoingAttachment(clientMessageId: string): Promise<StoredOutgoingAttachment | undefined> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    return await requestResult(transaction.objectStore(STORE_NAME).get(clientMessageId));
  } finally {
    database.close();
  }
}

export async function deleteOutgoingAttachment(clientMessageId: string): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    await requestResult(transaction.objectStore(STORE_NAME).delete(clientMessageId));
  } finally {
    database.close();
  }
}
