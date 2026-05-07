// Cobalt API proxy — runs as a Vercel serverless function
// Forwards download requests to working Cobalt instances with local-first fallback
import { fetchDirectYoutubeUrl } from './ytdlp_fallback';

// Hand-picked instances that have been verified to actually STREAM YouTube
// bytes (not just respond 200 to a probe). These are tried BEFORE the live
// directory so the common case is fast. The directory still kicks in via
// getInstances() so a dying instance can be replaced without redeploy.
//
// Notes on what fails for serverless callers right now:
// - cobaltapi.squair.xyz, dog.kittycat.boo, cobaltapi.kittycat.boo: respond
//   200 OK to GET but send 0-byte bodies (backend can't fetch YouTube)
// - imput.net family: returns Cloudflare challenge HTML for AWS/Vercel IPs
// - Most clxxped/wolfy/mgytr/nuko instances now require Cloudflare Turnstile
//   JWT auth which we don't implement — they return error.api.auth.jwt.missing
const FALLBACK_INSTANCES = [
  'https://api.dl.woof.monster',
];

// Errors that mean "this instance can't serve us, try next"
const INSTANCE_LEVEL_ERRORS = [
  'error.api.auth',          // JWT/auth required (Turnstile, not implemented)
  'error.api.rate_limit',    // rate limited
  'error.api.capacity',      // server overloaded
  'error.api.generic',       // generic server error
  'error.api.youtube.login', // needs cookies (some instances have them)
  'error.api.youtube.age',   // age restricted (some instances bypass)
  'error.api.youtube.decipher', // decipher error (instance-specific)
  'error.api.youtube.no_matching_format', // codec/quality combo not extracted on this instance
];

// Errors that mean "the URL/content is the problem, don't retry"
const CONTENT_LEVEL_ERRORS = [
  'error.api.link',          // bad/unsupported link
  'error.api.content',       // content unavailable
];

const YOUTUBE_HOST_RE = /(?:^|\.)youtube\.com$|^youtu\.be$|^music\.youtube\.com$/i;
const QUALITY_OPTIONS = new Set(['max', '4320', '2160', '1440', '1080', '720', '480', '360', '240', '144']);
const AUDIO_FORMATS = new Set(['best', 'mp3', 'ogg', 'wav', 'opus']);
const AUDIO_BITRATES = new Set(['96', '128', '256', '320']);
const VIDEO_CODECS = new Set(['auto', 'h264', 'av1', 'vp9']);
const DOWNLOAD_MODES = new Set(['auto', 'audio']);

const LOCAL_BACKEND_URL = (process.env.LOCAL_BACKEND_URL || '').trim();
const LOCAL_BACKEND_SECRET = (process.env.LOCAL_BACKEND_SECRET || '').trim();
const LOCAL_BACKEND_TIMEOUT_MS = parsePositiveInt(process.env.LOCAL_BACKEND_TIMEOUT_MS, 12000);
const FALLBACK_ONLY_TIMEOUT_MS = parsePositiveInt(process.env.LOCAL_BACKEND_FALLBACK_TIMEOUT_MS, 8000);
const FORCE_LOCAL_ENGINE = parseBoolean(
  process.env.FORCE_LOCAL_ENGINE || process.env.USE_LOCAL_ENGINE_FIRST || process.env.NEXT_PUBLIC_USE_LOCAL_ENGINE
);

// Self-hosted Cobalt with own YouTube cookies (preferred when available).
const SELF_HOSTED_COBALT = (process.env.COBALT_INSTANCE_URL || '').trim().replace(/\/+$/, '');
const SELF_HOSTED_COBALT_KEY = (process.env.COBALT_API_KEY || '').trim();
const SELF_HOSTED_COBALT_TIMEOUT_MS = parsePositiveInt(process.env.COBALT_SELF_HOST_TIMEOUT_MS, 12000);
const COBALT_INSTANCE_TIMEOUT_MS = parsePositiveInt(process.env.COBALT_INSTANCE_TIMEOUT_MS, 8000);
const COBALT_MAX_TRIES = parsePositiveInt(process.env.COBALT_MAX_TRIES, 8);

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

