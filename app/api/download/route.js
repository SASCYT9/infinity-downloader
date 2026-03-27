// Cobalt API proxy — runs as a Vercel serverless function
// Forwards download requests to working Cobalt instances with auto-fallback

// Hardcoded fallback instances (sorted by reliability, NO AUTH required)
const FALLBACK_INSTANCES = [
  'https://cobaltapi.squair.xyz',
  'https://cobalt-api.meowing.de',
  'https://nuko-c.meowing.de',
  'https://api.cobalt.liubquanti.click',
  'https://cobaltapi.kittycat.boo',
  'https://fox.kittycat.boo',
  'https://dog.kittycat.boo',
  'https://melon.clxxped.lol',
  'https://lime.clxxped.lol',
  'https://grapefruit.clxxped.lol',
  'https://api.dl.woof.monster',
  'https://api.qwkuns.me',
  'https://cobaltapi.cjs.nz',
  'https://subito-c.meowing.de',
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
  'error.api.auth',        // JWT/auth required
  'error.api.rate_limit',  // rate limited
  'error.api.capacity',    // server overloaded
  'error.api.generic',     // generic server error
];

// Errors that mean "the URL/content is the problem, don't retry"
const CONTENT_LEVEL_ERRORS = [
  'error.api.link',          // bad/unsupported link
  'error.api.fetch',         // can't fetch the content
  'error.api.content',       // content unavailable  
  'error.api.youtube.age',   // age restricted
  'error.api.youtube.login', // login required
];

function isInstanceError(code) {
  return INSTANCE_LEVEL_ERRORS.some(prefix => code.startsWith(prefix));
}

function isContentError(code) {
  return CONTENT_LEVEL_ERRORS.some(prefix => code.startsWith(prefix));
}

// Try to fetch live instance list from cobalt.directory
async function getInstances() {
  try {
    const res = await fetch('https://cobalt.directory/api/working?type=api', {
      signal: AbortSignal.timeout(4000),
    });
    const json = await res.json();
    const ytInstances = json?.data?.youtube || [];
    if (ytInstances.length > 0) {
      // Filter out official instances that require JWT
      const community = ytInstances.filter(
        url => !OFFICIAL_INSTANCES.some(off => url.startsWith(off.replace(/\/$/, '')))
      );
      if (community.length > 0) return community;
      return ytInstances;
    }
  } catch {
    // Fall through to hardcoded list
  }
  return FALLBACK_INSTANCES;
}

async function tryInstance(instanceUrl, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(instanceUrl, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    // Some instances return HTML error pages (Cloudflare etc)
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new Error(`Non-JSON response (${res.status})`);
    }

    return await res.json();
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

export async function POST(request) {
  try {
    const data = await request.json();
    const { url, mode, videoQuality, audioFormat, audioBitrate } = data;

    if (!url || typeof url !== 'string') {
      return Response.json(
        { status: 'error', error: { code: 'error.api.missing_url', message: 'URL is required' } },
        { status: 400 }
      );
    }

    // Spotify DRM warning
    if (url.toLowerCase().includes('spotify.com')) {
      return Response.json({
        status: 'error',
        error: {
          code: 'error.spotify.drm',
          message: 'Spotify захищений DRM 🔒\nЗнайди цю пісню на YouTube Music — якість буде ідентична!'
        }
      }, { status: 400 });
    }

    // Build cobalt request body
    const cobaltBody = {
      url: url.trim(),
      videoQuality: videoQuality || 'max',
      audioFormat: audioFormat || 'mp3',
      audioBitrate: audioBitrate || '320',
      filenameStyle: 'pretty',
      downloadMode: mode || 'auto',
      youtubeVideoCodec: 'h264',
      alwaysProxy: true,
    };

    if (mode === 'audio') {
      cobaltBody.downloadMode = 'audio';
    }

    // Get list of working instances
    const instances = await getInstances();
    let lastError = null;

    // Try up to 8 instances (increased from 5)
    const maxTries = Math.min(instances.length, 8);
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

        // Success — return the result
        return Response.json(result);

      } catch (err) {
        lastError = {
          status: 'error',
          error: { code: 'error.instance.unavailable', message: `Instance failed: ${err.message}` }
        };
        continue;
      }
    }

    // All instances failed
    return Response.json(
      { status: 'error', error: { code: 'error.all_instances_failed', message: 'Усі сервери тимчасово недоступні. Спробуйте через хвилину.' } },
      { status: 502 }
    );

  } catch (err) {
    return Response.json(
      { status: 'error', error: { code: 'error.server', message: err.message } },
      { status: 500 }
    );
  }
}
