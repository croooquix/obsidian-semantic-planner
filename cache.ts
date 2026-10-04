export const MODEL_ID = 'Xenova/multilingual-e5-small';
export const PIPELINE_VERSION = 1;

export interface CachedEmbedding {
    path: string;              // primary key
    mtime: number;             // file.stat.mtime
    size: number;              // file.stat.size
    modelId: string;           // model ID
    pipelineVersion: number;   // pipeline version
    isSkipped: boolean;        // true if text length < 10
    embedding: Float32Array;   // Float32 vector
}

export class EmbeddingCache {
    private dbName: string;
    private db: IDBDatabase | null = null;
    private readonly STORE_NAME = 'embeddings';

    constructor(vaultName: string) {
        // Sanitize vault name for IDB DB name
        const sanitized = vaultName.replace(/[^a-zA-Z0-9_-]/g, '_');
        this.dbName = `semantic-planner-cache-${sanitized}`;
    }

    async openDB(): Promise<IDBDatabase> {
        if (this.db) return this.db;

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);

            request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
                const db = (event.target as IDBOpenDBRequest).result;
                if (!db.objectStoreNames.contains(this.STORE_NAME)) {
                    db.createObjectStore(this.STORE_NAME, { keyPath: 'path' });
                }
            };

            request.onsuccess = (event: Event) => {
                this.db = (event.target as IDBOpenDBRequest).result;
                resolve(this.db);
            };

            request.onerror = (event: Event) => {
                console.error("EmbeddingCache: Failed to open IndexedDB", (event.target as IDBOpenDBRequest).error);
                reject((event.target as IDBOpenDBRequest).error);
            };
        });
    }

    async getMany(paths: string[]): Promise<Map<string, CachedEmbedding>> {
        const resultMap = new Map<string, CachedEmbedding>();
        if (paths.length === 0) return resultMap;

        try {
            const db = await this.openDB();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(this.STORE_NAME, 'readonly');
                const store = tx.objectStore(this.STORE_NAME);

                tx.oncomplete = () => resolve(resultMap);
                tx.onerror = () => reject(tx.error);

                for (const path of paths) {
                    const req = store.get(path);
                    req.onsuccess = () => {
                        if (req.result) {
                            const val = req.result;
                            if (val.embedding && Array.isArray(val.embedding)) {
                                val.embedding = new Float32Array(val.embedding);
                            }
                            resultMap.set(path, val);
                        }
                    };
                }
            });
        } catch (err) {
            console.warn("EmbeddingCache: getMany fallback to empty cache", err);
            return resultMap;
        }
    }

    async putMany(entries: CachedEmbedding[]): Promise<void> {
        if (entries.length === 0) return;

        try {
            const db = await this.openDB();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(this.STORE_NAME, 'readwrite');
                const store = tx.objectStore(this.STORE_NAME);

                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);

                for (const entry of entries) {
                    store.put(entry);
                }
            });
        } catch (err) {
            console.error("EmbeddingCache: putMany failed", err);
        }
    }

    async deletePathsNotIn(currentPaths: Set<string>): Promise<string[]> {
        const deleted: string[] = [];
        try {
            const db = await this.openDB();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(this.STORE_NAME, 'readwrite');
                const store = tx.objectStore(this.STORE_NAME);
                const cursorReq = store.openCursor();

                cursorReq.onsuccess = (e) => {
                    const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
                    if (cursor) {
                        if (!currentPaths.has(cursor.key as string)) {
                            deleted.push(cursor.key as string);
                            cursor.delete();
                        }
                        cursor.continue();
                    }
                };

                tx.oncomplete = () => resolve(deleted);
                tx.onerror = () => reject(tx.error);
            });
        } catch (err) {
            console.error("EmbeddingCache: deletePathsNotIn failed", err);
            return deleted;
        }
    }

    async clear(): Promise<void> {
        try {
            const db = await this.openDB();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(this.STORE_NAME, 'readwrite');
                const store = tx.objectStore(this.STORE_NAME);
                const req = store.clear();

                req.onsuccess = () => resolve();
                req.onerror = () => reject(req.error);
            });
        } catch (err) {
            console.error("EmbeddingCache: clear failed", err);
        }
    }
}
