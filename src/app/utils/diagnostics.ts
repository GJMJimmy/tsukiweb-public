import { APP_VERSION } from "app/utils/constants"

/**
 * On-screen environment report, enabled by adding ?diag=1 to the url.
 *
 * Built for devices that cannot be attached to devtools (old Android WebViews):
 * it renders straight to <body>, so it survives a broken React tree, and it
 * refreshes while pages are navigated, so a black screen can be captured
 * together with the state that explains it.
 */

/** Probes the app own avif file, so the report answers what the game needs to decode. */
const AVIF_PROBE_SRC = import.meta.env.BASE_URL + "static/jp/images/bg/bg_01a.avif"

function support(name: string, test: () => boolean): string {
	try {
		return name + ": " + (test() ? "yes" : "NO")
	} catch {
		return name + ": throw"
	}
}

function featureLines(): string[] {
	return [
		support("color-mix", () => CSS.supports("color", "color-mix(in srgb, red 50%, blue)")),
		support("oklch", () => CSS.supports("color", "oklch(50% 0.1 200)")),
		support(":has", () => CSS.supports("selector(:has(a))")),
		support("aspect-ratio", () => CSS.supports("aspect-ratio", "1/1")),
		support("structuredClone", () => typeof (globalThis as any).structuredClone === "function"),
		support("Array.at", () => typeof ([] as any).at === "function"),
		support("Object.hasOwn", () => typeof (Object as any).hasOwn === "function"),
		support("Intl.Segmenter", () => typeof (Intl as any).Segmenter === "function"),
		support("roundRect", () => typeof (CanvasRenderingContext2D.prototype as any).roundRect === "function"),
		support("createImageBitmap", () => typeof (globalThis as any).createImageBitmap === "function"),
		support("ResizeObserver", () => typeof (globalThis as any).ResizeObserver === "function"),
		support("serviceWorker", () => "serviceWorker" in navigator),
	]
}

async function imageLines(): Promise<string[]> {
	const images = [...document.querySelectorAll("img")]
	const broken = images.filter(img => img.complete && img.naturalWidth === 0)
	const lines = ["imgs: " + images.length + ", broken: " + broken.length]
	for (const img of broken.slice(0, 6))
		lines.push("  broken: " + (img.getAttribute("src") ?? "").replace(location.origin, "").slice(0, 90))
	return lines
}

/** Resource timing is all an old engine gives us: an empty /static response explains a black scene. */
function resourceLines(): string[] {
	const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[]
	const statics = entries.filter(entry => entry.name.includes("/static/"))
	const empty = statics.filter(entry => entry.transferSize === 0 && entry.decodedBodySize === 0)
	const lines = ["/static requests: " + statics.length + ", empty: " + empty.length
		+ ", all resources: " + entries.length]
	for (const entry of empty.slice(0, 5))
		lines.push("  empty: " + entry.name.replace(location.origin, "").slice(0, 90))
	for (const entry of statics.slice(-5))
		lines.push("  last: " + (entry.name.split("/static/")[1] ?? "").slice(0, 55) + " size=" + entry.transferSize)
	return lines
}

function layoutLines(): string[] {
	const lines = ["viewport: " + innerWidth + "x" + innerHeight + " dpr " + devicePixelRatio + ", path " + location.pathname]
	const root = document.getElementById("root")
	const page = document.querySelector(".page") as HTMLElement | null
	if (root) {
		const style = getComputedStyle(root)
		const box = root.getBoundingClientRect()
		lines.push("#root: " + Math.round(box.width) + "x" + Math.round(box.height)
			+ " opacity " + style.opacity + " display " + style.display + " children " + root.children.length)
	}
	if (page) {
		const style = getComputedStyle(page)
		const box = page.getBoundingClientRect()
		lines.push((page.id || page.className) + ": " + Math.round(box.width) + "x" + Math.round(box.height)
			+ " opacity " + style.opacity + " visibility " + style.visibility)
		lines.push("page children: " + page.children.length + " ["
			+ [...page.children].map(c => (c as HTMLElement).id || c.className || c.tagName).slice(0, 8).join(", ") + "]")
	}
	lines.push("canvases: " + document.querySelectorAll("canvas").length)
	const middle = document.elementFromPoint(innerWidth / 2, innerHeight / 2)
	if (middle) {
		const style = getComputedStyle(middle)
		lines.push("at centre: " + middle.tagName.toLowerCase() + "." + String(middle.className).slice(0, 40))
		lines.push("  opacity " + style.opacity + ", bg " + style.backgroundImage.slice(0, 40)
			+ ", filter " + style.filter.slice(0, 30))
	}
	return lines
}

function panel(): HTMLElement {
	const existing = document.getElementById("diag-panel")
	if (existing) return existing
	const box = document.createElement("pre")
	box.id = "diag-panel"
	box.style.cssText = [
		"position:fixed", "inset:0 auto auto 0", "z-index:2147483647",
		"max-width:100vw", "max-height:100vh", "overflow:auto", "margin:0",
		"background:rgba(0,0,0,.82)", "color:#9fe8ff", "font:10px/1.35 ui-monospace,monospace",
		"padding:6px", "white-space:pre-wrap", "text-align:left", "pointer-events:none",
	].join(";")
	document.body.append(box)
	return box
}

export function installDiagnostics() {
	if (!new URLSearchParams(location.search).has("diag"))
		return

	const avif = new Image()
	let avifState = "avif decode: probing " + AVIF_PROBE_SRC.split("/").pop()
	avif.onload = () => { avifState = "avif decode: " + (avif.naturalWidth > 0 ? "yes (" + avif.naturalWidth + "px)" : "NO") }
	avif.onerror = () => { avifState = "avif decode: NO" }
	avif.src = AVIF_PROBE_SRC

	const update = async () => {
		const controller = navigator.serviceWorker?.controller
		const overlay = document.getElementById("error-overlay")?.innerText.trim().replace(/\s+/g, " ") ?? "none"
		const lines = [
			"tsukiweb v" + APP_VERSION + " diagnostics",
			"ua: " + navigator.userAgent.slice(0, 110),
			avifState,
			...featureLines(),
			"sw controller: " + (controller ? controller.scriptURL.split("/").pop() : "none"),
			"---",
			...layoutLines(),
			"---",
			...resourceLines(),
			"---",
			...(await imageLines()),
			"overlay errors: " + overlay.slice(0, 220),
		]
		panel().textContent = lines.join("\n")
	}

	void update()
	setInterval(() => void update(), 1500)
}
