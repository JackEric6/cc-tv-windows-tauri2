const DATABASE_NAME = 'congcong-tv-preview-frames'
const DATABASE_VERSION = 1
const STORE_NAME = 'frames'

interface StoredFrame {
  id: string
  scope: string
  seconds: number
  dataUrl: string
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB is unavailable'))
      return
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('scope', 'scope', { unique: false })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Unable to open preview cache'))
  })
}

export async function loadPreviewFrames(scope: string): Promise<Map<number, string>> {
  const database = await openDatabase()
  try {
    const frames = await new Promise<StoredFrame[]>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly')
      const request = transaction.objectStore(STORE_NAME).index('scope').getAll(scope)
      request.onsuccess = () => resolve(request.result as StoredFrame[])
      request.onerror = () => reject(request.error ?? new Error('Unable to read preview cache'))
    })
    return new Map(frames.map((frame) => [frame.seconds, frame.dataUrl]))
  } finally {
    database.close()
  }
}

export async function savePreviewFrame(scope: string, seconds: number, dataUrl: string): Promise<void> {
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      transaction.objectStore(STORE_NAME).put({
        id: `${scope}\u001f${seconds}`,
        scope,
        seconds,
        dataUrl
      } satisfies StoredFrame)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('Unable to save preview frame'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Preview cache transaction aborted'))
    })
  } finally {
    database.close()
  }
}
