/**
 * Tsukihime offline service worker.
 *
 * Classic (non-module) worker: no imports, no build step, served from the app root.
 *
 * NOTE: keep DB name/store names and path rules in sync with src/offline/db.ts
 */

const DB_NAME = 'tsukiweb-offline'
const STORE = 'assets'
const META_STORE = 'meta'
const META_SCHEMA_KEY = 'schema'
const SCHEMA = 1
const PASSIVE_MAX_BYTES = 10 * 1024 * 1024

// Paths served from IndexedDB first (see src/offline/db.ts).
const PREFIXES = ['/static/', '/res/', '/icons/', '/assets/', '/offline-assets.json', '/manifest.json']

// Media rules shared with src/offline/db.ts: these are big and never stored passively.
const MEDIA_DIRS = ['images', 'images_thumb', 'wave', 'wave_pd', 'CD_everafter', 'CD_original', 'CD_tsukibako']
const MEDIA_DIR_RE = new RegExp('^/static/[^/]+/(?:' + MEDIA_DIRS.join('|') + ')(?:/|$)')

const SHELL_KEY = '/index.html'

const OFFLINE_HTML = [
	'<!DOCTYPE html>',
	'<html lang="en"><head><meta charset="utf-8">',
	'<meta name="viewport" content="width=device-width, initial-scale=1">',
	'<title>Tsukihime - offline</title>',
	'<style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;',
	'flex-direction:column;gap:1rem;background:#01001e;color:#e0e3ec;font-family:system-ui,Arial,sans-serif;',
	'text-align:center;padding:2rem}h1{font-weight:600;margin:0}button{padding:.6rem 1.4rem;border-radius:.5rem;',
	'border:1px solid #7f8dc0;background:#151a3a;color:inherit;font:inherit;cursor:pointer}</style>',
	'</head><body>',
	'<h1>Tsukihime</h1>',
	'<p>This page is not available offline yet.<br>Reconnect, or open the game once while online to cache it.</p>',
	'<button onclick="location.reload()">Retry</button>',
	'</body></html>',
].join('')

function isMediaPath(pathname) {
	return MEDIA_DIR_RE.test(pathname) || pathname.startsWith('/res/flowchart-spritesheets/')
}

//________________________________IndexedDB____________________________________

let dbPromise = null

function openDb() {
	return new Promise((resolve) => {
		let request
		try {
			request = indexedDB.open(DB_NAME, SCHEMA)
		} catch (error) {
			console.warn('[offline] cannot open the database', error)
			resolve(null)
			return
		}
		request.onupgradeneeded = () => {
			const db = request.result
			if (!db.objectStoreNames.contains(STORE))
				db.createObjectStore(STORE, { keyPath: 'url' })
			if (!db.objectStoreNames.contains(META_STORE))
				db.createObjectStore(META_STORE)
		}
		request.onsuccess = () => resolve(request.result)
		request.onerror = () => resolve(null)
		request.onblocked = () => resolve(null)
	})
}

function getDb() {
	if (!dbPromise) {
		dbPromise = openDb().then((db) => {
			if (!db) dbPromise = null
			return db
		})
	}
	return dbPromise
}

async function idbGet(key) {
	const db = await getDb()
	if (!db) return undefined
	return new Promise((resolve) => {
		try {
			const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
			request.onsuccess = () => resolve(request.result)
			request.onerror = () => resolve(undefined)
		} catch {
			resolve(undefined)
		}
	})
}

async function idbPut(entry) {
	const db = await getDb()
	if (!db) return
	await new Promise((resolve) => {
		try {
			const transaction = db.transaction(STORE, 'readwrite')
			transaction.objectStore(STORE).put(entry)
			transaction.oncomplete = () => resolve()
			transaction.onerror = () => resolve()
			transaction.onabort = () => resolve()
		} catch {
			resolve()
		}
	})
}

