import sharp from "sharp";

export const THUMBNAIL_GENERATOR = "sharp-webp";
export const THUMBNAIL_GENERATOR_VERSION = 1;
export const THUMBNAIL_WIDTH = 640;

export interface ImageInfo {
  width: number;
  height: number;
  format: string;
}

/**
 * Validates an image by decoding its header (with a pixel limit against decompression bombs) and
 * renders a WebP thumbnail. Throws if the bytes are not a decodable image.
 */
export async function analyzeImage(
  bytes: Uint8Array,
  options: { maxInputPixels: number },
): Promise<{ info: ImageInfo; thumbnail: Buffer }> {
  const image = sharp(bytes, { limitInputPixels: options.maxInputPixels, failOn: "error" });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height || !metadata.format)
    throw new Error("not a decodable image");
  const thumbnail = await image
    .rotate()
    .resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true })
    .webp({ quality: 78 })
    .toBuffer();
  return {
    info: { width: metadata.width, height: metadata.height, format: metadata.format },
    thumbnail,
  };
}
