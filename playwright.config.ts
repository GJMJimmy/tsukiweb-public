import { defineConfig } from '@playwright/test'

/**
 * End-to-end tests against the production build, served by `vite preview`.
 *
 * Build first: `node node_modules/typescript/bin/tsc && node node_modules/vite/bin/vite.js build`.
 * The web server itself builds nothing: it only serves `dist`, so a spec always
 * exercises the same bytes a user would get.
 *
 * Prefer `npm run build`: it exports VITE_PACKAGE_VERSION (package.json's
 * version), which the app appends to its asset urls as "?v=<version>". A build
 * started with a bare `node .../vite.js build` has no version, so the version
 * busting of the offline cache is not exercised by the specs.
 *
 * Service workers need a secure context: 127.0.0.1 qualifies, a LAN IP does not.
 */
export const BASE_URL = 'http://127.0.0.1:4317'

export default defineConfig({
	testDir: 'tests',
	testMatch: '**/*.e2e.ts',
	// One browser, one worker: every spec asserts on shared IndexedDB / SW state.
	fullyParallel: false,
	forbidOnly: true,
	retries: 0,
	workers: 1,
	timeout: 180_000,
	expect: { timeout: 20_000 },
	reporter: [['list'], ['html', { open: 'never' }]],
	use: {
		baseURL: BASE_URL,
		// Deterministic default translation: the store picks by navigator.languages,
		// and the offline spec asserts on the en-mm strings.
		locale: 'en-US',
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
	},
	projects: [
		{
			// Only Chromium channel installed on the target machines: Microsoft Edge.
			name: 'chromium',
			use: { channel: 'msedge' },
		},
	],
	webServer: {
		command: 'node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4317 --strictPort',
		url: BASE_URL,
		reuseExistingServer: false,
		timeout: 60_000,
	},
})
