# Infinity Downloader

🚀 **Premium media downloader** for YouTube, TikTok, Instagram, Twitter and 1000+ sites.

Deployed on **Vercel** — zero backend, files stream directly to your browser.

## Features

- ✨ **Max Quality** — Video up to 8K, Audio up to 320kbps
- 📂 **Persistent Folder** — Pick a folder once, downloads go there automatically
- 🎬 **Video + Audio** — Choose format, quality, codec
- 🎵 **Audio Extraction** — MP3, OGG, WAV, OPUS
- 📋 **Download History** — Re-download with one click
- 📱 **Fully Responsive** — Works on mobile
- 🛡️ **No Ads, No Tracking** — Zero telemetry

## Supported Platforms

YouTube · TikTok · Instagram · Twitter/X · Reddit · SoundCloud · Twitch · Vimeo · Pinterest · Facebook · Dailymotion · and 1000+ more

## Tech Stack

- **Frontend**: Next.js 16 (App Router)
- **Styling**: Vanilla CSS with glassmorphism design
- **Backend**: Vercel Serverless Functions
- **Download Engine**: [Cobalt](https://github.com/imputnet/cobalt) API
- **Folder Access**: File System Access API (Chrome/Edge)
- **Storage**: IndexedDB (folder handle) + localStorage (history)

## How It Works

1. Paste a link → platform auto-detected
2. Choose format (video/audio) and quality
3. Click download → Cobalt returns a direct tunnel URL
4. File streams directly to your browser (or chosen folder)

**Architecture**: Your browser ↔ Vercel API Route ↔ Cobalt Instance ↔ Direct download. Files never touch our server.

## Local Development

```bash
npm install
npm run dev
```

## Deploy to Vercel

```bash
npx vercel --prod
```

## License

MIT
