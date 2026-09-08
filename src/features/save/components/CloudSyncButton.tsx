import { Dispatch, useEffect, useState } from "react"
import { MdOutlineCloudDownload, MdOutlineCloudSync } from "react-icons/md"
import { toast } from "react-toastify"
import { Button, MessageContainer, Modal } from "@tsukiweb/common/ui-core"
import { APP_VERSION } from "app/utils/constants"
import { computeSaveHash, importGameDataFromJSON, settings } from "engine/settings"
import { savesManager } from "engine/savestates"

type Props = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'|'onContextMenu'>

// same storage keys as the OnscripterYuri web port, so both games
// share the server address and slot code once entered
const SERVER_KEY = "onsyuri_sync_server"
const SLOT_KEY = "onsyuri_sync_slot"

function buildPayload() {
	return {
		version: APP_VERSION,
		settings: settings.getDiff(),
		saveStates: savesManager.listSaves(),
	}
}

async function uploadSaves(server: string, slot: string) {
	try {
		const resp = await fetch(`${server}/save/${encodeURIComponent(slot)}`, {
			method: "POST",
			headers: {"Content-Type": "application/json"},
			body: JSON.stringify(buildPayload())
		})
		if (!resp.ok)
			throw new Error(`HTTP ${resp.status}`)
		// mark as backed up, same as the local export does
		const timeStamp = Date.now()
		settings.lastFullExport.date = timeStamp
		settings.lastFullExport.hash = await computeSaveHash()
		toast(`存档已上传到云端（${slot}）`, {toastId: "sync-upload", type: "success"})
	} catch (e) {
		toast(`上传失败: ${e instanceof Error ? e.message : String(e)}`, {toastId: "sync-upload-fail", type: "error"})
	}
}

async function downloadSaves(server: string, slot: string) {
	try {
		const resp = await fetch(`${server}/save/${encodeURIComponent(slot)}`)
		if (resp.status == 404) {
			toast(`云端没有 "${slot}" 的存档`, {toastId: "sync-download-404", type: "info"})
			return
		}
		if (!resp.ok)
			throw new Error(`HTTP ${resp.status}`)
		const json = await resp.json()
		await importGameDataFromJSON(json)
		toast(`存档已从云端恢复（${slot}）`, {toastId: "sync-download", type: "success"})
		// the title screen computes canResume on mount only — reload to reflect restored saves
		setTimeout(()=> window.location.reload(), 1500)
	} catch (e) {
		toast(`下载失败: ${e instanceof Error ? e.message : String(e)}`, {toastId: "sync-download-fail", type: "error"})
	}
}

const CloudSyncButton = (props?: Props) => {
	const [show, setShow] = useState<boolean>(false)
	const [server, setServer] = useState<string>("")
	const [slot, setSlot] = useState<string>("")

	useEffect(()=> {
		if (show) { // reload stored values each time the panel opens
			setServer(localStorage.getItem(SERVER_KEY) || "")
			setSlot(localStorage.getItem(SLOT_KEY) || "")
		}
	}, [show])

	const hide = () => setShow(false)

	const launch = (action: (server: string, slot: string)=>Promise<void>) => {
		const url = server.trim().replace(/\/+$/, "")
		const code = slot.trim()
		if (url == "") { toast("请先填写服务器链接", {toastId: "sync-no-server", type: "warning"}); return }
		if (code == "") { toast("请先输入存档码", {toastId: "sync-no-slot", type: "warning"}); return }
		localStorage.setItem(SERVER_KEY, url)
		localStorage.setItem(SLOT_KEY, code)
		setShow(false)
		action(url, code)
	}

	return (
		<>
			<button
				{...props}
				aria-label="save cloud sync"
				onContextMenu={e => e.preventDefault()}
				onClick={()=>setShow(true)}>
				<MdOutlineCloudSync aria-hidden />
			</button>

			<Modal show={show} onRequestClose={hide} className="save-sync-modal">
				<div className='title-modal'>
					<MessageContainer className="card sync-form">
						<span className="sync-title">云同步存档</span>
						<label className="sync-field">
							<span>服务器链接</span>
							<input
								value={server}
								onChange={e=>setServer(e.target.value)}
								placeholder="http://192.168.1.10:8765"
								spellCheck={false} />
						</label>
						<label className="sync-field">
							<span>存档码</span>
							<input
								value={slot}
								onChange={e=>setSlot(e.target.value)}
								placeholder="给这份存档起个名字"
								spellCheck={false} />
						</label>
						<div className="sync-buttons">
							<Button variant="select" onClick={()=>launch(uploadSaves)} nav-auto={1}>
								<MdOutlineCloudSync aria-hidden /> 上传到云端
							</Button>
							<Button variant="select" onClick={()=>launch(downloadSaves)} nav-auto={1}>
								<MdOutlineCloudDownload aria-hidden /> 从云端恢复
							</Button>
						</div>
					</MessageContainer>
				</div>
			</Modal>
		</>
	)
}

export default CloudSyncButton
