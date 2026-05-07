import os from 'os';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const YTDLP_LINUX_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
const YTDLP_WIN_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';

const LOCAL_BACKEND_URL = (process.env.LOCAL_BACKEND_URL || '').trim();
const LOCAL_BACKEND_TIMEOUT_MS = parsePositiveInt(process.env.LOCAL_BACKEND_TIMEOUT_MS, 12000);
const LOCAL_BACKEND_SECRET = (process.env.LOCAL_BACKEND_SECRET || '').trim();
const USE_LOCAL_BACKEND = parseBoolean(process.env.USE_LOCAL_ENGINE_FIRST || process.env.FORCE_LOCAL_ENGINE);

const VIDEO_QUALITY_OPTIONS = new Set(['max', '4320', '2160', '1440', '1080', '720', '480', '360', '240', '144']);
// Vercel serverless has no ffmpeg, so we can't merge separate video+audio
// streams. We must request formats that come as a SINGLE file. On YouTube the
// last format guaranteed to exist as a combined progressive stream is 18
// (360p mp4). Format selectors with "+" produce multi-stream output and yt-dlp
// returns no top-level `info.url` for those, so we drop them.
const FALLBACK_VIDEO_FORMATS = [
  'best[ext=mp4][vcodec!=none][acodec!=none]/best[vcodec!=none][acodec!=none]/best',
  '18/best[ext=mp4]/best',
  'best',
];
const FALLBACK_AUDIO_FORMATS = [
  'bestaudio[ext=m4a]/bestaudio/best',
  'bestaudio[ext=webm]/bestaudio/best',
  'bestaudio/best',
  '140/bestaudio',
];

function parseBoolean(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseYtdlpTimeout(value, fallback) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeYouTubeQuality(value) {
  if (typeof value !== 'string') return 'max';
  const v = value.trim().toLowerCase();
  if (!v || v === 'max') return 'max';
  const digits = v.replace(/[^0-9]/g, '');
  if (!digits) return 'max';
  return VIDEO_QUALITY_OPTIONS.has(digits) ? digits : 'max';
}

function buildYtdlpVideoFormat(quality) {
  // Single-stream only — see note on FALLBACK_VIDEO_FORMATS above. We can't
  // merge in serverless. Combined-stream selectors are tried first; if YouTube
  // refuses to serve a combined stream at the requested height we fall back
  // to lower qualities through the FALLBACK list.
  if (quality === 'max') {
    return 'best[ext=mp4][vcodec!=none][acodec!=none]/best[vcodec!=none][acodec!=none]/best';
  }
  return `best[height<=${quality}][ext=mp4][vcodec!=none][acodec!=none]/best[height<=${quality}][vcodec!=none][acodec!=none]/best`;
}

function buildFormatCandidates(mode, options = {}) {
  if (mode === 'audio') {
    return FALLBACK_AUDIO_FORMATS;
  }

  const normalizedQuality = normalizeYouTubeQuality(options.videoQuality || 'max');
  const preferred = buildYtdlpVideoFormat(normalizedQuality);
  const fallback = FALLBACK_VIDEO_FORMATS.filter((format) => format !== preferred);

  return [preferred, ...fallback];
}

function isRetryableErrorMessage(message) {
  const m = String(message || '').toLowerCase();
  return [
    'requested format is not available',
    'requested format not available',
    'no video formats found',
    'no such format',
    'unable to extract',
    'this video is no longer available',
    'video unavailable',
    'private video',
    'age restricted',
    'sign in',
  ].some((needle) => m.includes(needle));
}

function makeAbortController(timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout),
  };
}

function localBackendHeaders() {
  const headers = {
    'Content-Type': 'application/json',
    'Bypass-Tunnel-Reminder': 'true',
    Accept: 'application/json',
  };
  if (LOCAL_BACKEND_SECRET) {
    headers.Authorization = `Bearer ${LOCAL_BACKEND_SECRET}`;
    headers['X-API-KEY'] = LOCAL_BACKEND_SECRET;
  }
  return headers;
}

function isRetryableLocalError(payload) {
  if (payload?.status !== 'error') {
    return false;
  }

  const code = payload?.error?.code || '';
  const message = payload?.error?.message || payload?.error || '';
  const retryableCodes = new Set([
    'error.local_backend.unreachable',
    'error.local_backend.http',
    'error.local_backend.invalid_payload',
    'error.local_backend.parse',
    'error.local_backend.unavailable',
    'error.local_backend.timeout',
  ]);

  if (retryableCodes.has(code)) {
    return true;
  }

  return isRetryableErrorMessage(message);
}

function extractMessage(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  if (err.stderr) {
    const stderr = String(err.stderr.toString()).trim();
    if (stderr) return stderr;
  }
  return String(err.message || '').trim() || 'yt-dlp serverless fallback failed';
}

