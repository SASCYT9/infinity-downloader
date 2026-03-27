// Cobalt API proxy — runs as a Vercel serverless function
// Forwards download requests to working Cobalt instances with auto-fallback

// Hardcoded fallback instances (sorted by reliability score)
const FALLBACK_INSTANCES = [
  'https://melon.clxxped.lol',
  'https://cobaltapi.kittycat.boo',
  'https://fox.kittycat.boo',
  'https://cobaltapi.squair.xyz',
  'https://nuko-c.meowing.de',
  'https://cobalt-api.meowing.de',
  'https://api.cobalt.liubquanti.click',
  'https://kityune.imput.net',
  'https://blossom.imput.net',
  'https://nachos.imput.net',
  'https://sunny.imput.net',
];

// Try to fetch live instance list from cobalt.directory
async function getInstances() {
  try {
    const res = await fetch('https://cobalt.directory/api/working?type=api', {
      signal: AbortSignal.timeout(4000),
    });
    const json = await res.json();
    // Get YouTube-compatible instances (most important service)
    const ytInstances = json?.data?.youtube || [];
    if (ytInstances.length > 0) {
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

    // If user specifically wants audio-only
    if (mode === 'audio') {
      cobaltBody.downloadMode = 'audio';
    }

    // Get list of working instances
    const instances = await getInstances();
    let lastError = null;

    // Try up to 5 instances
    const maxTries = Math.min(instances.length, 5);
    for (let i = 0; i < maxTries; i++) {
      const instance = instances[i];
      try {
        const result = await tryInstance(instance, cobaltBody);

        if (result.status === 'error') {
          lastError = result;
          // If it's a content/URL error (not server error), don't try other instances
          const code = result.error?.code || '';
          if (code.startsWith('error.api.') ||
              code.startsWith('error.fetch') ||
              code.includes('content') ||
              code.includes('link')) {
            return Response.json(result, { status: 400 });
          }
          continue;
        }

        // Success — return the result
        return Response.json(result);

      } catch (err) {
        lastError = {
          status: 'error',
          error: { code: 'error.instance.unavailable', message: `Instance ${instance} failed: ${err.message}` }
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
