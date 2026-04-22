// Cobalt API proxy — runs as a Vercel serverless function
// Forwards download requests to working Cobalt instances with local-first fallback
import { fetchDirectYoutubeUrl } from './ytdlp_fallback';

// Hardcoded fallback instances (sorted by reliability, NO AUTH required)
const FALLBACK_INSTANCES = [
  'https://lime.clxxped.lol',
  'https://cobaltapi.squair.xyz',
  'https://nuko-c.meowing.de',
  'https://api.cobalt.liubquanti.click',
  'https://cobaltapi.kittycat.boo',
  'https://fox.kittycat.boo',
  'https://dog.kittycat.boo',
  'https://melon.clxxped.lol',
  'https://grapefruit.clxxped.lol',
  'https://api.dl.woof.monster',
  'https://api.qwkuns.me',
  'https://cobaltapi.cjs.nz',
  'https://subito-c.meowing.de',
  'https://cobalt.alpha.wolfy.love',
  'https://api.cobalt.blackcat.sweeux.org',
  'https://cobalt.omega.wolfy.love',
];

// Official instances (require JWT — used only as last resort)
const OFFICIAL_INSTANCES = [
  'https://kityune.imput.net',
  'https://blossom.imput.net',
  'https://nachos.imput.net',
  'https://sunny.imput.net',
];

// Errors that mean "this instance can't serve us, try next"
const INSTANCE_LEVEL_ERRORS = [
  'error.api.auth',          // JWT/auth required
  'error.api.rate_limit',    // rate limited
  'error.api.capacity',      // server overloaded
  'error.api.generic',       // generic server error
  'error.api.youtube.login', // needs cookies (some instances have them)
  'error.api.youtube.age',   // age restricted (some instances bypass)
  'error.api.youtube.decipher', // decipher error (instance-specific)
];

// Errors that mean "the URL/content is the problem, don't retry"
const CONTENT_LEVEL_ERRORS = [
  'error.api.link',          // bad/unsupported link
  'error.api.content',       // content unavailable
];

const YOUTUBE_HOST_RE = /(?:^|\.)youtube\.com$|^youtu\.be$|^music\.youtube\.com$/i;
const QUALITY_OPTIONS = new Set(['max', '2160', '1440', '1080', '720', '480', '360', '240', '144']);
const AUDIO_FORMATS = new Set(['best', 'mp3', 'ogg', 'wav', 'opus']);
const AUDIO_BITRATES = new Set(['96', '128', '256', '320']);
const VIDEO_CODECS = new Set(['auto', 'h264', 'av1', 'vp9']);
const DOWNLOAD_MODES = new Set(['auto', 'audio']);

const LOCAL_BACKEND_URL = (process.env.LOCAL_BACKEND_URL || '').trim();
const LOCAL_BACKEND_SECRET = (process.env.LOCAL_BACKEND_SECRET || '').trim();
const LOCAL_BACKEND_TIMEOUT_MS = parsePositiveInt(process.env.LOCAL_BACKEND_TIMEOUT_MS, 3000);
const FALLBACK_ONLY_TIMEOUT_MS = parsePositiveInt(process.env.LOCAL_BACKEND_FALLBACK_TIMEOUT_MS, 3000);
const FORCE_LOCAL_ENGINE = parseBoolean(
  process.env.FORCE_LOCAL_ENGINE || process.env.USE_LOCAL_ENGINE_FIRST || process.env.NEXT_PUBLIC_USE_LOCAL_ENGINE
);

function parseBoolean(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isInstanceError(code) {
  return INSTANCE_LEVEL_ERRORS.some(prefix => code.startsWith(prefix));
}

function isContentError(code) {
  return CONTENT_LEVEL_ERRORS.some(prefix => code.startsWith(prefix));
}

function normalizeInstanceUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function normalizeYouTubeQuality(value) {
  if (typeof value !== 'string') return 'max';
  const v = value.trim().toLowerCase();
  if (!v || v === 'max') return 'max';
  const digits = v.replace(/[^0-9]/g, '');
  if (!digits) return 'max';
  return QUALITY_OPTIONS.has(digits) ? digits : 'max';
}

function normalizeAudioFormat(value) {
  const v = String(value || 'mp3').trim().toLowerCase();
  return AUDIO_FORMATS.has(v) ? v : 'mp3';
}

function normalizeBitrate(value) {
  const v = String(value || '320').trim();
  return AUDIO_BITRATES.has(v) ? v : '320';
}

function normalizeCodec(value) {
  const v = String(value || 'auto').trim().toLowerCase();
  return VIDEO_CODECS.has(v) ? v : 'h264';
}

function normalizeMode(value) {
  const v = String(value || 'auto').trim().toLowerCase();
  return DOWNLOAD_MODES.has(v) ? v : 'auto';
}

function isYoutubeUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return YOUTUBE_HOST_RE.test(host);
  } catch {
    return false;
  }
}

