import { test, expect, type Locator, type Page } from '@playwright/test'

/**
 * Offline end-to-end proof, against the production build served by "vite preview":
 * cache everything from Config -> Offline, cut the network, reload, and the game
 * UI still boots -- from IndexedDB, through the service worker.
 *
 * Nothing is mocked: a real service worker, a real IndexedDB store and a real
 * browser-level network cutoff (context.setOffline).
 */

const ORIGIN = 'http://127.0.0.1:4317'
const CONFIG_URL = '/config?tab=offline'

const DB_NAME = 'tsukiweb-offline'
const STORE = 'assets'
/** Shell and translation documents the offline copy must contain. */
const REQUIRED_KEYS = ['/index.html', '/static/en-mm/lang.json']

/**
 * Heavy media of the original assets: the directory tree every translation
 * inherits its image/audio paths from (src/assets/lang/default.json), so an
 * en-mm player must have it cached too.
 */
const JP_MEDIA_RE = /^\/static\/jp\/(?:images|images_thumb|wave|wave_pd|CD_[^/]+)\//

/** The download is ~96 MB of media on a checkout with the full assets: give it room. */
const DOWNLOAD_TIMEOUT = 180_000

type StoredAsset = { url: string; size: number; type: string; category: string; version: string | null }

/** A same-origin app-shell script or translation document (never game media). */
function isWatchedUrl(url: string): boolean {
	let parsed: URL
	try {
		parsed = new URL(url)
	} catch {
		return false
	}
	if (parsed.origin !== ORIGIN) return false
	const path = parsed.pathname
	if (path.startsWith('/assets/')) return path.endsWith('.js')
	if (path.startsWith('/static/')) return path.endsWith('.json')
	return false
}

/**
 * A document the app itself fetches as "<url>?v=<version>" (see
 * tsukiweb-common/src/translation/langStore.ts and src/engine/script-loader.ts):
 * the offline copy must be stored under that very same version, or the worker
 * answers the versioned request from the unversioned entry and it is a miss.
 */
function isVersionedDocument(pathname: string): boolean {
	if (/^\/static\/.*\.json$/.test(pathname)) return true
	if (pathname === '/static/logic.txt') return true
	return /^\/static\/.+\/scenes\/[^/]+\.txt$/.test(pathname)
}

/** Read the whole offline store straight from the page. */
function readStoredAssets(page: Page): Promise<StoredAsset[]> {
	return page.evaluate(
		async ([dbName, storeName]) => {
			const db = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open(dbName)
				request.onsuccess = () => resolve(request.result)
				request.onerror = () => reject(request.error ?? new Error('cannot open ' + dbName))
			})
			try {
				const records = await new Promise<any[]>((resolve, reject) => {
					const request = db.transaction(storeName, 'readonly').objectStore(storeName).getAll()
					request.onsuccess = () => resolve(request.result as any[])
					request.onerror = () => reject(request.error)
				})
				return records.map((record) => ({
					url: String(record.url),
					size: Number(record.size),
					type: String(record.type),
					category: String(record.category),
					version: record.version === undefined ? null : String(record.version),
				}))
			} finally {
				db.close()
			}
		},
		[DB_NAME, STORE] as const
	)
}

/** A ConfigItem row of the offline panel, located by its label. */
function row(panel: Locator, label: string): Locator {
	return panel.locator('.config').filter({ has: panel.page().locator('.config-name', { hasText: label }) })
}

function value(panel: Locator, label: string): Locator {
	return row(panel, label).locator('.offline-value')
}

function flatten(text: string): string {
	return text.replace(/\s+/g, ' ').trim()
}

