// Telegram Bot Webhook — receives messages with URLs and returns download links
// Token stored in environment variable TELEGRAM_BOT_TOKEN

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

const OFFICIAL_INSTANCES = [
  'https://kityune.imput.net',
  'https://blossom.imput.net',
  'https://nachos.imput.net',
  'https://sunny.imput.net',
];

// ─── Get working Cobalt instances ───
async function getInstances() {
  try {
    const res = await fetch('https://cobalt.directory/api/working?type=api', {
      signal: AbortSignal.timeout(4000),
    });
    const json = await res.json();
    const platformData = json?.data || {};
    const allInstances = new Set();
    for (const urls of Object.values(platformData)) {
      if (Array.isArray(urls)) {
        for (const url of urls) allInstances.add(url.replace(/\/$/, ''));
      }
    }
    const community = [...allInstances].filter(
      url => !OFFICIAL_INSTANCES.some(off => url.startsWith(off.replace(/\/$/, '')))
    );
    if (community.length > 0) return community;
    if (allInstances.size > 0) return [...allInstances];
  } catch { /* fallback */ }
  return FALLBACK_INSTANCES;
}

// ─── Try a single Cobalt instance ───
async function tryInstance(instanceUrl, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(instanceUrl, {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) throw new Error(`Non-JSON (${res.status})`);
    return await res.json();
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// ─── Instance/content error classification ───
const INSTANCE_ERRORS = [
  'error.api.auth', 'error.api.rate_limit', 'error.api.capacity',
  'error.api.generic', 'error.api.youtube.login', 'error.api.youtube.age',
  'error.api.youtube.decipher',
];
const CONTENT_ERRORS = ['error.api.link', 'error.api.content'];

function isInstanceError(code) {
  return INSTANCE_ERRORS.some(p => code.startsWith(p));
}
function isContentError(code) {
  return CONTENT_ERRORS.some(p => code.startsWith(p));
}

// ─── Download media via Cobalt ───
// forTelegram: limits video quality to 720p so files stay under 50MB
async function downloadMedia(url, mode = 'auto', forTelegram = false) {
  const cobaltBody = {
    url: url.trim(),
    videoQuality: forTelegram ? '720' : 'max',
    audioFormat: 'mp3',
    audioBitrate: '320',
    filenameStyle: 'pretty',
    downloadMode: mode,
    youtubeVideoCodec: 'h264',
  };

  const instances = await getInstances();
  const maxTries = Math.min(instances.length, 10);

  for (let i = 0; i < maxTries; i++) {
    try {
      const result = await tryInstance(instances[i], cobaltBody);
      if (result.status === 'error') {
        const code = result.error?.code || '';
        if (isContentError(code)) return result;
        if (isInstanceError(code)) continue;
        continue;
      }
      return result;
    } catch {
      continue;
    }
  }

  return { status: 'error', error: { code: 'error.all_instances_failed' } };
}

// ─── Send text message via Telegram Bot API ───
async function sendMessage(chatId, text, extra = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  return fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...extra }),
  });
}

// ─── Send chat action (typing, uploading, etc) ───
async function sendChatAction(chatId, action) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, action }),
  });
}

// ─── Download file from URL and upload to Telegram via multipart/form-data ───
// This is more reliable than passing URL to Telegram (cobalt tunnel URLs are temporary)
const MAX_TELEGRAM_SIZE = 49 * 1024 * 1024; // ~49MB safety margin

