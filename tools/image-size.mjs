/**
 * Print the real pixel size of an image file, without any image library.
 * Handles JPEG (SOFn markers) and PNG (IHDR).
 */
import fs from 'node:fs';

function jpegSize(buf) {
  let offset = 2;
  while (offset < buf.length) {
    if (buf[offset] !== 0xff) { offset += 1; continue; }
    const marker = buf[offset + 1];
    const length = buf.readUInt16BE(offset + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof) {
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

export function imageSize(path) {
  const buf = fs.readFileSync(path);
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    return { ...jpegSize(buf), bytes: buf.length, format: 'jpeg' };
  }
  if (buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length, format: 'png' };
  }
  return { width: null, height: null, bytes: buf.length, format: 'unknown' };
}

if (process.argv[1].endsWith('image-size.mjs')) {
  for (const path of process.argv.slice(2)) {
    try {
      console.log(path.split(/[\\/]/).pop(), JSON.stringify(imageSize(path)));
    } catch (error) {
      console.log(path, 'ERR', error.message);
    }
  }
}