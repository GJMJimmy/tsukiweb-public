import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { glob, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const serverUrl = ''

// List assets files to use from remote instead of fetching from local
const remotePaths: string[] = [
	'/res/flowchart-spritesheets',
	'^/static/[^/]+/CD_everafter',
	'^/static/[^/]+/CD_original',
	'^/static/[^/]+/CD_tsukibako',
	'^/static/[^/]+/images',
	'^/static/[^/]+/images_thumb',
	'^/static/[^/]+/scenes',
	'^/static/[^/]+/wave',
	'^/static/[^/]+/wave_pd',
]
const proxyRules: Record<string, any> = {}
remotePaths.forEach((path) => {
	proxyRules[path] = {
		target: serverUrl,
		changeOrigin: true,
	}
})

//______________________________offline manifest_______________________________

type OfflineGroup = 'shell' | 'small' | 'media'

type OfflineManifestFile = {
	url: string
	size: number
	group: OfflineGroup
	lang?: string
}

type OfflineManifest = {
	version: string
	generatedAt: string
	files: OfflineManifestFile[]
}

// Same media rules as src/offline/db.ts and public/sw.js
const MEDIA_DIRS = [
	'images', 'images_thumb', 'wave', 'wave_pd',
	'CD_everafter', 'CD_original', 'CD_tsukibako',
]
const MEDIA_DIR_RE = new RegExp(`^/static/[^/]+/(?:${MEDIA_DIRS.join('|')})(?:/|$)`)
const MEDIA_MIN_BYTES = 1024 * 1024
const SHELL_SCRIPT_RE = /\.(?:js|css|html|mjs)$/
const LANGUAGE_PATH_RE = /^\/static\/([^/]+)\//
const LANGUAGES_PATH = 'public/static/languages.json'

function isMediaUrl(url: string): boolean {
	return MEDIA_DIR_RE.test(url) || url.startsWith('/res/flowchart-spritesheets/')
}

function groupOf(url: string, size: number, withShell: boolean): OfflineGroup {
	if (withShell) {
		if (url === '/index.html' || url === '/manifest.json') return 'shell'
		if (url.startsWith('/assets/') && SHELL_SCRIPT_RE.test(url)) return 'shell'
	}
	if (size > MEDIA_MIN_BYTES || isMediaUrl(url)) return 'media'
	return 'small'
}

function isExcluded(url: string): boolean {
	return url === '/offline-assets.json'
		|| url === '/sw.js'
		|| url.endsWith('.map')
		|| url.includes('/sources/')
}

async function walkFiles(dir: string, prefix = '', out: OfflineManifestFile[] = []) {
	let entries
	try {
		entries = await readdir(dir, { withFileTypes: true })
	} catch {
		return out
	}
	for (const entry of entries) {
		const path = join(dir, entry.name)
		const url = `${prefix}/${entry.name}`
		if (entry.isDirectory()) {
			await walkFiles(path, url, out)
		} else if (entry.isFile()) {
			const info = await stat(path)
			out.push({ url, size: info.size, group: 'small' })
		}
	}
	return out
}

async function readLanguageIds(): Promise<Set<string>> {
	try {
		const raw: unknown = JSON.parse(await readFile(LANGUAGES_PATH, 'utf8'))
		if (raw && typeof raw === 'object') return new Set(Object.keys(raw))
	} catch {
		// no languages file: no /static/<id>/ path gets a lang tag
	}
	return new Set<string>()
}

async function buildOfflineManifest(root: string, withShell: boolean): Promise<OfflineManifest> {
	const [walked, languages, packageJson] = await Promise.all([
		walkFiles(root),
		readLanguageIds(),
		readFile('package.json', 'utf8'),
	])
	const pkg: unknown = JSON.parse(packageJson)
	const version = (pkg && typeof pkg === 'object' && 'version' in pkg)
		? String(pkg.version)
		: '0.0.0'
	const files = walked.filter((file) => !isExcluded(file.url))
	for (const file of files) {
		file.group = groupOf(file.url, file.size, withShell)
		const match = LANGUAGE_PATH_RE.exec(file.url)
		if (match && languages.has(match[1])) file.lang = match[1]
	}
	files.sort((a, b) => (a.url < b.url ? -1 : 1))
	return {
		version,
		generatedAt: new Date().toISOString(),
		files,
	}
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
	plugins: [
		react(),
		{
			name: 'exclude-sources-from-build',
			apply: 'build',
			async closeBundle() {
				for await (const sources of glob('dist/static/*/sources')) {
					await rm(sources, { recursive: true, force: true })
				}
			},
		},
		{
			// Declared after exclude-sources-from-build; /sources/ is excluded by
			// pattern too, so the walk is correct whatever the hook order turns out to be.
			name: 'offline-manifest',
			apply: 'build',
			async closeBundle() {
				const manifest = await buildOfflineManifest('dist', true)
				await writeFile('dist/offline-assets.json', JSON.stringify(manifest, null, '\t'))
			},
		},
		{
			name: 'offline-manifest-dev',
			apply: 'serve',
			configureServer(server) {
				server.middlewares.use((req, res, next) => {
					if (req.method !== 'GET' || !req.url) return next()
					if (req.url.split('?')[0] !== '/offline-assets.json') return next()
					buildOfflineManifest('public', false).then((manifest) => {
						res.setHeader('Content-Type', 'application/json; charset=utf-8')
						res.setHeader('Cache-Control', 'no-store')
						res.end(JSON.stringify(manifest))
					}, next)
				})
			},
		},
	],
	resolve: {
		tsconfigPaths: true
	},
	build: {
		chunkSizeWarningLimit: 1000,
	},
	server: {
		proxy: mode === 'proxy' ? proxyRules : {}
	}
}))