async function sendFileToChat(chatId, fileUrl, filename, mode) {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  try {
    // Step 1: Download the file from Cobalt into memory
    await sendChatAction(chatId, mode === 'audio' ? 'upload_voice' : 'upload_video');

    const dlResponse = await fetch(fileUrl, { signal: AbortSignal.timeout(45000) });
    if (!dlResponse.ok) throw new Error(`Download failed: ${dlResponse.status}`);

    // Check size before downloading full body
    const contentLength = dlResponse.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > MAX_TELEGRAM_SIZE) {
      return { success: false, reason: 'too_large' };
    }

    const blob = await dlResponse.blob();

    // Double-check actual size
    if (blob.size > MAX_TELEGRAM_SIZE) {
      return { success: false, reason: 'too_large' };
    }

    // Sanitize filename
    const safeName = filename.replace(/[<>:"/\\|?*]/g, '_').trim() || 'media';
    const caption = `📁 ${safeName}`;

    // Step 2: Upload to Telegram via multipart/form-data
    // Try specific type first, then document as fallback
    const attempts = [];

    if (mode === 'audio') {
      attempts.push({ method: 'sendAudio', field: 'audio' });
    } else {
      attempts.push({ method: 'sendVideo', field: 'video' });
    }
    attempts.push({ method: 'sendDocument', field: 'document' });

    for (const attempt of attempts) {
      try {
        const formData = new FormData();
        formData.append('chat_id', chatId.toString());
        formData.append('caption', caption);
        formData.append('parse_mode', 'HTML');
        if (attempt.field === 'video') {
          formData.append('supports_streaming', 'true');
        }
        formData.append(attempt.field, blob, safeName);

        const res = await fetch(`https://api.telegram.org/bot${token}/${attempt.method}`, {
          method: 'POST',
          body: formData,
        });

        const data = await res.json();
        if (data.ok) return { success: true, method: attempt.method };

        // Log error for debugging
        console.log(`${attempt.method} failed:`, data.description);
        continue;
      } catch (err) {
        console.log(`${attempt.method} error:`, err.message);
        continue;
      }
    }

    return { success: false, reason: 'telegram_rejected' };
  } catch (err) {
    console.error('sendFileToChat error:', err.message);
    return { success: false, reason: err.message };
  }
}

// ─── Send picker item as file ───
async function sendPickerItemToChat(chatId, item) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const url = item.url;

  try {
    // Download the item
    const dlResponse = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!dlResponse.ok) return false;
    const blob = await dlResponse.blob();
    if (blob.size > MAX_TELEGRAM_SIZE) return false;

    if (item.type === 'photo') {
      await sendChatAction(chatId, 'upload_photo');
      const formData = new FormData();
      formData.append('chat_id', chatId.toString());
      formData.append('photo', blob, `photo_${Date.now()}.jpg`);
      const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (data.ok) return true;
    }

    // Fallback: send as video or document
    const result = await sendFileToChat(chatId, url, `media_${Date.now()}`, item.type === 'video' ? 'auto' : 'auto');
    return result.success;
  } catch {
    return false;
  }
}

// ─── Extract URLs from text ───
function extractUrl(text) {
  if (!text) return null;
  const match = text.match(/https?:\/\/[^\s]+/);
  return match ? match[0] : null;
}

// ─── Detect mode from user message and URL ───
function detectMode(text, url) {
  const lower = (text || '').toLowerCase();
  // Explicit audio request
  if (lower.includes('аудіо') || lower.includes('audio') || lower.includes('mp3') || lower.includes('музик')) {
    return 'audio';
  }
  // Auto-detect: YouTube Music → always audio
  if (url && (url.includes('music.youtube.com') || url.includes('soundcloud.com'))) {
    return 'audio';
  }
  return 'auto';
}

// ─── Error messages (Ukrainian) ───
const ERROR_MESSAGES = {
  'error.spotify.drm': '🔒 Spotify захищений DRM.\nЗнайди цю пісню на YouTube Music — якість буде ідентична!',
  'error.all_instances_failed': '😔 Усі сервери тимчасово недоступні.\nСпробуй через хвилину або інше посилання.',
  'error.api.link': '❌ Цей сайт або формат посилання не підтримується.',
  'error.api.content': '❌ Цей контент недоступний або захищений.',
};

function getErrorText(error) {
  if (!error) return '❌ Невідома помилка';
  if (error.code && ERROR_MESSAGES[error.code]) return ERROR_MESSAGES[error.code];
  if (error.message) return `❌ ${error.message}`;
  return '❌ Щось пішло не так. Спробуй інше посилання.';
}

