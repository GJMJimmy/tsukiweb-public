import { Dispatch, useState } from "react"
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

function getServer() : string|null {
	let url = localStorage.getItem(SERVER_KEY) || ""
	if (url == "") {
		url = prompt("同步服务器地址（例如 http://192.168.1.10:8765）") || ""
		url = url.trim().replace(/\/+$/, "")
		if (url == "") return null
		localStorage.setItem(SERVER_KEY, url)
	}
	return url
}

function getSlot() : string|null {
	let slot = prompt("存档码（在服务器上标识这份存档）", localStorage.getItem(SLOT_KEY) || "") || ""
	slot = slot.trim()
	if (slot == "") return null
	localStorage.setItem(SLOT_KEY, slot)
	return slot
}

async function uploadSaves() {
	const server = getServer()
	if (!server) return
	const slot = getSlot()
	if (!slot) return
	try {
		const content = {
			version: APP_VERSION,
			settings: settings.getDiff(),
			saveStates: savesManager.listSaves(),
		}
		const resp = await fetch(`${server}/save/${encodeURIComponent(slot)}`, {
			method: "POST",
			headers: {"Content-Type": "application/json"},
			body: JSON.stringify(content)
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

async function downloadSaves() {
	const server = getServer()
	if (!server) return
	const slot = getSlot()
	if (!slot) return
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
	const hide = () => setShow(false)

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
					<MessageContainer className="card actions">
						<Button variant="select" onClick={()=>{hide(); uploadSaves()}} nav-auto={1}>
							<MdOutlineCloudSync aria-hidden /> 上传存档到云端
						</Button>
						<Button variant="select" onClick={()=>{hide(); downloadSaves()}} nav-auto={1}>
							<MdOutlineCloudDownload aria-hidden /> 从云端恢复存档
						</Button>
					</MessageContainer>
				</div>
			</Modal>
		</>
	)
}

export default CloudSyncButton
