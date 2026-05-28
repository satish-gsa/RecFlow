/**
 * RecorderDB — IndexedDB wrapper for RecFlow extension.
 *
 * Schema:
 *   recordings  { id, name, mode, audioMode, mimeType, status, timestamp,
 *                 duration, size, thumbnail }
 *   chunks      { id (autoInc), recordingId, data (Blob), seq }
 */
class RecorderDB {
  constructor() {
    this._db = null;
    this._DB_NAME = 'ScreenRecorderDB';
    this._DB_VERSION = 1;
  }

  // ---- Open ----
  open() {
    if (this._db) return Promise.resolve(this._db);

    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this._DB_NAME, this._DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;

        if (!db.objectStoreNames.contains('recordings')) {
          const rs = db.createObjectStore('recordings', { keyPath: 'id' });
          rs.createIndex('status', 'status', { unique: false });
          rs.createIndex('timestamp', 'timestamp', { unique: false });
        }

        if (!db.objectStoreNames.contains('chunks')) {
          const cs = db.createObjectStore('chunks', {
            keyPath: 'id',
            autoIncrement: true,
          });
          cs.createIndex('recordingId', 'recordingId', { unique: false });
          cs.createIndex('seq', 'seq', { unique: false });
        }
      };

      req.onsuccess = (e) => {
        this._db = e.target.result;
        resolve(this._db);
      };

      req.onerror = () => reject(req.error);
    });
  }

  // ---- Recordings CRUD ----

  createRecording(recording) {
    return this._put('recordings', recording);
  }

  async updateRecording(id, updates) {
    const existing = await this.getRecording(id);
    if (!existing) throw new Error(`Recording ${id} not found`);
    return this._put('recordings', { ...existing, ...updates });
  }

  getRecording(id) {
    return this._get('recordings', id);
  }

  getAllRecordings() {
    return this._getAll('recordings');
  }

  getRecordingsByStatus(status) {
    return this._getByIndex('recordings', 'status', status);
  }

  async deleteRecording(id) {
    await this.deleteChunksForRecording(id);
    return this._delete('recordings', id);
  }

  // ---- Chunks ----

  saveChunk(recordingId, blob, seq) {
    return this._put('chunks', { recordingId, data: blob, seq });
  }

  getChunksForRecording(recordingId) {
    return this._getByIndex('chunks', 'recordingId', recordingId);
  }

  async deleteChunksForRecording(recordingId) {
    const db = this._db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('chunks', 'readwrite');
      const index = tx.objectStore('chunks').index('recordingId');
      const req = index.openCursor(IDBKeyRange.only(recordingId));
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new DOMException('Transaction aborted', 'AbortError'));
    });
  }

  // ---- Low-level helpers ----

  _put(storeName, value) {
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction(storeName, 'readwrite');
      const req = tx.objectStore(storeName).put(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  _get(storeName, key) {
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  _getAll(storeName) {
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  _getByIndex(storeName, indexName, value) {
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).index(indexName).getAll(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  _delete(storeName, key) {
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction(storeName, 'readwrite');
      const req = tx.objectStore(storeName).delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error || tx.error);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new DOMException('Transaction aborted', 'AbortError'));
    });
  }
}
