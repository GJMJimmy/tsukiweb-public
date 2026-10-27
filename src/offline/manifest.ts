/**
 * Client for the build-time `/offline-assets.json` manifest.
 *
 * The manifest lists every deployed asset with its size and group, so the
 * download manager can estimate the cost of an offline copy before fetching.
 */

import { imageFormat } from "@tsukiweb/common/utils/images"
import { APP_VERSION } from "app/utils/constants"

export type OfflineManifestGroup = 'shell' | 'small' | 'media'

export type OfflineManifestFile = {
	url: string
	size: number
	group: OfflineManifestGroup
	lang?: string
}

export type OfflineManifest = {
	version: string
	generatedAt: string
	files: OfflineManifestFile[]
}

export const OFFLINE_MANIFEST_URL = '/offline-assets.json'

const GROUPS: readonly string[] = ['shell', 'small', 'media']
/** Formats the deploy step generates in several variants; the app requests a single one. */
const VARIANT_IMAGE_FORMATS: readonly string[] = ['avif', 'webp']

let manifestRequest: Promise<OfflineManifest> | undefined

function parseManifestFile(value: unknown, index: number): OfflineManifestFile {
	if (typeof value !== 'object' || value === null)
		throw Error(`Invalid offline manifest: entry #${index} is not an object`)
	const file = value as Record<string, unknown>
	if (typeof file.url !== 'string' || !file.url.length)
		throw Error(`Invalid offline manifest: entry #${index} has no "url"`)
	if (typeof file.size !== 'number' || !Number.isFinite(file.size) || file.size < 0)
		throw Error(`Invalid offline manifest: entry #${index} ("${file.url}") has no valid "size"`)
	if (typeof file.group !== 'string' || !GROUPS.includes(file.group))
		throw Error(`Invalid offline manifest: entry #${index} ("${file.url}") has an unknown "group"`)
	if (file.lang !== undefined && typeof file.lang !== 'string')
		throw Error(`Invalid offline manifest: entry #${index} ("${file.url}") has an invalid "lang"`)
	return {
		url: file.url,
		size: file.size,
		group: file.group as OfflineManifestGroup,
		...(file.lang === undefined ? {} : { lang: file.lang }),
	}
}

function parseManifest(value: unknown): OfflineManifest {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		throw Error(`Invalid offline manifest: expected an object at "${OFFLINE_MANIFEST_URL}"`)
	const manifest = value as Record<string, unknown>
	if (!Array.isArray(manifest.files))
		throw Error(`Invalid offline manifest: "files" is not an array`)
	return {
		version: typeof manifest.version === 'string' ? manifest.version : '',
		generatedAt: typeof manifest.generatedAt === 'string' ? manifest.generatedAt : '',
		files: manifest.files.map(parseManifestFile),
	}
}

async function requestManifest(): Promise<OfflineManifest> {
	// Bust the HTTP/SW cache whenever the app version changes.
	const url = `${OFFLINE_MANIFEST_URL}?v=${encodeURIComponent(APP_VERSION)}`
	let response: Response
	try {
		response = await fetch(url, { cache: 'no-store' })
	} catch (error) {
		throw Error(`Cannot load the offline manifest "${OFFLINE_MANIFEST_URL}": ${error}`)
	}
	if (!response.ok)
		throw Error(`Cannot load the offline manifest "${OFFLINE_MANIFEST_URL}" `
			+ `(${response.status} ${response.statusText})`)
	let body: unknown
	try {
		body = await response.json()
	} catch {
		throw Error(`Invalid offline manifest: "${OFFLINE_MANIFEST_URL}" is not valid JSON`)
	}
	return parseManifest(body)
}

/**
 * Fetch the manifest of the deployed assets, at most once per session.
 * A failed request is not cached, so the next call retries.
 */
export function loadManifest(): Promise<OfflineManifest> {
	if (!manifestRequest) {
		manifestRequest = requestManifest().catch(error => {
			manifestRequest = undefined
			throw error
		})
	}
	return manifestRequest
}

function hasActiveImageFormat(url: string): boolean {
	const extension = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase()
	// Only interchangeable image variants are filtered: icons and other
	// single-format assets (png, svg, ico) are always kept.
	if (extension === undefined || !VARIANT_IMAGE_FORMATS.includes(extension))
		return true
	return extension === imageFormat
}

/**
 * Files to cache for offline play: the shell group, the language-independent
 * documents and the active translation's own documents, plus its media when
 * `includeMedia` is set, minus the image variants the runtime never requests.
 */
export function selectTargets(
	manifest: OfflineManifest,
	{ language, includeMedia }: { language: string; includeMedia: boolean }
): OfflineManifestFile[] {
	return manifest.files.filter(file => {
		// lang-tagged files are only cached for the active translation;
		// switching language re-downloads that language.
		if (file.group !== 'shell' && file.lang !== undefined && file.lang !== language)
			return false
		if (file.group !== 'media')
			return true
		if (!includeMedia)
			return false
		return hasActiveImageFormat(file.url)
	})
}

export function totalBytes(files: OfflineManifestFile[]): number {
	return files.reduce((bytes, file) => bytes + file.size, 0)
}