// Try to fetch live instance list from cobalt.directory.
// When platformKey is provided (e.g. "youtube"), only return instances that the
// directory marks as working FOR THAT platform — mixing all platforms wastes
// the per-instance retry budget on instances that don't support YouTube.
async function getInstances(platformKey = null) {
  try {
    const { signal, clear } = makeAbortController(4000);
    const res = await fetch('https://cobalt.directory/api/working?type=api', { signal });
    clear();
    const json = await res.json();
    const platformData = json?.data || {};

    const discovered = [];
    if (platformKey && Array.isArray(platformData[platformKey])) {
      for (const url of platformData[platformKey]) {
        const normalized = normalizeInstanceUrl(url);
        if (normalized) discovered.push(normalized);
      }
    } else {
      for (const urls of Object.values(platformData)) {
        if (Array.isArray(urls)) {
          for (const url of urls) {
            const normalized = normalizeInstanceUrl(url);
            if (normalized) discovered.push(normalized);
          }
        }
      }
    }

    if (discovered.length > 0) {
      // Trusted (hand-verified) instances go first; the live list comes after
      // and supplies fresh candidates if the trusted ones go bad.
      return dedupeInstances([...FALLBACK_INSTANCES, ...discovered]);
    }
  } catch {
    // Fall through to hardcoded list
  }
  return [...FALLBACK_INSTANCES];
}

