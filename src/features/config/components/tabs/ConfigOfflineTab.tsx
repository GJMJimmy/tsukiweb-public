import { useEffect, useState } from "react"
import { Button, PageSection } from "@tsukiweb/common/ui-core"
import { dialog } from "@tsukiweb/common/ui-core/components/ModalPrompt"
import { useStrings } from "translation/lang"
import {
	offlineDownload,
	type OfflineCacheInfo,
	type OfflineDownloadState,
} from "offline/downloader"
import { offlineSupported } from "offline/register"
import { ConfigItem } from "../ConfigControls"
import "../../styles/offline.scss"

function mb(bytes: number): string {
	return (bytes / (1024 * 1024)).toFixed(1)
}

function percentOf(done: number, total: number): number {
	if (total <= 0) return 0
	return Math.min(100, Math.floor((done / total) * 100))
}

const ConfigOfflineTab = () => {
	const strings = useStrings()
	const [state, setState] = useState<OfflineDownloadState>(offlineDownload.state)
	const [cache, setCache] = useState<OfflineCacheInfo>(offlineDownload.cache)
	const [pending, setPending] = useState<{ count: number; bytes: number } | undefined>(undefined)
	const [controlled, setControlled] = useState<boolean>(false)

	// Follow the observable download state; the subscriptions are released on unmount.
	useEffect(() => {
		setState(offlineDownload.state)
		setCache(offlineDownload.cache)
		const stopState = offlineDownload.observeState(setState)
		const stopCache = offlineDownload.observeCache(setCache)
		return () => {
			stopState()
			stopCache()
		}
	}, [])

	// A service worker is required to actually serve the cached media offline.
	useEffect(() => {
		const serviceWorker = navigator.serviceWorker
		if (!serviceWorker) return
		const update = () => setControlled(serviceWorker.controller != null)
		update()
		serviceWorker.addEventListener("controllerchange", update)
		return () => serviceWorker.removeEventListener("controllerchange", update)
	}, [])

	// Refresh the stored size and the cost of what is still missing, on mount and
	// every time the download reaches another stage.
	useEffect(() => {
		let stale = false
		offlineDownload.refreshStats().catch(() => {})
		offlineDownload.estimate()
			.then(result => { if (!stale) setPending(result) })
			.catch(() => { if (!stale) setPending(undefined) })
		return () => { stale = true }
	}, [state.status])

	const available = offlineSupported
	const busy = state.status == 'scanning' || state.status == 'downloading'
	const stopped = state.status == 'paused' || state.status == 'cancelled'
	const percent = percentOf(state.bytesDone, state.bytesTotal)
	const quotaPercent = cache.quota > 0
		? Math.min(100, Math.round((cache.usage / cache.quota) * 100))
		: 0

	const statusLabel = state.status == 'error'
		? strings.config["offline-status-error"]
		: state.status == 'done'
			? strings.config["offline-status-done"]
			: strings.config["offline-status-idle"]

	const primaryLabel = busy
		? strings.config["offline-pause"]
		: state.status == 'paused'
			? strings.config["offline-resume"]
			: strings.config["offline-download"]

	const primaryAction = () => {
		if (busy)
			offlineDownload.pause()
		else if (state.status == 'paused')
			offlineDownload.resume()
		else
			offlineDownload.start()
	}

	const cancelDownload = () => {
		offlineDownload.cancel()
	}

	const clearCache = async () => {
		const confirmed = await dialog.confirm({
			text: strings.config["offline-clear-confirm"],
			labelYes: strings.yes,
			labelNo: strings.no,
			color: "#ab0000",
		})
		if (!confirmed) return
		try {
			await offlineDownload.clear()
		} catch (error) {
			console.error("offline: cannot clear the cache", error)
		}
	}

	return (
		<PageSection>
			<div className="sub">
				<div className="title">{strings.config["offline-title"]}</div>
				<p className="offline-help" data-sw={controlled ? "active" : "inactive"}>
					{available ? strings.config["offline-help"] : strings.config["offline-unsupported"]}
				</p>

				<ConfigItem label={strings.config["offline-status"]}>
					<div className="offline-value" data-state={state.status}>
						{available ? statusLabel : strings.config["offline-unsupported"]}
					</div>
				</ConfigItem>

				<ConfigItem label={strings.config["offline-cached"]}>
					<div className="offline-value">
						{mb(cache.bytes)} MB<span className="offline-count">{cache.count}</span>
					</div>
				</ConfigItem>

				<ConfigItem label={strings.config["offline-quota"]}>
					<div className="offline-value">
						{mb(cache.usage)} MB / {mb(cache.quota)} MB
						{quotaPercent > 0 && <span className="offline-count">{quotaPercent}%</span>}
					</div>
				</ConfigItem>

				<ConfigItem label={strings.config["offline-pending"]}>
					<div className="offline-value">
						{pending
							? <>{mb(pending.bytes)} MB<span className="offline-count">{pending.count}</span></>
							: <span className="offline-count">—</span>}
					</div>
				</ConfigItem>
			</div>

			<div className="offline-actions">
				<Button
					className="config-btn"
					onClick={primaryAction}
					disabled={!available}
					nav-auto={1}>
					{primaryLabel}
				</Button>
				{(busy || state.status == 'paused') && (
					<Button className="config-btn" onClick={cancelDownload} nav-auto={1}>
						{strings.config["offline-cancel"]}
					</Button>
				)}
				<Button
					className="config-btn erase"
					onClick={clearCache}
					disabled={busy || cache.count == 0}
					nav-auto={1}>
					{strings.config["offline-clear"]}
				</Button>
			</div>

			{(busy || stopped) && (
				<div
					className="offline-progress"
					role="progressbar"
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={percent}
					data-state={state.status}>
					<div
						className="offline-progress-fill"
						style={{ width: `${percent}%` }}
					/>
					<div className="offline-progress-label">
						<span>{percent}%</span>
						<span>{mb(state.bytesDone)} / {mb(state.bytesTotal)} MB</span>
					</div>
				</div>
			)}

			{state.status == 'error' && state.error && (
				<p className="offline-error">{state.error}</p>
			)}
		</PageSection>
	)
}

export default ConfigOfflineTab