function dedupeInstances(list) {
  const seen = new Set();
  return list
    .map(normalizeInstanceUrl)
    .filter((url) => url && !seen.has(url) && (seen.add(url), true));
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
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'Bypass-Tunnel-Reminder': 'true',
  };
  if (LOCAL_BACKEND_SECRET) {
    headers.Authorization = `Bearer ${LOCAL_BACKEND_SECRET}`;
    headers['X-API-KEY'] = LOCAL_BACKEND_SECRET;
  }
  return headers;
}

// Try to fetch live instance list from cobalt.directory
async function getInstances() {
  try {
    const { signal, clear } = makeAbortController(4000);
    const res = await fetch('https://cobalt.directory/api/working?type=api', { signal });
    clear();
    const json = await res.json();
    const platformData = json?.data || {};

    // Collect unique instances from ALL platform categories
    const community = [];
    const official = [];
    for (const urls of Object.values(platformData)) {
      if (Array.isArray(urls)) {
        for (const url of urls) {
          const normalized = normalizeInstanceUrl(url);
          if (!normalized) continue;
          if (OFFICIAL_INSTANCES.some((off) => normalized.startsWith(off.replace(/\/$/, '')))) {
            official.push(normalized);
          } else {
            community.push(normalized);
          }
        }
      }
    }

    if (community.length > 0 || official.length > 0) {
      return dedupeInstances([...community, ...official, ...FALLBACK_INSTANCES]);
    }
  } catch {
    // Fall through to hardcoded list
  }
  return [...FALLBACK_INSTANCES];
}

async function tryInstance(instanceUrl, body) {
  const { signal, clear } = makeAbortController(15000);

  try {
    const res = await fetch(instanceUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
    clear();

    // Some instances return HTML error pages (Cloudflare etc)
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new Error(`Non-JSON response (${res.status})`);
    }

    return await res.json();
  } catch (err) {
    clear();
    throw err;
  }
}

async function tryLocalBackend(body) {
  if (!LOCAL_BACKEND_URL || !FORCE_LOCAL_ENGINE) {
    return null;
  }
  const normalizedBody = {
    ...body,
    videoQuality: body.videoQuality || 'max',
    audioFormat: body.audioFormat || 'mp3',
    audioBitrate: body.audioBitrate || '320',
  };
  const { signal, clear } = makeAbortController(LOCAL_BACKEND_TIMEOUT_MS);

  try {
    const res = await fetch(`${LOCAL_BACKEND_URL}/api/direct-url`, {
      method: 'POST',
      headers: localBackendHeaders(),
      body: JSON.stringify(normalizedBody),
      signal,
    });
    clear();

    if (!res.ok) {
      const message = `Local backend HTTP ${res.status}`;
      console.warn(`[Primary] ${message}`);
      return { status: 'error', error: { code: 'error.local_backend.unavailable', message } };
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      console.warn('[Primary] Local backend returned non-JSON response');
      return { status: 'error', error: { code: 'error.local_backend.invalid_payload', message: 'Local backend returned non-JSON response' } };
    }

    const data = await res.json();
    return data;
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.warn('[Primary] Local backend failed:', err.message);
    }
    return { status: 'error', error: { code: 'error.local_backend.unreachable', message: err.message } };
  } finally {
    clear();
  }
}

function buildLocalPrimaryPayload(url, mode, videoQuality, audioFormat, audioBitrate, youtubeVideoCodec) {
  return {
    url: url.trim(),
    mode,
    videoQuality,
    audioFormat,
    audioBitrate,
    youtubeVideoCodec,
    downloadMode: mode,
  };
}

