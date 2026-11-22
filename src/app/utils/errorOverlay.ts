/**
 * Shows uncaught errors and unhandled promise rejections in a small overlay.
 *
 * Render-time errors are already handled by the ErrorBoundary (see CrashScreen),
 * but a rejected promise leaves the page silently broken — the game window ends
 * up black with no hint of the cause. This keeps the reason on screen so it can
 * be reported by taking a screenshot, on devices without a devtools connection.
 */

const MAX_ENTRIES = 5
const seen = new Set<string>()

function describe(value: unknown): string {
	if (value instanceof Error) {
		const head = value.name && value.name !== 'Error' ? `${value.name}: ` : ''
		return head + (value.message || String(value))
	}
	if (typeof value === 'string') return value
	try {
		return JSON.stringify(value)
	} catch {
		return String(value)
	}
}

function mount(): HTMLElement {
	const existing = document.getElementById('error-overlay')
	if (existing) return existing

	const box = document.createElement('div')
	box.id = 'error-overlay'
	box.style.cssText = [
		'position:fixed', 'left:0', 'right:0', 'bottom:0', 'z-index:2147483647',
		'max-height:32vh', 'overflow:auto',
		'background:rgba(0,0,0,.86)', 'border-top:1px solid rgba(255,80,80,.6)',
		'color:#ff9a9a', 'font:11px/1.4 ui-monospace,monospace', 'padding:6px 28px 6px 10px',
		'white-space:pre-wrap', 'word-break:break-word', 'text-align:left',
	].join(';')

	const close = document.createElement('button')
	close.textContent = '×'
	close.setAttribute('aria-label', 'hide error overlay')
	close.style.cssText = [
		'position:absolute', 'top:2px', 'right:4px', 'width:20px', 'height:20px',
		'background:none', 'border:0', 'color:#ff9a9a', 'font:16px/1 monospace', 'cursor:pointer',
	].join(';')
	close.onclick = () => box.remove()
	box.append(close)

	document.body.append(box)
	return box
}

function show(kind: string, detail: unknown) {
	const text = `[${kind}] ${describe(detail)}`
	if (seen.has(text) || seen.size >= MAX_ENTRIES) return
	seen.add(text)

	const line = document.createElement('div')
	line.textContent = text
	line.style.cssText = 'padding:1px 0'
	mount().append(line)
	console.warn('error-overlay', text)
}

/** Media elements report their own failures (blocked autoplay, unsupported codec), which is noise here. */
const QUIET_TAGS = new Set(['AUDIO', 'VIDEO'])

/** Report a failed resource (image, script, stylesheet…) when the browser gives no Error object. */
function describeTarget(target: EventTarget | null): string | null {
	if (!(target instanceof HTMLElement) || QUIET_TAGS.has(target.tagName))
		return null
	if (!('src' in target || 'href' in target))
		return null
	const url = (target as HTMLImageElement).src || (target as HTMLAnchorElement).href
	return `<${target.tagName.toLowerCase()}> failed to load ${url}`
}

export function installErrorOverlay() {
	window.addEventListener('error', (event) => {
		const resource = describeTarget(event.target)
		if (resource) return show('resource', resource)
		show('error', event.error ?? event.message ?? 'unknown error')
	}, true)

	window.addEventListener('unhandledrejection', (event) => {
		show('promise', event.reason ?? 'unhandled rejection')
	})
}