/** Drops every stored asset when the page-side schema moved on. */
async function syncSchema() {
	const db = await getDb()
	if (!db) return
	const marker = await new Promise((resolve) => {
		try {
			const request = db.transaction(META_STORE, 'readonly').objectStore(META_STORE).get(META_SCHEMA_KEY)
			request.onsuccess = () => resolve(request.result)
			request.onerror = () => resolve(undefined)
		} catch {
			resolve(undefined)
		}
	})
	if (marker === SCHEMA) return
	await new Promise((resolve) => {
		try {
			const transaction = db.transaction([STORE, META_STORE], 'readwrite')
			transaction.objectStore(STORE).clear()
			transaction.objectStore(META_STORE).put(SCHEMA, META_SCHEMA_KEY)
			transaction.oncomplete = () => resolve()
			transaction.onerror = () => resolve()
			transaction.onabort = () => resolve()
		} catch {
			resolve()
		}
	})
	console.info('[offline] asset schema changed, IndexedDB store purged')
}

//__________________________________serving____________________________________

function entryResponse(entry) {
	return new Response(entry.blob, {
		headers: {
			'Content-Type': entry.type || 'application/octet-stream',
			'Content-Length': String(entry.size ?? entry.blob.size),
			// The stored entry is a complete, seekable blob: say so, so an <audio>/<video>
			// element knows it may ask for a partial read instead of re-downloading it.
			'Accept-Ranges': 'bytes',
		},
	})
}

async function handleNavigation(event) {
	try {
		const response = await fetch(event.request)
		if (response.ok)
			event.waitUntil(storeNavigation(event.request.url, response.clone()))
		return response
	} catch {
		const entry = await idbGet(SHELL_KEY)
		if (entry && entry.blob) return entryResponse(entry)
		return new Response(OFFLINE_HTML, {
			status: 200,
			headers: { 'Content-Type': 'text/html; charset=utf-8' },
		})
	}
}

async function storeNavigation(url, response) {
	try {
		const pathname = new URL(url).pathname
		const blob = await response.blob()
		await idbPut({
			url: pathname === '/' ? SHELL_KEY : pathname,
			size: blob.size,
			type: 'text/html; charset=utf-8',
			ts: Date.now(),
			category: 'shell',
			blob,
		})
	} catch {
		// the shell stays usable without a stored document
	}
}

async function handleAsset(event, url) {
	const version = url.searchParams.get('v')
	const entry = await idbGet(url.pathname)
	if (entry && entry.blob && (!version || entry.version === version))
		return entryResponse(entry)

	const response = await fetch(event.request)
	if (response.ok && canStorePassively(url.pathname, response))
		event.waitUntil(storePassively(url.pathname, version, response.clone()))
	return response
}

/**
 * Parses a single `bytes=` range against `total`.
 *
 * Returns { start, end } (inclusive), the string 'unsatisfiable' when the range starts
 * beyond the payload, or null when the header is not one usable range (multi-range,
 * malformed, empty) and the network must answer instead.
 */
function parseRange(header, total) {
	const match = /^bytes\s*=\s*(.+)$/i.exec(String(header).trim())
	if (!match) return null
	const spec = match[1].trim()
	// A multi-range request is never reassembled here: hand it to the network untouched.
	if (!spec || spec.includes(',')) return null
	const parts = /^(\d*)-(\d*)$/.exec(spec)
	if (!parts) return null
	const [, rawStart, rawEnd] = parts
	if (!rawStart && !rawEnd) return null

	let start
	let end
	if (!rawStart) {
		// "bytes=-suffix": the trailing suffix bytes.
		const suffix = Number(rawEnd)
		if (!Number.isSafeInteger(suffix) || suffix <= 0) return null
		start = Math.max(0, total - suffix)
		end = total - 1
	} else {
		start = Number(rawStart)
		if (!Number.isSafeInteger(start)) return null
		if (!rawEnd) {
			end = total - 1
		} else {
			end = Number(rawEnd)
			if (!Number.isSafeInteger(end) || end < start) return null
			end = Math.min(end, total - 1)
		}
	}
	if (start >= total) return 'unsatisfiable'
	return { start, end }
}

