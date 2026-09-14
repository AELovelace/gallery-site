import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import path from 'node:path';
const execute = promisify(execFile);
export function createPreviews(dataDir, ffmpeg = process.env.GALLERY_FFMPEG || 'ffmpeg') { // Stores only reduced, metadata-free still previews outside the public asset tree.
  const directory = path.join(dataDir, 'previews');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const pending = new Map(), waiting = [];
  let active = 0;
  async function get(item) {
    const destination = path.join(directory, item.id + '.webp');
    if (existsSync(destination)) return destination;
    if (pending.has(item.id)) return pending.get(item.id);
    if (pending.size >= 32) return null; // Bounds the queue as well as decoder concurrency.
    const task = (async () => {
      if (active >= 2) await new Promise(resolve => waiting.push(resolve));
      else active += 1; // A completed decoder hands its slot directly to the next queued preview.
      const source = path.join(dataDir, 'uploads', item.filename);
      const temporary = destination + '.part';
      try {
        const input = item.kind === 'video' ? (await execute(ffmpeg, ['-nostdin','-v','error','-threads','1','-protocol_whitelist','file,pipe','-i',source,'-ss','0.1','-frames:v','1','-vf','scale=480:480:force_original_aspect_ratio=decrease','-f','image2pipe','-c:v','png','pipe:1'], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024, timeout: 15000, windowsHide: true })).stdout : source;
        await sharp(input, { limitInputPixels: 40000000 }).rotate().resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true }).webp({ quality: 55 }).timeout({ seconds: 15 }).toFile(temporary);
        await rename(temporary, destination);
        return destination;
      } catch { await unlink(temporary).catch(() => {}); return null; } // A failed decoder never falls back to disclosing the original upload.
      finally { pending.delete(item.id); const next = waiting.shift(); if (next) next(); else active -= 1; }
    })();
    pending.set(item.id, task);
    return task;
  }
  async function remove(id) { // Waits for an in-flight preview before removal so deleted media cannot leave a newly completed cache file behind.
    await pending.get(id);
    await unlink(path.join(directory, id + '.webp')).catch(() => {});
  }
  return { get, remove };
}
