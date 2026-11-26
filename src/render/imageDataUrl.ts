/** Decode an image file to a downscaled data URL small enough to persist. */
const IMAGE_MAX_PX = 1024;

export async function imageFileToDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, IMAGE_MAX_PX / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    bitmap.close();
    throw new Error('Canvas 2D is unavailable');
  }
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  // Keep alpha for PNG sources; everything else is a photographic albedo.
  const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  return canvas.toDataURL(type, 0.9);
}
