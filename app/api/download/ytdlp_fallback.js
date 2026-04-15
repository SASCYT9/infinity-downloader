import os from 'os';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const YTDLP_LINUX_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
const YTDLP_WIN_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';

export async function fetchDirectYoutubeUrl(url, mode) {
  try {
    const isWin = os.platform() === 'win32';
    const binName = isWin ? 'yt-dlp-standalone.exe' : 'yt-dlp-linux-standalone';
    
    // Use /tmp for serverless environments (Vercel allows writable /tmp up to 500MB)
    const tmpDir = os.tmpdir();
    const binPath = path.join(tmpDir, binName);

    // 1. Download yt-dlp binary if it doesn't exist in /tmp
    if (!fs.existsSync(binPath)) {
      console.log('yt-dlp missing, downloading to /tmp...');
      const downloadUrl = isWin ? YTDLP_WIN_URL : YTDLP_LINUX_URL;
      const res = await fetch(downloadUrl);
      if (!res.ok) throw new Error('Failed to download yt-dlp binary');
      const buf = await res.arrayBuffer();
      fs.writeFileSync(binPath, Buffer.from(buf));
      
      // Make it executable on Linux
      if (!isWin) {
        fs.chmodSync(binPath, '755');
      }
    }

    // 2. Determine format based on requested mode (audio vs video)
    // For audio on Youtube, bestaudio extracts m4a without ffmpeg (super fast)
    // For video, best[ext=mp4] gets a single file with both video+audio (no ffmpeg needed)
    let format = 'bestaudio';
    if (mode === 'auto') {
      // Get the best pre-merged mp4 (usually up to 720p/1080p if available directly, to avoid ffmpeg muxing)
      format = 'best[ext=mp4]/best'; 
    }

    console.log(`Executing yt-dlp for ${url} with format ${format}`);
    // 3. Execute yt-dlp synchronously (takes ~2 seconds)
    // -j outputs JSON info
    // --no-warnings prevents stderr spam breaking json parsing
    const outputBuffer = execFileSync(binPath, [
      '-j', 
      '--no-warnings',
      '--extractor-args', 'youtube:player_client=tv_embedded',
      '-f', format, 
      url
    ], { 
      maxBuffer: 1024 * 1024 * 10, // 10MB just in case
      timeout: 15000 // 15s max execution time
    });

    const outStr = outputBuffer.toString('utf-8');
    const info = JSON.parse(outStr.trim());

    if (!info.url) {
      throw new Error('yt-dlp did not return a valid direct URL');
    }

    // Determine filename
    let title = info.title || 'YouTube_Download';
    const ext = info.ext || (mode === 'audio' ? 'm4a' : 'mp4');
    // Sanitize filename
    title = title.replace(/[<>:"/\\|?*]/g, '').trim();

    return {
      status: 'redirect',
      url: info.url,
      filename: `${title}.${ext}`
    };

  } catch (error) {
    console.error('yt-dlp fallback failed:', error.message);
    if (error.stderr) console.error('stderr:', error.stderr.toString());
    return { status: 'error', error: { code: 'error.fallback', message: `Fallback error: ${error.message}` } };
  }
}