/** Wait until a service worker controls the page; reload once if claim() was late. */
async function waitForController(page: Page): Promise<void> {
	const controlled = await page.evaluate(async () => {
		await navigator.serviceWorker.ready
		if (navigator.serviceWorker.controller) return true
		return new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => resolve(navigator.serviceWorker.controller != null), 5_000)
			navigator.serviceWorker.addEventListener('controllerchange', () => {
				clearTimeout(timer)
				resolve(true)
			}, { once: true })
		})
	})
	if (controlled) return
	// The worker's clients.claim() did not land before the page loaded: one reload picks it up.
	await page.reload({ waitUntil: 'load' })
	await page.waitForFunction(() => navigator.serviceWorker.controller != null, undefined, {
		timeout: 20_000,
	})
}
test('Download all survives a full offline reload', async ({ page, context }, testInfo) => {
	// The media of the whole translation is downloaded here (~96 MB on a checkout
	// with the full assets), so the global 180 s per-test budget is not enough.
	test.setTimeout(5 * 60_000)

	//__________________________________online___________________________________

	// The version every cached document must carry: the one the app itself puts in its
	// own "<url>?v=<version>" requests (see tsukiweb-common/src/translation/langStore.ts).
	// Never hardcoded here -- and an unversioned build (a bare `vite build` without
	// VITE_PACKAGE_VERSION) requests an empty "?v=", which the check below must tolerate.
	let requestedVersion: string | undefined
	page.on('request', (request) => {
		if (requestedVersion !== undefined) return
		let url: URL
		try {
			url = new URL(request.url())
		} catch {
			return
		}
		if (url.origin !== ORIGIN || url.pathname !== '/static/languages.json') return
		// An unversioned build (no VITE_PACKAGE_VERSION) requests the bare "?v=", which
		// carries no version: keep waiting for a real one instead of comparing against "".
		const version = url.searchParams.get('v')
		if (version) requestedVersion = version
	})

	await page.goto(CONFIG_URL)

	// (b) A service worker must control the page before anything is cached.
	await waitForController(page)
	expect(
		await page.evaluate(() => navigator.serviceWorker.controller != null),
		'the page should be controlled by /sw.js'
	).toBe(true)

	// (c) The Offline tab renders its real en-mm strings (lang.json resolved).
	const panel = page.locator('#config')
	await expect(panel.locator('.sub > .title')).toHaveText('Offline play')
	await expect(panel.locator('.offline-help')).toContainText(
		'Keep a copy of the game on this device so it still works without a connection'
	)
	await expect(panel.locator('.offline-help')).toHaveAttribute('data-sw', 'active')
	await expect(value(panel, 'Status')).toHaveText('Ready')
	await expect(row(panel, 'Cached offline data')).toContainText('Cached offline data')
	await expect(row(panel, 'Left to download')).toContainText('Left to download')

	const downloadButton = page.getByRole('button', { name: 'Download all' })
	await expect(downloadButton).toBeEnabled()

	// (d) The pending size shown before the download, then "Download all".
	const pendingValue = value(panel, 'Left to download')
	await expect(pendingValue).not.toHaveText('—')
	const pendingText = flatten(await pendingValue.innerText())
	const pendingCount = Number(flatten(
		await row(panel, 'Left to download').locator('.offline-count').innerText()
	))
	expect(pendingCount, 'pending count should be > 0 (the panel showed "' + pendingText + '")').toBeGreaterThan(0)

	await downloadButton.click()

	const status = value(panel, 'Status')
	try {
		// The terminal state, then the en-mm label of config["offline-status-done"].
		await expect(status).toHaveAttribute('data-state', 'done', { timeout: DOWNLOAD_TIMEOUT })
		await expect(status).toHaveText('Complete')
	} catch {
		const errorField = panel.locator('.offline-error')
		const errorText = (await errorField.count()) ? flatten(await errorField.innerText()) : '(none)'
		const progress = panel.locator('.offline-progress')
		const progressText = (await progress.count()) ? flatten(await progress.innerText()) : '(no progress bar)'
		throw new Error(
			'the download never reached "Complete".\n' +
			'status="' + flatten(await status.innerText()) + '"' +
			' (data-state=' + (await status.getAttribute('data-state')) + ')\n' +
			'error=' + errorText + '\n' +
			'progress=' + progressText + '\n' +
			'pending before the download: ' + pendingText + '\n' +
			'panel text:\n' + (await panel.innerText()).trim()
		)
	}

	// (e) The IndexedDB store really holds the app shell and the documents.
	const assets = await readStoredAssets(page)
	const keys = assets.map((asset) => asset.url)
	const bytes = assets.reduce((total, asset) => total + asset.size, 0)

	expect(bytes, 'cached byte count should be > 0; keys: ' + keys.join(', ')).toBeGreaterThan(0)
	for (const required of REQUIRED_KEYS) {
		expect(keys, DB_NAME + '/' + STORE + ' should hold ' + required + '; keys: ' + keys.join(', '))
			.toContain(required)
	}
	const scripts = keys.filter((key) => /^\/assets\/.+\.js$/.test(key))
	expect(
		scripts.length,
		DB_NAME + '/' + STORE + ' should hold at least one /assets/*.js entry; keys: ' + keys.join(', ')
	).toBeGreaterThan(0)
	// The panel refreshes its stats asynchronously: poll instead of racing it.
	await expect
		.poll(
			async () => Number(flatten(
				await row(panel, 'Cached offline data').locator('.offline-count').innerText()
			)),
			{ message: 'the panel should report the cached file count' }
		)
		.toBe(assets.length)

		// Every cached document must carry the version the app requests for it: a
		// "/static/**.json", "/static/logic.txt" or "/static/**/scenes/*.txt" stored unversioned
		// (or under another version) is a permanent offline miss -- the app asks for
		// "<url>?v=<version>" and the worker only answers a versioned request from an
		// entry whose version matches (public/sw.js, handleAsset).
		const versionHistogram = new Map<string, number>()
		for (const asset of assets) {
			const bucket = asset.version ?? '(unversioned)'
			versionHistogram.set(bucket, (versionHistogram.get(bucket) ?? 0) + 1)
		}
		const histogram = JSON.stringify(Object.fromEntries(versionHistogram))
		const documents = assets.filter((asset) => isVersionedDocument(asset.url))
		const describe = (asset: StoredAsset) => asset.url + ' -> ' + (asset.version ?? '(unversioned)')

		const expectedVersion = requestedVersion
		if (expectedVersion === undefined) {
			// Unversioned build: nothing to compare against, so annotate instead of failing.
			testInfo.annotations.push({
				type: 'offline-version-skipped',
				description: 'no "/static/languages.json?v=..." request was ever made (unversioned build: '
					+ 'VITE_PACKAGE_VERSION is empty), so the stored document versions cannot be checked; '
					+ 'version histogram: ' + histogram,
			})
			console.log('[offline] version check SKIPPED (unversioned build); version histogram: ' + histogram)
		} else {
			expect(
				documents.length,
				'the store should hold at least one "/static/**.json", "/static/logic.txt" or ' +
					'"/static/**/scenes/*.txt" document; keys: ' + keys.join(', ')
			).toBeGreaterThan(0)
			const offenders = documents.filter((asset) => asset.version !== expectedVersion).map(describe)
			expect(
				offenders,
				'every cached document must carry the version the app requests (v=' + expectedVersion + '); '
					+ 'offending url -> version: ' + (offenders.length ? '\n' + offenders.join('\n') : '(none)')
					+ '\ncached documents: ' + documents.map(describe).join(', ')
					+ '\nversion histogram of the whole store: ' + histogram
			).toEqual([])
			testInfo.annotations.push({
				type: 'offline-versions',
				description: documents.length + ' cached document(s) carry v=' + expectedVersion +
					'; version histogram: ' + histogram,
			})
			console.log('[offline] ' + documents.length + ' cached document(s) carry v=' + expectedVersion +
				'; version histogram: ' + histogram)
		}

	await testInfo.attach('indexeddb-assets.json', {
		body: JSON.stringify({
			bytes,
			count: assets.length,
			keys,
			versions: Object.fromEntries(versionHistogram),
			documents: documents.map((asset) => ({ url: asset.url, version: asset.version })),
		}, null, '\t'),
		contentType: 'application/json',
	})
	console.log(
		'[offline] cached ' + assets.length + ' files, ' + (bytes / (1024 * 1024)).toFixed(2) + ' MB; ' +
		'pending before download: ' + pendingText + ' (' + pendingCount + ' files); ' +
		'shell scripts: ' + scripts.join(', ')
	)

	//_________________________________offline___________________________________

	// (g) Watch same-origin app-shell scripts and translation documents only.
	const failures: string[] = []
	page.on('requestfailed', (request) => {
		if (isWatchedUrl(request.url()))
			failures.push('request failed: ' + request.url() + ' (' + (request.failure()?.errorText ?? 'unknown') + ')')
	})
	page.on('response', (response) => {
		if (isWatchedUrl(response.url()) && response.status() >= 400)
			failures.push('HTTP ' + response.status() + ': ' + response.url())
	})

	await context.setOffline(true)
	// Evidence that the cutoff is real and not just a cache hit: an uncached path
	// is not handled by the worker and must fail at the network layer.
	const networkIsDead = await page.evaluate(async () => {
		try {
			await fetch('/offline-probe-' + Date.now(), { cache: 'no-store' })
			return false
		} catch {
			return true
		}
	})
	expect(networkIsDead, 'context.setOffline(true) should make the network unusable').toBe(true)

	// (f) Reload the very same URL with no network at all.
	await page.reload({ waitUntil: 'load' })
	await expect(page.locator('#config')).toBeVisible()
	await expect(panel.locator('.sub > .title')).toHaveText('Offline play')
	await expect(panel.locator('.offline-help')).toHaveAttribute('data-sw', 'active')

	await expect(page.locator('#root')).toBeVisible()
	const rootText = flatten(await page.locator('#root').innerText())
	expect(rootText.length, '#root should have visible content offline, got "' + rootText + '"')
		.toBeGreaterThan(0)
	expect(
		await page.evaluate(() => navigator.serviceWorker.controller != null),
		'the offline page should still be controlled by the service worker'
	).toBe(true)

	// And the title screen: a second offline navigation, served by the worker's
	// navigation fallback (/index.html out of IndexedDB).
	await page.goto('/', { waitUntil: 'load' })
	await expect(page.locator('#title-menu')).toBeVisible()
	await expect(page.getByRole('button', { name: 'New Game' })).toBeVisible()
	expect(
		await page.evaluate(() => navigator.serviceWorker.controller != null),
		'the offline title screen should still be controlled by the service worker'
	).toBe(true)

	expect(
		failures,
		'no same-origin app-shell script or translation document may fail offline:\n' + failures.join('\n')
	).toEqual([])

	console.log('[offline] offline boot ok: the config tab and the title menu both rendered from IndexedDB')

	//_____________________(h) How far does the engine get?______________________
	// Still informational: whatever the engine reports is logged, never asserted.
	// The one acceptance signal for the media selection is reported explicitly:
	// with the original (jp) assets cached, image and audio requests must be
	// served from IndexedDB instead of failing.
	const jpMediaServed = new Set<string>()
	const jpMediaFailed: string[] = []
	const jpMediaPath = (url: string): string | undefined => {
		try {
			const { pathname } = new URL(url)
			return JP_MEDIA_RE.test(pathname) ? pathname : undefined
		} catch {
			return undefined
		}
	}

	// How the cached media answers once the network is gone: an <audio>/<video>
	// element sends Range requests, which public/sw.js answers with a 206 slice
	// of the stored blob, while a plain request is served whole from IndexedDB.
	const mediaProbe = await page.evaluate(async (cachedKeys: string[]) => {
		const probe = async (url: string) => {
			const plain = await fetch(url).then(
				async (response) => ({ status: response.status, bytes: (await response.blob()).size }),
				() => ({ status: 'failed', bytes: 0 }))
			const ranged = await fetch(url, { headers: { Range: 'bytes=0-1' } })
				.then((response) => response.status, () => 'failed')
			return { url, plain, ranged }
		}
		const first = (pattern: RegExp) => cachedKeys.find((key) => pattern.test(key))
		const image = first(/^\/static\/jp\/images\//)
		const audio = first(/^\/static\/jp\/CD_\w+\/track01\.webm$/)
		const probes = []
		if (image) probes.push(await probe(image))
		if (audio) probes.push(await probe(audio))
		return probes
	}, keys)
	for (const probe of mediaProbe)
		console.log('[offline] cached media ' + probe.url + ': plain request -> ' + probe.plain.status +
			' (' + probe.plain.bytes + ' bytes), Range request -> ' + probe.ranged)

	// Only what the engine itself requests from here on (the probe above is over).
	page.on('response', (response) => {
		const pathname = jpMediaPath(response.url())
		if (pathname !== undefined && response.status() < 400) jpMediaServed.add(pathname)
	})
	page.on('requestfailed', (request) => {
		const pathname = jpMediaPath(request.url())
		if (pathname !== undefined) jpMediaFailed.push(pathname)
	})

	const engineLog: string[] = []
	const collect = (line: string) => {
		if (engineLog.length < 40) engineLog.push(line)
	}
	page.on('console', (message) => {
		if (message.type() === 'error') collect('console.error: ' + message.text())
	})
	page.on('pageerror', (error) => collect('pageerror: ' + error.message))
	page.on('requestfailed', (request) => {
		if (!isWatchedUrl(request.url())) collect('requestfailed: ' + request.url())
	})

	let observation: string
	try {
		await page.getByRole('button', { name: 'New Game' }).click()
		await page.waitForTimeout(8_000)
		const url = page.url().replace(ORIGIN, '')
		const visible = flatten(await page.locator('#root').innerText()).slice(0, 400)
		observation =
			'clicked "New Game" offline -> url ' + url + '; ' +
			'#root text: ' + (visible || '(empty)') + '; ' +
			engineLog.length + ' error line(s)'
	} catch (error) {
		observation = '"New Game" could not be clicked offline: ' + String(error).split('\n')[0]
	}

	const mediaSummary = jpMediaServed.size + ' /static/jp/{images,wave,CD_}/ request(s) served offline, '
		+ (jpMediaFailed.length
			? jpMediaFailed.length + ' FAILED: ' + [...new Set(jpMediaFailed)].join(', ')
			: 'none failed')
	observation += '; jp media: ' + mediaSummary

	console.log('[offline] ' + observation)
	for (const line of engineLog) console.log('[offline]   ' + line)
	testInfo.annotations.push({ type: 'offline-new-game', description: observation })
	if (engineLog.length)
		testInfo.annotations.push({ type: 'offline-errors', description: engineLog.join('\n') })
})
