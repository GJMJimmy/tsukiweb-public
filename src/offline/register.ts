/**
 * Service worker registration for the offline asset store.
 * The worker itself lives in public/sw.js (classic worker, no build step).
 */

export const offlineSupported: boolean =
	typeof navigator !== 'undefined' && 'serviceWorker' in navigator

export async function registerOfflineWorker(): Promise<void> {
	if (!offlineSupported) return
	// In dev the worker would cache HMR-transformed modules; opt in explicitly.
	if (import.meta.env.DEV && localStorage.getItem('offline_dev') !== '1') return
	try {
		await navigator.serviceWorker.register('/sw.js', { scope: '/' })
	} catch (error) {
		console.warn('offline: service worker registration failed', error)
	}
}