// Helper to ensure the tunnel URL actually provides data and isn't a corrupted 0-byte stream
async function verifyTunnel(tunnelUrl, timeoutMs = 5000) {
  const { signal, clear } = makeAbortController(timeoutMs);
  try {
    const res = await fetch(tunnelUrl, { signal });
    if (!res.ok) return false;
    
    const contentLength = res.headers.get('content-length');
    if (contentLength === '0') return false;

    if (res.body) {
      const reader = res.body.getReader();
      const first = await reader.read();
      await reader.cancel(); // Free connection immediately

      if (first.done && (!first.value || first.value.length === 0)) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    clear();
  }
}

function normalizeErrorResponse(error, fallbackCode = 'error.all_instances_failed', fallbackMessage) {
  return {
    status: 'error',
    error: {
      code: error?.error?.code || fallbackCode,
      message: error?.error?.message || fallbackMessage || 'Не вдалося отримати відео. Спробуйте пізніше.',
    },
  };
}

export async function POST(request) {
  try {
    const data = await request.json();
    const {
      url,
      mode: rawMode,
      videoQuality: rawVideoQuality,
      audioFormat: rawAudioFormat,
      audioBitrate: rawAudioBitrate,
      youtubeVideoCodec: rawYouTubeVideoCodec,
    } = data;

    if (!url || typeof url !== 'string') {
      return Response.json(
        { status: 'error', error: { code: 'error.api.missing_url', message: 'URL is required' } },
        { status: 400 }
      );
    }

    const isYoutube = isYoutubeUrl(url);
    const mode = normalizeMode(rawMode);
    const videoQuality = isYoutube ? normalizeYouTubeQuality(rawVideoQuality) : (rawVideoQuality || 'max');
    const audioFormat = normalizeAudioFormat(rawAudioFormat);
    const audioBitrate = normalizeBitrate(rawAudioBitrate);
    const youtubeVideoCodec = normalizeCodec(rawYouTubeVideoCodec);

    // Spotify DRM warning
    if (url.toLowerCase().includes('spotify.com')) {
      return Response.json({
        status: 'error',
        error: {
          code: 'error.spotify.drm',
          message: 'Spotify захищений DRM 🔒\nЗнайди цю пісню на YouTube Music — якість буде ідентична!'
        },
      }, { status: 400 });
    }

    // Build cobalt request body
    const cobaltBody = {
      url: url.trim(),
      videoQuality: videoQuality || 'max',
      audioFormat,
      audioBitrate,
      filenameStyle: 'pretty',
      downloadMode: mode,
    };

    // Keep H.264 as explicit opt-in. For default/auto mode prefer VP9 to unlock 4K webm when available.
    cobaltBody.youtubeVideoCodec = youtubeVideoCodec === 'auto' ? 'vp9' : youtubeVideoCodec;

    if (mode === 'audio') {
      cobaltBody.downloadMode = 'audio';
    }

    // 1) Local-first: try self-hosted backend (public endpoint + secret) with timeout
    if (FORCE_LOCAL_ENGINE) {
      const primaryPayload = buildLocalPrimaryPayload(url, mode, videoQuality, audioFormat, audioBitrate, youtubeVideoCodec);
      const localResult = await tryLocalBackend(primaryPayload);

      if (localResult) {
        const code = localResult.error?.code || '';
        if (localResult.status === 'error') {
          // Log and continue with Cobalt on transport/content-agnostic errors.
          // Do not hide hard content errors from the local backend.
          if (isContentError(code)) {
            return Response.json(localResult, { status: 400 });
          }
        } else if (localResult.status === 'tunnel') {
          const isValid = await verifyTunnel(localResult.url, FALLBACK_ONLY_TIMEOUT_MS);
          if (!isValid) {
            console.warn('[Primary] Local backend returned invalid stream. Falling back to cobalt instances');
          } else {
            return Response.json(localResult);
          }
        } else if (localResult.status === 'redirect') {
          return Response.json(localResult);
        }
      }
    }

    // Get list of working instances
    const instances = await getInstances();
    let lastError = null;

    // Try up to 10 instances for maximum reliability
    const maxTries = Math.min(instances.length, 10);
    for (let i = 0; i < maxTries; i++) {
      const instance = instances[i];
      try {
        const result = await tryInstance(instance, cobaltBody);

        if (result.status === 'error') {
          const code = result.error?.code || '';

          // Content/URL errors → stop, don't try other instances
          if (isContentError(code)) {
            return Response.json(result, { status: 400 });
          }

          // Instance-level errors (auth, rate limit) → skip to next
          if (isInstanceError(code)) {
            lastError = result;
            continue;
          }

          // Unknown error → save and continue
          lastError = result;
          continue;
        }

        if (result.status === 'tunnel') {
          // Tunnel validation: ensure the url actually streams data
          const isValid = await verifyTunnel(result.url);
          if (!isValid) {
            console.warn(`Instance ${instance} returned a corrupted 0-byte tunnel. Skipping.`);
            lastError = { status: 'error', error: { code: 'error.api.corrupted_stream', message: 'Instance produced an empty 0-byte file.' } };
            continue;
          }
        }

        // Success — return the result
        return Response.json(result);
      } catch (err) {
        lastError = {
          status: 'error',
          error: { code: 'error.instance.unavailable', message: `Instance failed: ${err.message}` }
        };
      }
    }

    // All Cobalt instances failed
    console.log('All Cobalt instances failed. Attempting yt-dlp fallback...');
    
    // Check if it's YouTube, since our fallback currently focuses on YouTube Music and Video
    if (isYoutubeUrl(url)) {
      const fallbackResult = await fetchDirectYoutubeUrl(url, mode, { videoQuality, audioFormat, audioBitrate });
      if (fallbackResult && fallbackResult.status !== 'error') {
        console.log('yt-dlp fallback succeeded!');
        return Response.json(fallbackResult);
      }
      if (fallbackResult && fallbackResult.status === 'error') {
        const fallbackCode = fallbackResult.error?.code || 'error.fallback';
        const status = isContentError(fallbackCode) ? 400 : 502;
        return Response.json(fallbackResult, { status });
      }
    }

    const finalError = lastError || {
      status: 'error',
      error: {
        code: 'error.all_instances_failed',
        message: 'Усі сервери тимчасово недоступні (включаючи резервний). Спробуйте через хвилину.'
      }
    };
    return Response.json(normalizeErrorResponse(finalError), { status: 502 });

  } catch (err) {
    return Response.json(
      { status: 'error', error: { code: 'error.server', message: err.message } },
      { status: 500 }
    );
  }
}