async function fetchViaLocalBackend(url, mode, options = {}) {
  if (!LOCAL_BACKEND_URL || !USE_LOCAL_BACKEND) return null;

  const videoQuality = normalizeYouTubeQuality(options.videoQuality || 'max');
  const payload = {
    url,
    mode: mode || 'auto',
    videoQuality,
    audioFormat: options.audioFormat || 'best',
    audioBitrate: options.audioBitrate || '320',
    downloadMode: mode || 'auto',
  };

  const { signal, clear } = makeAbortController(LOCAL_BACKEND_TIMEOUT_MS);

  try {
    console.log(`[Fallback] Trying local backend at ${LOCAL_BACKEND_URL}...`);

    const res = await fetch(`${LOCAL_BACKEND_URL}/api/direct-url`, {
      method: 'POST',
      headers: localBackendHeaders(),
      body: JSON.stringify(payload),
      signal,
    });
    clear();

    if (!res.ok) {
      console.warn(`[Fallback] Local backend returned ${res.status}`);
      return {
        status: 'error',
        error: { code: 'error.local_backend.http', message: `Local backend returned ${res.status}` },
      };
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      console.warn('[Fallback] Local backend returned non-JSON payload');
      return {
        status: 'error',
        error: { code: 'error.local_backend.invalid_payload', message: 'Local backend returned unsupported content type' },
      };
    }

    const data = await res.json();
    if (data.status === 'redirect' && data.url) {
      return data;
    }
    if (data.status === 'error') {
      return data;
    }

    return {
      status: 'error',
      error: { code: 'error.local_backend.invalid_payload', message: 'Unexpected local backend response format' },
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { status: 'error', error: { code: 'error.local_backend.unreachable', message: 'Local backend timed out' } };
    }
    console.warn('[Fallback] Local backend unreachable:', err.message);
    return { status: 'error', error: { code: 'error.local_backend.unreachable', message: err.message } };
  } finally {
    clear();
  }
}

async function fetchViaServerlessYtdlp(url, mode, options = {}) {
  try {
    const isWin = os.platform() === 'win32';
    const binName = isWin ? 'yt-dlp-standalone-v3.exe' : 'yt-dlp-linux-standalone-v3';
    const tmpDir = os.tmpdir();
    const binPath = path.join(tmpDir, binName);

    if (!fs.existsSync(binPath)) {
      console.log('yt-dlp missing, downloading to /tmp...');
      const downloadUrl = isWin ? YTDLP_WIN_URL : YTDLP_LINUX_URL;
      const res = await fetch(downloadUrl);
      if (!res.ok) throw new Error('Failed to download yt-dlp binary');
      const buf = await res.arrayBuffer();
      fs.writeFileSync(binPath, Buffer.from(buf));
      if (!isWin) {
        fs.chmodSync(binPath, '755');
      }
    }

    const formats = buildFormatCandidates(mode, options);
    // Default 12s per attempt — Vercel maxDuration is 60s and we still need
    // headroom for the response trip. --rm-cache-dir was removed because it
    // forces yt-dlp to rebuild extractor caches every cold start.
    const timeout = parseYtdlpTimeout(process.env.YTDLP_TIMEOUT_MS, 12000);
    let lastError = null;
    let info = null;

    for (const format of formats) {
      try {
        console.log(`Executing yt-dlp for ${url} with format ${format}`);
        const { stdout } = await execFileAsync(
          binPath,
          [
            '-j',
            '--no-warnings',
            '--no-check-certificate',
            '--extractor-args', 'youtube:player_client=tv,mweb',
            '-f', format,
            url,
          ],
          {
            maxBuffer: 1024 * 1024 * 10,
            timeout,
          }
        );

        const outStr = String(stdout || '').trim();
        if (!outStr) {
          throw new Error('yt-dlp returned empty output');
        }

        info = JSON.parse(outStr);
        if (info?.url) {
          break;
        }
        throw new Error('yt-dlp did not return a valid direct URL');
      } catch (error) {
        const message = extractMessage(error);
        console.error(`yt-dlp format ${format} failed: ${message}`);
        lastError = new Error(message);
        if (!isRetryableErrorMessage(message)) {
          break;
        }
      }
    }

    if (!info?.url) {
      throw lastError || new Error('yt-dlp serverless fallback failed');
    }

    let title = info.title || 'YouTube_Download';
    const ext = info.ext || (mode === 'audio' ? 'm4a' : 'mp4');
    title = title.replace(/[<>:"/\\|?*]/g, '').trim();

    return {
      status: 'redirect',
      url: info.url,
      filename: `${title}.${ext}`,
    };
  } catch (error) {
    console.error('yt-dlp serverless fallback failed:', error.message);
    const message = error.message || 'yt-dlp serverless fallback failed';
    return {
      status: 'error',
      error: {
        code: message.includes('timed out') ? 'error.ytdlp.timeout' : 'error.ytdlp',
        message,
      },
    };
  }
}

export async function fetchDirectYoutubeUrl(url, mode, options = {}) {
  const localPayload = { videoQuality: options.videoQuality, audioFormat: options.audioFormat, audioBitrate: options.audioBitrate };

  const localResult = await fetchViaLocalBackend(url, mode, localPayload);
  if (localResult && !isRetryableLocalError(localResult)) {
    console.log('[Fallback] Local backend returned final result:', localResult);
    return localResult;
  }
  if (localResult && localResult.status === 'error') {
    console.warn('[Fallback] Local backend rejected request:', localResult.error);
  }

  const serverlessResult = await fetchViaServerlessYtdlp(url, mode, options);
  if (serverlessResult && serverlessResult.status !== 'error') {
    console.log('[Fallback] ✅ Serverless yt-dlp succeeded!');
    return serverlessResult;
  }

  return serverlessResult?.status === 'error'
    ? serverlessResult
    : {
        status: 'error',
        error: {
          code: 'error.fallback',
          message:
            'YouTube потребує авторизації для цього відео. Завантажте через локальний додаток або спробуйте пізніше.',
        },
      };
}
