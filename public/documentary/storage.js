export class DocumentaryStore {
  constructor() { this.pending = Promise.resolve(); this.db = null; }
  async open() {
    if (this.db) return this.db;
    this.db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('craftush-documentary-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('items');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Project storage is unavailable in this browser.'));
    });
    return this.db;
  }
  async get(key) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const request = db.transaction('items', 'readonly').objectStore('items').get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }
  put(key, value) {
    const write = async () => {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction('items', 'readwrite');
        transaction.objectStore('items').put(value, key);
        transaction.oncomplete = () => resolve();
        transaction.onerror = transaction.onabort = () => reject(new Error('Browser storage is full or unavailable. Download your project and scenes to keep a copy.'));
      });
    };
    const result = this.pending.then(write); this.pending = result.catch(() => {}); return result;
  }
  async delete(key) {
    await this.pending;
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('items', 'readwrite'); tx.objectStore('items').delete(key);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
  }
}
