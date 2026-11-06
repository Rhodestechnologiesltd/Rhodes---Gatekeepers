import { api, ApiError } from '../lib/api';

/**
 * Persistent upload queue (IndexedDB). After a check-in is saved, its photos and documents are queued
 * here and sent one by one. If the network drops or the app is closed, the queue resumes later.
 * The server ignores an identical file sent twice, so retrying is always safe.
 */
export interface UploadJob {
  id: string;
  groupId: string;
  label: string; // for the progress list, e.g. "V1262 front of ID"
  body: { kind: string; visitId?: string; dataBase64: string; docNumber?: string; ocrText?: string };
  attempts: number;
  lastError?: string;
  createdAt: number;
}

const DB = 'rg-uploads';
const STORE = 'jobs';
let dbp: Promise<IDBDatabase> | null = null;
const memory = new Map<string, UploadJob>(); // fallback if IndexedDB is unavailable

function open(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const r = fn(db.transaction(STORE, mode).objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function all(): Promise<UploadJob[]> {
  try {
    return (await tx<UploadJob[]>('readonly', (s) => s.getAll())).sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    return [...memory.values()];
  }
}
async function put(job: UploadJob) {
  try {
    await tx('readwrite', (s) => s.put(job));
  } catch {
    memory.set(job.id, job);
  }
}
async function remove(id: string) {
  try {
    await tx('readwrite', (s) => s.delete(id));
  } catch {
    memory.delete(id);
  }
}

type Listener = (s: { pending: number; failed: number; done: Set<string>; running: boolean }) => void;
const listeners = new Set<Listener>();
const done = new Set<string>();
let running = false;
let lastCount = { pending: 0, failed: 0 };

function emit() {
  for (const l of listeners) l({ ...lastCount, done, running });
}
export function subscribeUploads(l: Listener): () => void {
  listeners.add(l);
  l({ ...lastCount, done, running });
  return () => listeners.delete(l);
}

export async function enqueue(jobs: Omit<UploadJob, 'attempts' | 'createdAt'>[]) {
  const now = Date.now();
  for (const [i, j] of jobs.entries()) await put({ ...j, attempts: 0, createdAt: now + i });
  void processQueue();
}

export async function pendingJobs(): Promise<UploadJob[]> {
  return all();
}

/** Send queued files. Stops at the first network failure and retries later. */
export async function processQueue(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const jobs = await all();
      lastCount = { pending: jobs.length, failed: jobs.filter((j) => j.attempts >= 3).length };
      emit();
      const next = jobs[0];
      if (!next) break;
      try {
        await api(`/visit-groups/${next.groupId}/files`, { body: next.body });
        await remove(next.id);
        done.add(next.id);
      } catch (e) {
        const err = e as ApiError;
        // Permanent errors (bad file, window closed, visit removed): drop the job so the queue is not blocked.
        if (err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 408 && err.status !== 429) {
          await remove(next.id);
          done.add(next.id);
          console.warn('Upload rejected', err.code);
          continue;
        }
        await put({ ...next, attempts: next.attempts + 1, lastError: err.message });
        break; // network/server issue: try again on the next tick
      }
    }
  } finally {
    running = false;
    const jobs = await all();
    lastCount = { pending: jobs.length, failed: jobs.filter((j) => j.attempts >= 3).length };
    emit();
  }
}

let timer: number | undefined;
/** Retry every 20 s and whenever the connection comes back. */
export function startUploadLoop() {
  if (timer) return;
  timer = window.setInterval(() => void processQueue(), 20_000);
  window.addEventListener('online', () => void processQueue());
  void processQueue();
}
