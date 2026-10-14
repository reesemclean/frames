// The image pipeline. The frame is too slow to decode 12 MP photos or blur
// anything, so every photo is shrunk once to fit 1280×800 with all of its
// metadata (EXIF and its GPS, XMP, comments, ICC) dropped, and portrait
// photos also get a pre-blurred, darkened 1280×800 backdrop as its own JPEG.
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { exifTaken } from './exif'

export const FIT = { width: 1280, height: 800 }

// libvips' operation cache holds decoded images for reuse we never make, and
// this is a ~1 GB box shared with other services.
sharp.cache(false)

export interface Processed {
  file: string
  backdrop: string | null
  width: number
  height: number
  taken: number | null
}

// Written under a name /photos/<name> can't match, renamed into place, so a
// frame never gets half a file; prune() sweeps any a crash leaves behind.
function writeAtomic(file: string, data: Buffer): void {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

/** A dark, soft fill behind a portrait photo. Blurring tiny and upscaling is
 * both cheap and smoother than blurring at full size. sharp runs one resize
 * per pipeline whatever the call order, hence three pipelines. */
export async function makeBackdrop(photo: Buffer): Promise<Buffer> {
  const small = await sharp(photo).resize(128, 80, { fit: 'cover', kernel: 'linear' }).png().toBuffer()
  const soft = await sharp(small).blur(4).modulate({ brightness: 0.55 }).png().toBuffer()
  return sharp(soft)
    .resize(FIT.width, FIT.height, { kernel: 'cubic' })
    .jpeg({ quality: 70, progressive: true })
    .toBuffer()
}

/** Decode, orient, shrink, and write `<base>.jpg` (+ `<base>-bg.jpg` for a
 * portrait) into `outDir`. Nothing of the original's metadata survives:
 * sharp writes none unless asked (no withMetadata/keepExif/keepIccProfile
 * here), and tests check the bytes. */
export async function processImage(data: Buffer, base: string, outDir: string, tz: string): Promise<Processed> {
  const meta = await sharp(data).metadata()
  const taken = exifTaken(meta.exif, tz)
  const { data: photo, info } = await sharp(data)
    .rotate() // EXIF orientation, before the tag is dropped
    .resize(FIT.width, FIT.height, { fit: 'inside', withoutEnlargement: true })
    // PNG/WebP transparency would otherwise come out black.
    .flatten({ background: '#1a1917' })
    .jpeg({ quality: 82, progressive: true })
    .toBuffer({ resolveWithObject: true })
  fs.mkdirSync(outDir, { recursive: true })
  const file = `${base}.jpg`
  writeAtomic(path.join(outDir, file), photo)
  let backdrop: string | null = null
  if (info.height > info.width) {
    backdrop = `${base}-bg.jpg`
    writeAtomic(path.join(outDir, backdrop), await makeBackdrop(photo))
  }
  return { file, backdrop, width: info.width, height: info.height, taken }
}
