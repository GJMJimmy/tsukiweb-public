/**
 * Offline download manager: caches the game files listed by the manifest into
 * IndexedDB (`src/offline/db.ts`) and exposes its progress to the UI.
 */

import { observe, unobserve } from "@tsukiweb/common/utils/Observer"
import { APP_VERSION } from "app/utils/constants"
import { settings } from "engine/settings"
import { strings } from "translation/lang"
import { assetKey, assetStats, clearAssets, listAssets, putAsset, storageEstimate } from "./db"
import { loadManifest, selectTargets, totalBytes, type OfflineManifestFile } from "./manifest"

export type OfflineStatus =
	'idle' | 'scanning' | 'downloading' | 'paused' | 'done' | 'error' | 'cancelled'

export type OfflineDownloadState = {
	status: OfflineStatus
	done: number
	total: number
	bytesDone: number
	bytesTotal: number
	currentUrl?: string
	error?: string
}

export type OfflineCacheInfo = {
	count: number
	bytes: number
	usage: number
	quota: number
}

const CONCURRENCY = 4
/** Keep a safety margin over the estimated size of the pending downloads. */
const QUOTA_FACTOR = 1.2

type StopReason = 'pause' | 'cancel'

let currentRun: Promise<void> | undefined
let activeController: AbortController | undefined
let stopReason: StopReason | undefined

function idleState(): OfflineDownloadState {
	return { status: 'idle', done: 0, total: 0, bytesDone: 0, bytesTotal: 0 }
}

function emptyCache(): OfflineCacheInfo {
	return { count: 0, bytes: 0, usage: 0, quota: 0 }
}

function updateState(patch: Partial<OfflineDownloadState>): void {
	offlineDownload.state = { ...offlineDownload.state, ...patch }
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message
	return String(error)
}

function mb(bytes: number): string {
	return (bytes / (1024 * 1024)).toFixed(1)
}

/** Translation id of the language currently played, used by `/static/<id>/` paths. */
function activeLanguage(): string {
	return strings.id || settings.language
}

/** Value of the `v` query parameter of a manifest url, when it carries one. */
function versionOf(url: string): string | undefined {
	if (typeof location === 'undefined') return undefined
	try {
		return new URL(url, location.href).searchParams.get('v') ?? undefined
	} catch {
		return undefined
	}
}

/**
 * Url the downloader requests for a manifest entry: the app itself fetches every
 * document as "<url>?v=<APP_VERSION>", so the page must use the same url or its
 * store write and the Service Worker's passive write record different versions.
 */
function requestUrl(url: string): string {
	if (!APP_VERSION || versionOf(url)) return url
	const version = `v=${encodeURIComponent(APP_VERSION)}`
	return url.includes('?') ? `${url}&${version}` : `${url}?${version}`
}

function isStopped(): boolean {
	return stopReason !== undefined
}

/**
 * List the targets that are not in the store yet, reporting the scan progress.
 * The store is read once (a single `getAll()`) instead of probing every entry.
 */
async function pendingFrom(targets: OfflineManifestFile[], force: boolean): Promise<OfflineManifestFile[]> {
	updateState({ total: targets.length, bytesTotal: totalBytes(targets) })
	if (force) return targets
	const stored = new Set((await listAssets()).map(entry => assetKey(entry.url)))
	const pending: OfflineManifestFile[] = []
	for (let index = 0; index < targets.length; index++) {
		if (isStopped()) break
		const file = targets[index]
		if (!stored.has(assetKey(file.url)))
			pending.push(file)
		updateState({ done: index + 1 })
	}
	return pending
}

