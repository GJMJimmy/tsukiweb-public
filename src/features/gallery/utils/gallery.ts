import type { GalleryImg } from "app/utils/types"
import { GALLERY_IMAGES } from "./gallery-data"
import { settings } from "engine/settings"

function getImg(imgName: string): GalleryImg & { name: string } {
	return { ...GALLERY_IMAGES[imgName], name: imgName }
}

function isInGallery(image: string): boolean {
	return Object.hasOwn(GALLERY_IMAGES, image)
}

/** Thumbnails (gallery, flowchart, saves, plus-disc) are hidden unless blur is off. */
function shouldBlur(image: string): boolean {
	return (GALLERY_IMAGES[image]?.h ?? false) && settings.eroBlurMode !== 'off'
}

/**
 * Graphics drawn inside the game are only hidden in the "all" mode: the default
 * hides the thumbnails without touching the scene the player is reading.
 */
function shouldBlurGraphics(image: string): boolean {
	return (GALLERY_IMAGES[image]?.h ?? false) && settings.eroBlurMode === 'all'
}

function getByGroup(group: GalleryImg["group"]): string[] {
	return Object.entries(GALLERY_IMAGES)
		.filter(([, img]) => img.group === group)
		.map(([key]) => key)
}

function getAlts(imgName: string): string[] {
	return Object.entries(GALLERY_IMAGES)
		.filter(([, img]) => img.altOf === imgName)
		.map(([key]) => key)
}

const isUnlocked = (img: string) =>
	settings.eventImages.includes(img)

const cg = {
	getImg,
	getByGroup,
	getAlts,
	shouldBlur,
	shouldBlurGraphics,
	isUnlocked,
	isInGallery,
}
export default cg