// ═══════════════════════════════════
//  WEBHOOK HANDLER
// ═══════════════════════════════════
export async function POST(request) {
  try {
    const update = await request.json();
    const message = update?.message;
    if (!message) return Response.json({ ok: true });

    const chatId = message.chat.id;
    const text = message.text || '';
    const firstName = message.from?.first_name || 'друже';

    // /start command
    if (text.startsWith('/start')) {
      await sendMessage(chatId,
        `👋 Привіт, <b>${firstName}</b>!\n\n` +
        `Я — <b>Infinity Downloader</b> 🚀\n\n` +
        `Просто відправ мені посилання на відео чи пісню з:\n` +
        `• YouTube, TikTok, Instagram\n` +
        `• Twitter/X, Reddit, SoundCloud\n` +
        `• та 1000+ інших сайтів\n\n` +
        `🎬 За замовчуванням — відео прямо в чат\n` +
        `🎵 Напиши "аудіо" + посилання для MP3\n\n` +
        `Спробуй зараз! 👇`
      );
      return Response.json({ ok: true });
    }

    // /help command
    if (text.startsWith('/help')) {
      await sendMessage(chatId,
        `ℹ️ <b>Як користуватися:</b>\n\n` +
        `1️⃣ Відправ посилання → отримаєш файл прямо в чат\n` +
        `2️⃣ Напиши <code>аудіо</code> + посилання → отримаєш MP3 320kbps\n\n` +
        `<b>Приклади:</b>\n` +
        `• <code>https://youtube.com/watch?v=...</code>\n` +
        `• <code>аудіо https://youtube.com/watch?v=...</code>\n` +
        `• <code>https://www.tiktok.com/@user/video/...</code>\n\n` +
        `📦 Файли до 50МБ — прямо в чат\n` +
        `📎 Більші файли — як посилання\n\n` +
        `⚡ Підтримується 1000+ сайтів!`
      );
      return Response.json({ ok: true });
    }

    // Extract URL from message
    const url = extractUrl(text);
    if (!url) {
      await sendMessage(chatId,
        `🔗 Відправ мені посилання на відео або пісню, і я завантажу!\n\n` +
        `Наприклад: <code>https://youtube.com/watch?v=dQw4w9WgXcQ</code>`
      );
      return Response.json({ ok: true });
    }

    // Spotify DRM check
    if (url.toLowerCase().includes('spotify.com')) {
      await sendMessage(chatId, ERROR_MESSAGES['error.spotify.drm']);
      return Response.json({ ok: true });
    }

    // Send "processing" indicator
    const mode = detectMode(text, url);
    const modeLabel = mode === 'audio' ? 'аудіо 🎵' : 'відео 🎬';
    await sendChatAction(chatId, mode === 'audio' ? 'upload_voice' : 'upload_video');
    await sendMessage(chatId, `⏳ Завантажую ${modeLabel}...`);

    // Download via Cobalt (forTelegram=true → 720p cap for video)
    const result = await downloadMedia(url, mode, true);

    if (result.status === 'error') {
      await sendMessage(chatId, getErrorText(result.error));
      return Response.json({ ok: true });
    }

    // ─── Single file (redirect/tunnel) ───
    if (result.status === 'redirect' || result.status === 'tunnel') {
      const filename = result.filename || 'media';

      // Try sending file directly in chat
      const sent = await sendFileToChat(chatId, result.url, filename, mode);

      if (sent.success) {
        // File sent successfully — no extra message needed
        return Response.json({ ok: true });
      }

      // Fallback: send as link button (file too large or Telegram error)
      await sendMessage(chatId,
        `📦 Файл завеликий для відправки в чат (50МБ+)\n\n` +
        `📁 ${filename}\n` +
        `👇 Завантаж за посиланням:`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: '📥 Завантажити', url: result.url }
            ]]
          }
        }
      );
      return Response.json({ ok: true });
    }

    // ─── Picker — multiple items ───
    if (result.status === 'picker') {
      const items = result.picker || [];

      // Send audio track first if available
      if (result.audio) {
        await sendFileToChat(chatId, result.audio, 'audio.mp3', 'audio');
      }

      // Send up to 5 items directly as files (to avoid spam)
      const maxDirect = Math.min(items.length, 5);

      if (maxDirect > 0) {
        await sendMessage(chatId, `📎 Відправляю ${items.length} елементів...`);
      }

      for (let i = 0; i < maxDirect; i++) {
        await sendPickerItemToChat(chatId, items[i]);
      }

      // If there are more items, send as link buttons
      if (items.length > maxDirect) {
        const buttons = [];
        items.slice(maxDirect, maxDirect + 10).forEach((item, i) => {
          const idx = maxDirect + i + 1;
          const typeEmoji = item.type === 'photo' ? '🖼️' : item.type === 'video' ? '🎬' : '📄';
          buttons.push([{ text: `${typeEmoji} #${idx}`, url: item.url }]);
        });
        await sendMessage(chatId, `📎 Решта елементів:`, {
          reply_markup: { inline_keyboard: buttons }
        });
      }

      return Response.json({ ok: true });
    }

    await sendMessage(chatId, '❓ Не вдалося розпізнати відповідь. Спробуй інше посилання.');
    return Response.json({ ok: true });

  } catch (err) {
    console.error('Telegram webhook error:', err);
    return Response.json({ ok: true }); // Always return 200 to Telegram
  }
}

// GET endpoint for webhook verification
export async function GET() {
  return Response.json({ status: 'ok', bot: 'Infinity Downloader' });
}