async function execute({ force }: { force: boolean }): Promise<void> {
	const controller = new AbortController()
	activeController = controller
	stopReason = undefined
	let failure: Error | undefined

	try {
		updateState({ ...idleState(), status: 'scanning', error: undefined, currentUrl: undefined })

		const manifest = await loadManifest()
		const targets = selectTargets(manifest, { language: activeLanguage(), includeMedia: true })
		const pending = await pendingFrom(targets, force)

		if (isStopped()) return
		if (!pending.length) {
			updateState({
				status: 'done',
				done: targets.length,
				bytesDone: totalBytes(targets),
				error: undefined,
				currentUrl: undefined,
			})
			return
		}

		const pendingBytes = totalBytes(pending)
		updateState({ total: pending.length, done: 0, bytesDone: 0, bytesTotal: pendingBytes })

		const { usage, quota } = await storageEstimate()
		if (quota > 0 && quota - usage < QUOTA_FACTOR * pendingBytes) {
			throw Error(`Not enough storage space: ${mb(quota - usage)} MB available, `
				+ `${mb(QUOTA_FACTOR * pendingBytes)} MB needed to cache ${pending.length} files.`)
		}
		if (isStopped()) return

		updateState({ status: 'downloading' })

		let done = 0
		let bytesDone = 0
		let next = 0
		const download = async () => {
			while (next < pending.length && !isStopped() && !failure) {
				const file = pending[next++]
				try {
					updateState({ currentUrl: file.url })
					// Invariant: every entry stored here carries exactly the `?v` the app requests for it.
					const url = requestUrl(file.url)
					const response = await fetch(url, { signal: controller.signal })
					if (!response.ok)
						throw Error(`HTTP ${response.status} ${response.statusText}`)
					const blob = await response.blob()
					await putAsset(file.url, blob, {
						type: blob.type,
						version: versionOf(url) ?? (APP_VERSION || undefined),
						category: file.group,
					})
					done += 1
					bytesDone += blob.size
					updateState({ done, bytesDone })
				} catch (error) {
					if (isStopped()) return
					failure = failure ?? Error(`Cannot cache "${file.url}": ${errorMessage(error)}`)
					controller.abort()
					return
				}
			}
		}

		await Promise.all(
			Array.from({ length: Math.min(CONCURRENCY, pending.length) }, download))
		if (failure) throw failure

		if (isStopped()) return
		updateState({
			status: 'done',
			done: pending.length,
			bytesDone: pendingBytes,
			error: undefined,
			currentUrl: undefined,
		})
	} catch (error) {
		if (isStopped()) return
		updateState({ status: 'error', currentUrl: undefined, error: errorMessage(error) })
	} finally {
		if (activeController === controller) activeController = undefined
		if (stopReason === 'cancel')
			updateState({ status: 'cancelled', currentUrl: undefined })
		else if (stopReason === 'pause')
			updateState({ status: 'paused', currentUrl: undefined })
		stopReason = undefined
		currentRun = undefined
		refreshStats().catch(() => {})
	}
}

async function start(opts: { force?: boolean } = {}): Promise<void> {
	if (currentRun) return
	const run = execute({ force: opts.force ?? false })
	currentRun = run
	await run
}

/** Abort the in-flight requests; `start()` resumes from the stored files. */
function pause(): void {
	if (!currentRun) return
	stopReason = 'pause'
	activeController?.abort()
	updateState({ status: 'paused', currentUrl: undefined })
}

async function resume(): Promise<void> {
	while (currentRun) await currentRun
	return start()
}

function cancel(): void {
	if (!currentRun) {
		if (offlineDownload.state.status === 'paused')
			updateState({ status: 'cancelled', currentUrl: undefined, error: undefined })
		return
	}
	stopReason = 'cancel'
	activeController?.abort()
	updateState({ status: 'cancelled', currentUrl: undefined, error: undefined })
}

/** Delete every cached asset; a running download is cancelled first. */
async function clear(): Promise<void> {
	cancel()
	while (currentRun) await currentRun
	await clearAssets()
	offlineDownload.state = idleState()
	await refreshStats()
}

async function refreshStats(): Promise<void> {
	const [stats, storage] = await Promise.all([assetStats(), storageEstimate()])
	offlineDownload.cache = {
		count: stats.count,
		bytes: stats.bytes,
		usage: storage.usage,
		quota: storage.quota,
	}
}

/** Size of what a "download all" would still fetch, without downloading it. */
async function estimate(): Promise<{ count: number; bytes: number }> {
	const manifest = await loadManifest()
	const targets = selectTargets(manifest, { language: activeLanguage(), includeMedia: true })
	const stored = new Set((await listAssets()).map(entry => assetKey(entry.url)))
	const pending = targets.filter(file => !stored.has(assetKey(file.url)))
	return { count: pending.length, bytes: totalBytes(pending) }
}

function observeState(callback: (state: OfflineDownloadState) => void): VoidFunction {
	const listener = (state: OfflineDownloadState) => callback(state)
	observe(offlineDownload, 'state', listener)
	return () => unobserve(offlineDownload, 'state', listener)
}

function observeCache(callback: (cache: OfflineCacheInfo) => void): VoidFunction {
	const listener = (cache: OfflineCacheInfo) => callback(cache)
	observe(offlineDownload, 'cache', listener)
	return () => unobserve(offlineDownload, 'cache', listener)
}

export const offlineDownload = {
	state: idleState(),
	cache: emptyCache(),
	observeState,
	observeCache,
	start,
	pause,
	resume,
	cancel,
	clear,
	refreshStats,
	estimate,
}