/**
 * Answers a `Range` request with a 206 sliced out of the stored entry.
 *
 * Every <audio>/<video> request carries a Range header, so without this the media of an
 * explicit download is in IndexedDB but unplayable offline.
 *
 * The lookup is asynchronous, so the fallback path re-issues the same fetch inside
 * respondWith rather than returning bare: from the network's point of view that is the
 * old passthrough (an uncached or multi-range request still streams online), and this
 * path never stores anything -- media stays explicit-download only.
 */
async function handleRangeAsset(event, url) {
	const version = url.searchParams.get('v')
	const entry = await idbGet(url.pathname)
	if (!entry || !entry.blob || (version && entry.version !== version))
		return fetch(event.request)

	const total = entry.blob.size
	const range = parseRange(event.request.headers.get('Range') || '', total)
	if (range === null) return fetch(event.request)

	const headers = {
		'Content-Type': entry.type || 'application/octet-stream',
		'Accept-Ranges': 'bytes',
	}
	// Unsatisfiable (start >= total): answer 416 with the real payload size rather than
	// passing it through -- the bytes are here, so the network has nothing better to say.
	if (range === 'unsatisfiable') {
		headers['Content-Range'] = 'bytes */' + total
		return new Response(null, { status: 416, statusText: 'Range Not Satisfiable', headers })
	}

	const part = entry.blob.slice(range.start, range.end + 1)
	headers['Content-Range'] = 'bytes ' + range.start + '-' + range.end + '/' + total
	headers['Content-Length'] = String(part.size)
	return new Response(part, { status: 206, statusText: 'Partial Content', headers })
}

/** Media is never stored passively, and neither is anything above PASSIVE_MAX_BYTES. */
function canStorePassively(pathname, response) {
	if (isMediaPath(pathname)) return false
	if (response.type === 'opaque') return false
	const length = response.headers.get('Content-Length')
	return !length || Number(length) <= PASSIVE_MAX_BYTES
}

async function storePassively(pathname, version, response) {
	try {
		if (isMediaPath(pathname)) return
		// Invariant: a versioned passive write always records `version`, so both writers (page
		// downloader and this one) agree and the race cannot matter; an unversioned write must
		// never clobber a versioned entry, which would make it a permanent offline miss.
		if (!version) {
			const existing = await idbGet(pathname)
			if (existing && existing.version) return
		}
		const blob = await response.blob()
		if (blob.size > PASSIVE_MAX_BYTES) return
		const entry = {
			url: pathname,
			size: blob.size,
			type: blob.type || response.headers.get('Content-Type') || 'application/octet-stream',
			ts: Date.now(),
			category: 'small',
			blob,
		}
		if (version) entry.version = version
		await idbPut(entry)
	} catch {
		// a failed passive write must never break the response
	}
}

function isCacheablePath(pathname) {
	return PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix))
}

//__________________________________lifecycle__________________________________

self.addEventListener('install', (event) => {
	event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
	event.waitUntil((async () => {
		await self.clients.claim()
		await syncSchema()
	})())
})

self.addEventListener('fetch', (event) => {
	const request = event.request
	if (request.method !== 'GET') return

	let url
	try {
		url = new URL(request.url)
	} catch {
		return
	}
	if (url.origin !== self.location.origin) return

	if (request.mode === 'navigate') {
		event.respondWith(handleNavigation(event))
		return
	}
	if (!isCacheablePath(url.pathname)) return

	// An explicitly downloaded asset is rangeable from IndexedDB; anything else keeps the
	// old passthrough, so online streaming is untouched.
	if (request.headers.has('Range')) {
		event.respondWith(handleRangeAsset(event, url))
		return
	}

	event.respondWith(handleAsset(event, url))
})
