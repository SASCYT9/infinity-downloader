import os from 'os';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const YTDLP_LINUX_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
const YTDLP_WIN_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';

const LOCAL_BACKEND_URL = (process.env.LOCAL_BACKEND_URL || '').trim();
const LOCAL_BACKEND_TIMEOUT_MS = parsePositiveInt(process.env.LOCAL_BACKEND_TIMEOUT_MS, 12000);
const LOCAL_BACKEND_SECRET = (process.env.LOCAL_BACKEND_SECRET || '').trim();
const USE_LOCAL_BACKEND = parseBoolean(process.env.USE_LOCAL_ENGINE_FIRST || process.env.FORCE_LOCAL_ENGINE);

const VIDEO_QUALITY_OPTIONS = new Set(['max', '4320', '2160', '1440', '1080', '720', '480', '360', '240', '144']);
const FALLBACK_VIDEO_FORMATS = [
  'bestvideo+bestaudio/bestvideo+bestaudio/best',
  'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
  'best[ext=mp4]/best',
  'best',
];
const FALLBACK_AUDIO_FORMATS = [
  'bestaudio',
  'bestaudio/best',
  'bestaudio[ext=m4a]/bestaudio/best',
  'bestaudio[ext=webm]/bestaudio/best',
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
  if (quality === 'max') {
    return 'bestvideo+bestaudio/bestvideo+bestaudio/best';
  }

  return `bestvideo[height<=${quality}]+bestaudio[ext=m4a]/best[height<=${quality}]/best`;
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
    const timeout = parseYtdlpTimeout(process.env.YTDLP_TIMEOUT_MS, 18000);
    let lastError = null;
    let info = null;

    for (const format of formats) {
      try {
        console.log(`Executing yt-dlp for ${url} with format ${format}`);
        const outputBuffer = execFileSync(
          binPath,
          [
            '-j',
            '--no-warnings',
            '--rm-cache-dir',
            '--extractor-args', 'youtube:player_client=tv,mweb',
            '-f', format,
            url,
          ],
          {
            maxBuffer: 1024 * 1024 * 10,
            timeout,
          }
        );

        const outStr = outputBuffer.toString('utf-8').trim();
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