async function tryInstance(instanceUrl, body, { extraHeaders = {}, timeoutMs = COBALT_INSTANCE_TIMEOUT_MS } = {}) {
  const { signal, clear } = makeAbortController(timeoutMs);

  try {
    const res = await fetch(instanceUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...extraHeaders,
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

async function trySelfHostedCobalt(body) {
  if (!SELF_HOSTED_COBALT) return null;
  const headers = SELF_HOSTED_COBALT_KEY ? { Authorization: `Api-Key ${SELF_HOSTED_COBALT_KEY}` } : {};
  try {
    return await tryInstance(SELF_HOSTED_COBALT, body, {
      extraHeaders: headers,
      timeoutMs: SELF_HOSTED_COBALT_TIMEOUT_MS,
    });
  } catch (err) {
    console.warn('[Self-host] Cobalt instance failed:', err.message);
    return { status: 'error', error: { code: 'error.self_host.unreachable', message: err.message } };
  }
}

async function pollLocalDownload(jobId, totalBudgetMs = 40000) {
  const start = Date.now();
  const pollInterval = 1500;

  while (Date.now() - start < totalBudgetMs) {
    await new Promise((r) => setTimeout(r, pollInterval));

    try {
      const { signal, clear } = makeAbortController(5000);
      const res = await fetch(`${LOCAL_BACKEND_URL}/api/download/progress/${jobId}`, {
        headers: localBackendHeaders(),
        signal,
      });
      clear();

      if (!res.ok) continue;
      const data = await res.json();

      if (data.status === 'completed') {
        return { status: 'tunnel', url: data.url, filename: data.filename };
      }
      if (data.status === 'error') {
        return { status: 'error', error: { code: 'error.local_backend.download_failed', message: data.error || 'Download failed' } };
      }
      // Otherwise still downloading/processing — keep polling
    } catch {
      // Network blip — keep polling
    }
  }

  return { status: 'error', error: { code: 'error.local_backend.timeout', message: 'Local backend download exceeded budget' } };
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
    // Trigger full-quality download (yt-dlp downloads + merges video+audio
    // server-side). /api/direct-url can only return single-stream URLs (360p
    // max for video on YouTube), so we always go through the merge path.
    const res = await fetch(`${LOCAL_BACKEND_URL}/api/download`, {
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
    if (data.error) {
      return { status: 'error', error: { code: 'error.local_backend.start_failed', message: data.error } };
    }
    if (!data.job_id) {
      return { status: 'error', error: { code: 'error.local_backend.invalid_payload', message: 'Missing job_id from local backend' } };
    }

    // Poll until the download finishes (~40s budget, leaves headroom under
    // Vercel's 60s maxDuration). The serve URL returned by the local backend
    // points back to itself via X-Forwarded-Host (i.e. the ngrok hostname),
    // so the browser can fetch it directly.
    return await pollLocalDownload(data.job_id);
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

// Liveness check on a returned tunnel URL.
// HEAD is not enough: many broken cobalt instances respond 200 OK to GET but
// then send a 0-byte body (their backend can't actually fetch from YouTube).
// We must read the first chunk to be sure the tunnel produces real data.
// We still cancel the reader immediately to free the connection.
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
      await reader.cancel();
      if (first.done && (!first.value || first.value.length === 0)) return false;
      if (!first.done && (!first.value || first.value.length === 0)) return false;
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

    // Codec selection. The previous default forced VP9 to unlock 4K webm, but
    // many community instances simply don't have VP9 streams extracted at
    // common qualities (e.g. woof.monster returns error.api.youtube.no_matching_format
    // for 720p VP9). When the user chose "auto", omit the codec field
    // entirely so cobalt picks the most compatible stream available — that's
    // H.264 below 1080p and falls back gracefully. Only forward an explicit
    // user choice (h264 / vp9 / av1).
    if (youtubeVideoCodec && youtubeVideoCodec !== 'auto') {
      cobaltBody.youtubeVideoCodec = youtubeVideoCodec;
    }

    if (mode === 'audio') {
      cobaltBody.downloadMode = 'audio';
    }

    // localProcessing=disabled forces the server to merge video+audio into a
    // single tunnel URL — the browser can't merge separate streams (no
    // ffmpeg-wasm). Without this we'd get status:"local-processing" responses
    // we have to reject anyway.
    cobaltBody.localProcessing = 'disabled';

    // Self-hosted Cobalt with cookies can serve HLS reliably; public instances
    // often respond with multi-stream "local-processing" payloads when HLS is
    // requested, which we then have to drop. So we only enable HLS for the
    // self-hosted body below.
    const selfHostedBody = isYoutube
      ? { ...cobaltBody, youtubeHLS: true }
      : cobaltBody;

    let lastError = null;

    // 1) Self-hosted Cobalt with own cookies — most reliable when configured
    if (SELF_HOSTED_COBALT) {
      const selfResult = await trySelfHostedCobalt(selfHostedBody);
      if (selfResult) {
        const code = selfResult.error?.code || '';
        if (selfResult.status === 'error') {
          if (isContentError(code)) {
            return Response.json(selfResult, { status: 400 });
          }
          lastError = selfResult;
        } else if (selfResult.status === 'tunnel') {
          const isValid = await verifyTunnel(selfResult.url);
          if (isValid) {
            return Response.json(selfResult);
          }
          console.warn('[Self-host] Returned 0-byte tunnel. Falling back.');
        } else if (selfResult.status === 'local-processing') {
          // Browser can't merge separate streams; fall back to local engine / public instances
          console.warn('[Self-host] Returned local-processing response, browser cannot merge. Falling back.');
          lastError = { status: 'error', error: { code: 'error.api.local_processing_unsupported', message: 'Instance returned multi-stream response' } };
        } else if (selfResult.status === 'redirect' || selfResult.status === 'picker') {
          return Response.json(selfResult);
        }
      }
    }

    // 2) Local Python/yt-dlp backend (cookies file there too) with timeout
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

    // 3) Public Cobalt instances. Bounded retries fit within Vercel maxDuration.
    // Filter directory results by "youtube" platform when applicable so we don't
    // burn the retry budget on instances that don't support YouTube at all.
    const instances = await getInstances(isYoutube ? 'youtube' : null);
    const debugLog = [];

    const maxTries = Math.min(instances.length, COBALT_MAX_TRIES);
    for (let i = 0; i < maxTries; i++) {
      const instance = instances[i];
      try {
        const result = await tryInstance(instance, cobaltBody);

        if (result.status === 'error') {
          const code = result.error?.code || '';
          debugLog.push(`${instance}: error ${code}`);

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
            debugLog.push(`${instance}: tunnel-but-0-bytes`);
            lastError = { status: 'error', error: { code: 'error.api.corrupted_stream', message: 'Instance produced an empty 0-byte file.' } };
            continue;
          }
          debugLog.push(`${instance}: tunnel-ok`);
        }

        if (result.status === 'local-processing') {
          // Browser-side merging not supported. Try next instance.
          console.warn(`Instance ${instance} returned local-processing response. Skipping.`);
          debugLog.push(`${instance}: local-processing`);
          lastError = { status: 'error', error: { code: 'error.api.local_processing_unsupported', message: 'Instance returned multi-stream response' } };
          continue;
        }

        // Success — return the result
        return Response.json(result);
      } catch (err) {
        debugLog.push(`${instance}: throw ${err.message}`);
        lastError = {
          status: 'error',
          error: { code: 'error.instance.unavailable', message: `Instance failed: ${err.message}` }
        };
      }
    }

    console.warn('[Cobalt] All instances failed. Trace:', JSON.stringify(debugLog));

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
        const enriched = { ...fallbackResult, _cobaltTrace: debugLog };
        return Response.json(enriched, { status });
      }
    }

    const finalError = lastError || {
      status: 'error',
      error: {
        code: 'error.all_instances_failed',
        message: 'Усі сервери тимчасово недоступні (включаючи резервний). Спробуйте через хвилину.'
      }
    };
    const normalized = normalizeErrorResponse(finalError);
    return Response.json({ ...normalized, _cobaltTrace: debugLog }, { status: 502 });

  } catch (err) {
    return Response.json(
      { status: 'error', error: { code: 'error.server', message: err.message } },
      { status: 500 }
    );
  }
}
