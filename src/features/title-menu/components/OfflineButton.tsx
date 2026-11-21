import { MdDownloadForOffline } from "react-icons/md"
import { useLocation } from "wouter"
import { useStrings } from "translation/lang"
import { SCREEN } from "app/utils/display"
import { ConfigTabs } from "features/config/components/ConfigView"

type Props = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'|'onContextMenu'>

/** Shortcut to the offline cache panel (Config > Offline). */
const OfflineButton = (props?: Props) => {
	const strings = useStrings()
	const [, navigate] = useLocation()
	return (
		<button
			{...props}
			aria-label={strings.config["tab-offline"]}
			onContextMenu={e => e.preventDefault()}
			onClick={() => navigate(`${SCREEN.CONFIG}?tab=${ConfigTabs.offline}`)}>
			<MdDownloadForOffline aria-hidden />
		</button>
	)
}

export default OfflineButton
