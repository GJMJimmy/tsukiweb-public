/**
 * Page-side IndexedDB store for offline assets.
 *
 * Keys are URL pathnames (no query string).
 * Keep the database name, store names and path rules in sync with public/sw.js.
 */

export type OfflineCategory = 'shell' | 'small' | 'media'

export type OfflineEntry = {
	url: string
	size: number
	type: string
	ts: number
	version?: string
	category: OfflineCategory
}

export type OfflineStats = {
	count: number
	bytes: number
	byCategory: Record<OfflineCategory, { count: number; bytes: number }>
}

export const OFFLINE_DB_NAME = 'tsukiweb-offline'
export const OFFLINE_STORE = 'assets'
export const OFFLINE_META_STORE = 'meta'
export const OFFLINE_SCHEMA = 1
export const PASSIVE_MAX_BYTES = 10 * 1024 * 1024

const MEDIA_DIRS = [
	'images', 'images_thumb', 'wave', 'wave_pd',
	'CD_everafter', 'CD_original', 'CD_tsukibako'
] as const
const MEDIA_DIR_RE = new RegExp(`^/static/[^/]+/(?:${MEDIA_DIRS.join('|')})(?:/|$)`)

/** Stored records are the manifest entry plus the payload itself. */
type StoredAsset = OfflineEntry & { blob: Blob }

/** Anything but a pathname is dropped: keys are origin- and query-less. */
export function assetKey(url: string): string {
	const base = typeof location !== 'undefined' ? location.origin : 'http://localhost'
	try {
		return new URL(url, base).pathname
	} catch {
		const cut = url.split(/[?#]/)[0]
		return cut.startsWith('/') ? cut : `/${cut}`
	}
}

/** Media rules of the manifest: big, language-scoped game assets and the flowchart. */
export function isMediaPath(url: string): boolean {
	const pathname = assetKey(url)
	return MEDIA_DIR_RE.test(pathname) || pathname.startsWith('/res/flowchart-spritesheets/')
}

//______________________________IndexedDB plumbing______________________________

let dbPromise: Promise<IDBDatabase | null> | null = null

function markSchema(db: IDBDatabase): void {
	try {
		const store = db.transaction(OFFLINE_META_STORE, 'readwrite').objectStore(OFFLINE_META_STORE)
		const current = store.get('schema')
		current.onsuccess = () => {
			// sw.js purges the store whenever this marker differs from OFFLINE_SCHEMA
			if (current.result === undefined) store.put(OFFLINE_SCHEMA, 'schema')
		}
	} catch {
		// an older database may lack the meta store; sw.js will migrate it
	}
}

function openDb(): Promise<IDBDatabase | null> {
	if (dbPromise) return dbPromise
	dbPromise = new Promise<IDBDatabase | null>((resolve) => {
		const fail = () => {
			dbPromise = null
			resolve(null)
		}
		if (typeof indexedDB === 'undefined') return fail()
		let request: IDBOpenDBRequest
		try {
			request = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_SCHEMA)
		} catch {
			return fail()
		}
		request.onupgradeneeded = () => {
			const db = request.result
			if (!db.objectStoreNames.contains(OFFLINE_STORE))
				db.createObjectStore(OFFLINE_STORE, { keyPath: 'url' })
			if (!db.objectStoreNames.contains(OFFLINE_META_STORE))
				db.createObjectStore(OFFLINE_META_STORE)
		}
		request.onsuccess = () => {
			markSchema(request.result)
			resolve(request.result)
		}
		request.onerror = fail
		request.onblocked = fail
	})
	return dbPromise
}

function toPromise<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		request.onsuccess = () => resolve(request.result)
		request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
	})
}

async function read<T>(what: string, run: (store: IDBObjectStore) => IDBRequest<T>, fallback: T): Promise<T> {
	const db = await openDb()
	if (!db) return fallback
	try {
		const store = db.transaction(OFFLINE_STORE, 'readonly').objectStore(OFFLINE_STORE)
		return await toPromise(run(store))
	} catch (error) {
		console.warn(`offline: cannot ${what}`, error)
		return fallback
	}
}

async function write(what: string, run: (store: IDBObjectStore) => void): Promise<void> {
	const db = await openDb()
	if (!db) throw new Error(`Offline storage unavailable (IndexedDB): cannot ${what}`)
	await new Promise<void>((resolve, reject) => {
		let transaction: IDBTransaction
		try {
			transaction = db.transaction(OFFLINE_STORE, 'readwrite')
			run(transaction.objectStore(OFFLINE_STORE))
		} catch (error) {
			reject(error instanceof Error ? error : new Error(`Offline storage error: cannot ${what}`))
			return
		}
		transaction.oncomplete = () => resolve()
		transaction.onerror = () => reject(
			transaction.error ?? new Error(`Offline storage error: cannot ${what}`))
		transaction.onabort = () => reject(
			transaction.error ?? new Error(`Offline storage transaction aborted: cannot ${what}`))
	})
}

//___________________________________public____________________________________

export async function putAsset(
	url: string,
	blob: Blob,
	opts?: { type?: string; version?: string; category?: OfflineCategory }
): Promise<void> {
	const key = assetKey(url)
	const record: StoredAsset = {
		url: key,
		size: blob.size,
		type: opts?.type || blob.type || 'application/octet-stream',
		ts: Date.now(),
		version: opts?.version,
		category: opts?.category ?? (isMediaPath(key) ? 'media' : 'small'),
		blob,
	}
	await write(`store ${key}`, (store) => store.put(record))
}

export async function getAsset(
	url: string
): Promise<{ blob: Blob; type: string; version?: string } | undefined> {
	const record = await read<StoredAsset | undefined>(
		`read ${url}`, (store) => store.get(assetKey(url)), undefined)
	if (!record?.blob) return undefined
	return { blob: record.blob, type: record.type, version: record.version }
}

export async function hasAsset(url: string): Promise<boolean> {
	const count = await read<number>(
		`check ${url}`, (store) => store.count(assetKey(url)), 0)
	return count > 0
}

export async function deleteAsset(url: string): Promise<void> {
	const key = assetKey(url)
	await write(`delete ${key}`, (store) => store.delete(key))
}

export async function clearAssets(): Promise<void> {
	await write('clear the store', (store) => store.clear())
}

export async function listAssets(): Promise<OfflineEntry[]> {
	const records = await read<StoredAsset[]>('list the store', (store) => store.getAll(), [])
	return records.map((record) => ({
		url: record.url,
		size: record.size,
		type: record.type,
		ts: record.ts,
		version: record.version,
		category: record.category,
	}))
}

export async function assetStats(): Promise<OfflineStats> {
	const stats: OfflineStats = {
		count: 0,
		bytes: 0,
		byCategory: {
			shell: { count: 0, bytes: 0 },
			small: { count: 0, bytes: 0 },
			media: { count: 0, bytes: 0 },
		},
	}
	for (const entry of await listAssets()) {
		const category = stats.byCategory[entry.category] ?? stats.byCategory.small
		stats.count += 1
		stats.bytes += entry.size
		category.count += 1
		category.bytes += entry.size
	}
	return stats
}

export async function storageEstimate(): Promise<{ usage: number; quota: number }> {
	try {
		const estimate = await navigator.storage?.estimate()
		return { usage: estimate?.usage ?? 0, quota: estimate?.quota ?? 0 }
	} catch {
		return { usage: 0, quota: 0 }
	}
}
