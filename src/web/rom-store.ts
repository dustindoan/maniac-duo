// Your ROM stays in this browser (IndexedDB). It is never uploaded.
const DB = 'maniac-duo';
const STORE = 'rom';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadStoredRom(): Promise<Uint8Array | null> {
  try {
    const db = await open();
    return await new Promise((resolve) => {
      const req = db.transaction(STORE).objectStore(STORE).get('prg');
      req.onsuccess = () => resolve(req.result ? new Uint8Array(req.result) : null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function storeRom(bytes: Uint8Array) {
  try {
    const db = await open();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), 'prg');
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Private windows may refuse storage; the game still works for this visit.
  }
}

export async function forgetRom() {
  try {
    const db = await open();
    // Wait for the delete to commit: the caller reloads the page straight after.
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete('prg');
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {}
}
