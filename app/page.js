'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

/* ─── Platform Detection ─── */
function detectPlatform(url) {
  if (!url) return null;
  const u = url.toLowerCase();
  if (u.includes('youtube.com') || u.includes('youtu.be') || u.includes('music.youtube.com'))
    return { id: 'youtube', name: 'YouTube', icon: '▶️' };
  if (u.includes('tiktok.com'))
    return { id: 'tiktok', name: 'TikTok', icon: '🎵' };
  if (u.includes('instagram.com'))
    return { id: 'instagram', name: 'Instagram', icon: '📸' };
  if (u.includes('twitter.com') || u.includes('x.com'))
    return { id: 'twitter', name: 'Twitter / X', icon: '🐦' };
  if (u.includes('reddit.com'))
    return { id: 'reddit', name: 'Reddit', icon: '🤖' };
  if (u.includes('soundcloud.com'))
    return { id: 'soundcloud', name: 'SoundCloud', icon: '🔊' };
  if (u.includes('spotify.com'))
    return { id: 'spotify', name: 'Spotify', icon: '🟢' };
  if (u.includes('twitch.tv'))
    return { id: 'twitch', name: 'Twitch', icon: '🎮' };
  if (u.includes('facebook.com') || u.includes('fb.watch'))
    return { id: 'generic', name: 'Facebook', icon: '📘' };
  if (u.includes('pinterest.com'))
    return { id: 'generic', name: 'Pinterest', icon: '📌' };
  if (u.includes('vimeo.com'))
    return { id: 'generic', name: 'Vimeo', icon: '🎬' };
  if (u.startsWith('http://') || u.startsWith('https://'))
    return { id: 'generic', name: 'Website', icon: '🌐' };
  return null;
}

/* ─── Error messages (ukr) ─── */
const ERROR_MESSAGES = {
  'error.spotify.drm': 'Spotify повністю захищений DRM 🔒\nЗнайди цю ж пісню на YouTube Music — якість буде ідентична!',
  'error.api.missing_url': 'Будь ласка, вставте посилання',
  'error.all_instances_failed': 'Усі сервери тимчасово недоступні 😔\nСпробуйте через хвилину або інше посилання.',
  'error.net.unreachable': 'Не вдалося отримати доступ до цього посилання. Перевірте URL.',
  'error.api.content.unavailable': 'Цей контент недоступний або захищений.',
  'error.api.youtube.login': 'YouTube Music вимагає авторизацію для цього треку 🔒\nСпробуйте знайти цей трек через звичайний YouTube.',
  'error.api.youtube.age': 'Це відео має вікові обмеження. Спробуйте інший інстанс.',
  'error.api.youtube.decipher': 'Не вдалося розшифрувати відео. Спробуйте через хвилину.',
  'error.api.link.unsupported': 'Цей сайт або формат посилання не підтримується.',
  'error.api.fetch.empty': 'Не вдалося знайти контент за цим посиланням.',
};

function getErrorText(error) {
  if (!error) return 'Невідома помилка';
  if (typeof error === 'string') return error;
  if (error.message) return error.message;
  if (error.code && ERROR_MESSAGES[error.code]) return ERROR_MESSAGES[error.code];
  if (error.code) return `Помилка: ${error.code}`;
  return 'Щось пішло не так. Спробуйте інше посилання.';
}

/* ─── IndexedDB helpers for storing directory handle ─── */
const DB_NAME = 'InfinityDL';
const STORE_NAME = 'settings';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveDirHandle(handle) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(handle, 'dirHandle');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadDirHandle() {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get('dirHandle');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function clearDirHandle() {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete('dirHandle');
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // ignore
  }
}

/* ─── Download history (localStorage) ─── */
function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem('dl_history') || '[]');
  } catch {
    return [];
  }
}

function saveHistory(items) {
  try {
    localStorage.setItem('dl_history', JSON.stringify(items.slice(0, 50)));
  } catch {
    localStorage.setItem('dl_history', JSON.stringify(items.slice(0, 20)));
  }
}

/* ─── Check if File System Access API is available ─── */
function hasFSAccess() {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

/* ─── Format file size ─── */
function formatSize(bytes) {
  if (!bytes || bytes === 0) return '';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/* ─── Format duration ─── */
function formatDuration(seconds) {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* ─── Constants ─── */
const VIDEO_QUALITIES = [
  { value: 'max', label: 'MAX' },
  { value: '2160', label: '4K' },
  { value: '1440', label: '1440p' },
  { value: '1080', label: '1080p' },
  { value: '720', label: '720p' },
  { value: '480', label: '480p' },
  { value: '360', label: '360p' },
];

const AUDIO_FORMATS = [
  { value: 'best', label: 'Найкращий (Оригінал)' },
  { value: 'mp3', label: 'MP3' },
  { value: 'ogg', label: 'OGG' },
  { value: 'wav', label: 'WAV' },
  { value: 'opus', label: 'OPUS' },
];

const AUDIO_BITRATES = [
  { value: '320', label: '320k' },
  { value: '256', label: '256k' },
  { value: '128', label: '128k' },
  { value: '96', label: '96k' },
];

const VIDEO_CODECS = [
  { value: 'h264', label: 'H.264 (CapCut)' },
  { value: 'av1', label: 'AV1' },
  { value: 'vp9', label: 'VP9' },
];

const PLATFORMS = [
  'YouTube', 'TikTok', 'Instagram', 'Twitter/X',
  'Reddit', 'SoundCloud', 'Twitch', 'Vimeo',
  'Pinterest', 'Facebook', 'Dailymotion', '1000+',
];

const LOCAL_API = process.env.NEXT_PUBLIC_API_URL || 'https://clever-eels-trade.loca.lt';

/* ═══════════════════════════════════
   MAIN PAGE COMPONENT
   ═══════════════════════════════════ */
export default function Home() {
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState('auto');
  const [videoQuality, setVideoQuality] = useState('max');
  const [audioFormat, setAudioFormat] = useState('best');
  const [audioBitrate, setAudioBitrate] = useState('128');
  const [youtubeVideoCodec, setYoutubeVideoCodec] = useState('h264');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [picker, setPicker] = useState(null);
  const [error, setError] = useState(null);
  const [platform, setPlatform] = useState(null);

  // Download progress
  const [downloadProgress, setDownloadProgress] = useState(null);

  // Preview state
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Drag & Drop
  const [isDragging, setIsDragging] = useState(false);

  // Folder & history state
  const [dirHandle, setDirHandle] = useState(null);
  const [dirName, setDirName] = useState(null);
  const [fsSupported, setFsSupported] = useState(false);
  const [history, setHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [saveProgress, setSaveProgress] = useState(null);
  const [historyCount, setHistoryCount] = useState(0);
  const [localEngineActive, setLocalEngineActive] = useState(false);

  // Queue
  const [queue, setQueue] = useState([]);
  const [showQueue, setShowQueue] = useState(false);

  const inputRef = useRef(null);
  const pollIntervalRef = useRef(null);
  const previewTimeoutRef = useRef(null);

  // Init
  useEffect(() => {
    setFsSupported(hasFSAccess());
    setHistory(loadHistory());
    setHistoryCount(loadHistory().length);

    (async () => {
      const saved = await loadDirHandle();
      if (saved) {
        try {
          const perm = await saved.queryPermission({ mode: 'readwrite' });
          if (perm === 'granted') {
            setDirHandle(saved);
            setDirName(saved.name);
          }
        } catch {
          await clearDirHandle();
        }
      }
    })();
  }, []);

  // Detect platform on URL change
  useEffect(() => {
    setPlatform(detectPlatform(url));
  }, [url]);

  // Detect local engine
  useEffect(() => {
    fetch(`${LOCAL_API}/ping`)
      .then(res => setLocalEngineActive(res.ok))
      .catch(() => setLocalEngineActive(false));
  }, []);

  // Preview: auto-fetch metadata when URL changes (debounced)
  useEffect(() => {
    if (previewTimeoutRef.current) clearTimeout(previewTimeoutRef.current);
    setPreview(null);

    if (!url.trim() || !localEngineActive) return;
    const detectedPlatform = detectPlatform(url);
    if (!detectedPlatform) return;

    previewTimeoutRef.current = setTimeout(async () => {
      setPreviewLoading(true);
      try {
        const res = await fetch(`${LOCAL_API}/api/preview`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: url.trim() }),
        });
        const data = await res.json();
        if (data.status === 'ok') {
          setPreview(data);
        }
      } catch {
        // Preview is optional — fail silently
      } finally {
        setPreviewLoading(false);
      }
    }, 800);

    return () => clearTimeout(previewTimeoutRef.current);
  }, [url, localEngineActive]);

  // Pick a directory
  const pickFolder = useCallback(async () => {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      setDirHandle(handle);
      setDirName(handle.name);
      await saveDirHandle(handle);
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('Folder pick failed:', err);
      }
    }
  }, []);

  // Remove saved folder
  const removeFolder = useCallback(async () => {
    setDirHandle(null);
    setDirName(null);
    await clearDirHandle();
  }, []);

  // Save file directly to chosen folder via File System Access API
  async function saveToFolder(downloadUrl, filename) {
    if (!dirHandle) return false;

    try {
      const perm = await dirHandle.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        setDirHandle(null);
        setDirName(null);
        await clearDirHandle();
        return false;
      }

      setSaveProgress('saving');

      const response = await fetch(downloadUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const safeName = filename.replace(/[<>:"/\\|?*]/g, '_').trim() || 'download';
      const fileHandle = await dirHandle.getFileHandle(safeName, { create: true });
      const writable = await fileHandle.createWritable();

      if (response.body) {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await writable.write(value);
        }
      } else {
        const blob = await response.blob();
        await writable.write(blob);
      }

      await writable.close();
      setSaveProgress('saved');
      return true;
    } catch (err) {
      console.error('Save to folder failed:', err);
      setSaveProgress('error');
      return false;
    }
  }

  // Add to download history
  function addToHistory(entry) {
    const updated = [
      { ...entry, timestamp: Date.now() },
      ...history.filter((h) => h.url !== entry.url),
    ].slice(0, 50);
    setHistory(updated);
    setHistoryCount(updated.length);
    saveHistory(updated);
  }

  // Clear history
  function clearHistory() {
    setHistory([]);
    setHistoryCount(0);
    localStorage.removeItem('dl_history');
  }

  // Poll download progress
  function startPolling(jobId) {
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    
    pollIntervalRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${LOCAL_API}/api/download/progress/${jobId}`);
        const data = await res.json();
        setDownloadProgress(data);

        if (data.status === 'completed') {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
          
          setResult({
            status: 'tunnel',
            url: data.url,
            filename: data.filename,
          });

          addToHistory({
            url: url.trim(),
            filename: data.filename,
            platform: platform?.name || 'Unknown',
            mode,
          });

          // Auto-save if folder selected
          if (dirHandle && data.url && data.filename) {
            const saved = await saveToFolder(data.url, data.filename);
            if (!saved) {
              triggerDownload(data.url, data.filename);
            }
          } else {
            triggerDownload(data.url, data.filename);
          }

          setLoading(false);
          setTimeout(() => setDownloadProgress(null), 3000);
          
        } else if (data.status === 'error') {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
          setError(data.error);
          setLoading(false);
          setDownloadProgress(null);
        }
      } catch {
        // network blip — keep polling
      }
    }, 500);
  }

  // Handle download
  const handleSubmit = useCallback(async (e) => {
    if (e) e.preventDefault();
    if (!url.trim() || loading) return;

    setLoading(true);
    setResult(null);
    setPicker(null);
    setError(null);
    setSaveProgress(null);
    setDownloadProgress(null);

    try {
      if (localEngineActive) {
        // ── Local Engine: async download with progress polling ──
        const res = await fetch(`${LOCAL_API}/api/download`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: url.trim(),
            mode,
            videoQuality,
            audioFormat,
            audioBitrate,
            youtubeVideoCodec,
          }),
        });

        const data = await res.json();

        if (data.status === 'error') {
          setError(data.error);
          setLoading(false);
        } else if (data.job_id) {
          // Start polling for progress
          startPolling(data.job_id);
        } else {
          setError({ message: 'Нерозпізнана відповідь від сервера' });
          setLoading(false);
        }
      } else {
        // ── Cloud Fallback ──
        const res = await fetch('/api/download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: url.trim(),
            mode,
            videoQuality,
            audioFormat,
            audioBitrate,
            youtubeVideoCodec,
          }),
        });

        const data = await res.json();

        if (data.status === 'error') {
          setError(data.error);
        } else if (data.status === 'redirect' || data.status === 'tunnel') {
          setResult(data);
          addToHistory({
            url: url.trim(),
            filename: data.filename,
            platform: platform?.name || 'Unknown',
            mode,
          });

          if (dirHandle && data.url && data.filename) {
            const saved = await saveToFolder(data.url, data.filename);
            if (!saved) triggerDownload(data.url, data.filename);
          } else {
            triggerDownload(data.url, data.filename);
          }
        } else if (data.status === 'picker') {
          setPicker(data);
          addToHistory({
            url: url.trim(),
            filename: `Picker (${data.picker?.length || 0} items)`,
            platform: platform?.name || 'Unknown',
            mode,
          });
        } else {
          setError({ message: 'Нерозпізнана відповідь від сервера' });
        }
        setLoading(false);
      }
    } catch (err) {
      setError({ message: 'Помилка мережі. Перевірте інтернет-з\'єднання.' });
      setLoading(false);
    }
  }, [url, mode, videoQuality, audioFormat, audioBitrate, loading, dirHandle, platform, history, localEngineActive]);

  // Trigger browser download (fallback)
  function triggerDownload(downloadUrl, filename) {
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = filename || '';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // Handle picker item
  async function handlePickerItem(item) {
    if (dirHandle) {
      const saved = await saveToFolder(item.url, item.url.split('/').pop() || 'media');
      if (!saved) triggerDownload(item.url, '');
    } else {
      triggerDownload(item.url, '');
    }
  }

  // Quick re-download from history
  function handleHistoryRedownload(entry) {
    setUrl(entry.url);
    setShowHistory(false);
    setTimeout(() => inputRef.current?.focus(), 100);
  }

  // ── Queue Management ──
  function addToQueue() {
    if (!url.trim()) return;
    const entry = {
      id: Date.now(),
      url: url.trim(),
      mode,
      status: 'pending',
      platform: platform?.name || 'Unknown',
    };
    setQueue(prev => [...prev, entry]);
    setUrl('');
    setPreview(null);
    setShowQueue(true);
  }

  async function processQueue() {
    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      if (item.status !== 'pending') continue;

      setQueue(prev => prev.map((q, idx) =>
        idx === i ? { ...q, status: 'downloading' } : q
      ));

      try {
        const res = await fetch(`${LOCAL_API}/api/download`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: item.url,
            mode: item.mode,
            videoQuality,
          }),
        });
        const data = await res.json();

        if (data.job_id) {
          // Wait for this download to complete
          await new Promise((resolve) => {
            const interval = setInterval(async () => {
              const progRes = await fetch(`${LOCAL_API}/api/download/progress/${data.job_id}`);
              const progData = await progRes.json();

              if (progData.status === 'completed') {
                clearInterval(interval);
                setQueue(prev => prev.map((q, idx) =>
                  idx === i ? { ...q, status: 'completed', filename: progData.filename } : q
                ));
                // Auto-download
                if (dirHandle && progData.url && progData.filename) {
                  await saveToFolder(progData.url, progData.filename);
                } else {
                  triggerDownload(progData.url, progData.filename);
                }
                resolve();
              } else if (progData.status === 'error') {
                clearInterval(interval);
                setQueue(prev => prev.map((q, idx) =>
                  idx === i ? { ...q, status: 'error', error: progData.error } : q
                ));
                resolve();
              }
            }, 1000);
          });
        }
      } catch {
        setQueue(prev => prev.map((q, idx) =>
          idx === i ? { ...q, status: 'error', error: 'Мережева помилка' } : q
        ));
      }
    }
  }

  function removeFromQueue(id) {
    setQueue(prev => prev.filter(q => q.id !== id));
  }

  function clearQueue() {
    setQueue([]);
  }

  // ── Drag & Drop ──
  function handleDragOver(e) {
    e.preventDefault();
    setIsDragging(true);
  }

  function handleDragLeave(e) {
    e.preventDefault();
    setIsDragging(false);
  }

  function handleDrop(e) {
    e.preventDefault();
    setIsDragging(false);
    const text = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text/uri-list');
    if (text && (text.startsWith('http://') || text.startsWith('https://'))) {
      setUrl(text.trim());
      inputRef.current?.focus();
    }
  }

  // ── Paste from clipboard ──
  async function handlePaste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text && (text.startsWith('http://') || text.startsWith('https://'))) {
        setUrl(text.trim());
      }
    } catch {
      // clipboard permission denied
    }
  }

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, []);

  return (
    <main
      className="page-wrapper"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {isDragging && (
        <div className="drag-overlay">
          <div className="drag-overlay__content">
            <span className="drag-overlay__icon">📥</span>
            <span className="drag-overlay__text">Відпусти посилання тут</span>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="header">
        <h1 className="header__title">
          <span className="header__title--white">Infinity </span>
          <span className="header__title--gradient">Downloader</span>
        </h1>
        <p className="header__subtitle">
          Завантажуй відео та музику в максимальній якості з YouTube, TikTok та 1000+ сайтів
        </p>
      </header>

      {/* Folder Selector Bar */}
      {fsSupported && (
        <div className="folder-bar glass" id="folder-bar">
          <div className="folder-bar__icon">📂</div>
          {dirName ? (
            <div className="folder-bar__content">
              <div className="folder-bar__status">
                <span className="folder-bar__dot folder-bar__dot--active" />
                <span className="folder-bar__path">Завантажується в: <strong>{dirName}</strong></span>
              </div>
              <div className="folder-bar__actions">
                <button className="folder-bar__btn" onClick={pickFolder}>Змінити</button>
                <button className="folder-bar__btn folder-bar__btn--danger" onClick={removeFolder}>✕</button>
              </div>
            </div>
          ) : (
            <div className="folder-bar__content">
              <span className="folder-bar__hint">Обери папку для автоматичного збереження</span>
              <button className="folder-bar__btn folder-bar__btn--primary" onClick={pickFolder}>
                Обрати папку
              </button>
            </div>
          )}
        </div>
      )}

      {/* Main Downloader Card */}
      <section className="downloader glass" id="downloader-card">
        {/* Platform & Engine Badges */}
        <div className="badges-row">
          <span className={`platform-badge platform-badge--${platform?.id || 'generic'} ${platform ? 'platform-badge--visible' : ''}`}>
            {platform?.icon} {platform?.name}
          </span>
          <span className={`platform-badge platform-badge--visible engine-badge ${localEngineActive ? 'engine-badge--local' : 'engine-badge--cloud'}`}>
            {localEngineActive ? '⚡ Local Engine' : '☁️ Cloud API'}
          </span>
        </div>

        {/* Format Selector */}
        <div className="format-selector" role="radiogroup" aria-label="Download mode">
          <label className="format-option">
            <input type="radio" name="mode" value="auto" checked={mode === 'auto'} onChange={() => setMode('auto')} />
            <span className="format-option__label">🎬 Відео (Max)</span>
          </label>
          <label className="format-option">
            <input type="radio" name="mode" value="audio" checked={mode === 'audio'} onChange={() => setMode('audio')} />
            <span className="format-option__label">🎵 Тільки аудіо</span>
          </label>
        </div>

        {/* Advanced Options Toggle */}
        <div style={{ textAlign: 'center', marginBottom: '1rem' }}>
          <button type="button" className="history-toggle" onClick={() => setShowAdvanced(!showAdvanced)} style={{ display: 'inline-flex', padding: '0.5rem 1rem', background: 'rgba(255,255,255,0.05)' }}>
            <span>⚙️ Налаштування якості</span>
            <span className={`history-toggle__chevron ${showAdvanced ? 'history-toggle__chevron--open' : ''}`}>▾</span>
          </button>
        </div>

        <div style={{ display: showAdvanced ? 'block' : 'none' }}>
          {/* Video Quality Picker */}
          <div className={`quality-section ${mode === 'auto' ? 'quality-section--visible' : ''}`}>
          <span className="quality-label">Якість відео</span>
          <div className="quality-chips" role="radiogroup" aria-label="Video quality">
            {VIDEO_QUALITIES.map((q) => (
              <label className="quality-chip" key={q.value}>
                <input type="radio" name="quality" value={q.value} checked={videoQuality === q.value} onChange={() => setVideoQuality(q.value)} />
                <span className="quality-chip__label">{q.label}</span>
              </label>
            ))}
          </div>
          <span className="quality-label" style={{ marginTop: '0.75rem' }}>Кодек відео (H.264 найкраще для CapCut)</span>
          <div className="quality-chips" role="radiogroup" aria-label="Video codec">
            {VIDEO_CODECS.map((c) => (
              <label className="quality-chip" key={c.value}>
                <input type="radio" name="codec" value={c.value} checked={youtubeVideoCodec === c.value} onChange={() => setYoutubeVideoCodec(c.value)} />
                <span className="quality-chip__label">{c.label}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Audio Format & Bitrate */}
        <div className={`audio-format-section ${mode === 'audio' ? 'audio-format-section--visible' : ''}`}>
          <span className="quality-label">Формат аудіо</span>
          <div className="quality-chips" role="radiogroup" aria-label="Audio format" style={{ marginBottom: '0.75rem' }}>
            {AUDIO_FORMATS.map((f) => (
              <label className="quality-chip" key={f.value}>
                <input type="radio" name="audioFormat" value={f.value} checked={audioFormat === f.value} onChange={() => setAudioFormat(f.value)} />
                <span className="quality-chip__label">{f.label}</span>
              </label>
            ))}
          </div>
          <span className="quality-label">Бітрейт</span>
          <div className="quality-chips" role="radiogroup" aria-label="Audio bitrate">
            {AUDIO_BITRATES.map((b) => (
              <label className="quality-chip" key={b.value}>
                <input type="radio" name="audioBitrate" value={b.value} checked={audioBitrate === b.value} onChange={() => setAudioBitrate(b.value)} />
                <span className="quality-chip__label">{b.label}</span>
              </label>
            ))}
          </div>
        </div>
        </div>

        {/* URL Input */}
        <form onSubmit={handleSubmit} id="download-form">
          <div className="input-group">
            <svg className="input-group__icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
            </svg>
            <input
              ref={inputRef}
              type="url"
              className="input-group__field"
              id="url-input"
              placeholder="Встав посилання на відео чи пісню..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
              autoComplete="off"
            />
            {/* Paste button */}
            <button type="button" className="btn-paste" onClick={handlePaste} title="Вставити з буфера">
              📋
            </button>
            <button type="submit" className="btn-download" id="download-btn" disabled={loading || !url.trim()}>
              <span className="btn-download__text">
                {loading ? (
                  <><span className="spinner" /> Завантаження...</>
                ) : (
                  <>⚡ Завантажити</>
                )}
              </span>
              <div className="btn-download__shimmer" />
            </button>
          </div>
          {/* Queue button */}
          {localEngineActive && url.trim() && !loading && (
            <div style={{ textAlign: 'center', marginTop: '0.5rem' }}>
              <button type="button" className="btn-queue" onClick={addToQueue}>
                ➕ Додати в чергу
              </button>
            </div>
          )}
        </form>

        {/* Preview Card */}
        {(preview || previewLoading) && (
          <div className="preview-card">
            {previewLoading ? (
              <div className="preview-card__loading">
                <span className="spinner" /> Завантаження прев'ю...
              </div>
            ) : preview && (
              <>
                {preview.thumbnail && (
                  <div className="preview-card__thumb">
                    <img src={preview.thumbnail} alt={preview.title} />
                    {preview.duration > 0 && (
                      <span className="preview-card__duration">{formatDuration(preview.duration)}</span>
                    )}
                  </div>
                )}
                <div className="preview-card__info">
                  <div className="preview-card__title">{preview.title}</div>
                  <div className="preview-card__meta">
                    {preview.uploader && <span>{preview.uploader}</span>}
                    {preview.view_count > 0 && <span>👁 {preview.view_count.toLocaleString('uk-UA')}</span>}
                    {preview.filesize_approx > 0 && <span>💾 ~{formatSize(preview.filesize_approx)}</span>}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* Download Progress Bar */}
        {downloadProgress && (downloadProgress.status === 'downloading' || downloadProgress.status === 'processing' || downloadProgress.status === 'starting') && (
          <div className="progress" id="progress-bar">
            <div className="progress__header">
              <span>{downloadProgress.status === 'processing' ? '🔄 Обробка...' : '📥 Завантаження...'}</span>
              <span>{downloadProgress.percent || 0}%</span>
            </div>
            <div className="progress__bar-bg">
              <div
                className="progress__bar-fill"
                style={{ width: `${downloadProgress.percent || 0}%` }}
              />
            </div>
            <div className="progress__footer">
              <span>{downloadProgress.speed || ''}</span>
              <span>{downloadProgress.eta ? `⏱ ${downloadProgress.eta}` : ''}</span>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="message message--error" id="error-message">
            {getErrorText(error)}
          </div>
        )}

        {/* Save Progress Indicator */}
        {saveProgress === 'saving' && (
          <div className="message message--info">
            <span className="spinner" style={{ marginRight: '0.5rem' }} />
            Зберігаю в папку <strong>{dirName}</strong>...
          </div>
        )}

        {/* Success Result */}
        {result && (
          <div className="result" id="result-card">
            <div className="result__title">
              {saveProgress === 'saved' ? '✅ Збережено в папку!' : '✅ Готово!'}
            </div>
            {result.filename && (
              <div className="result__filename">{result.filename}</div>
            )}
            {saveProgress === 'saved' && dirName && (
              <div className="result__folder-info">
                📂 Збережено в: <strong>{dirName}</strong>
              </div>
            )}
            {saveProgress !== 'saved' && (
              <a href={result.url} className="btn-save" target="_blank" rel="noopener noreferrer" download={result.filename || ''}>
                💾 Зберегти файл
              </a>
            )}
          </div>
        )}

        {/* Picker — Multiple items */}
        {picker && (
          <div className="picker" id="picker-section">
            <div className="picker__title">
              📎 Обери що завантажити ({picker.picker?.length || 0} елементів)
              {dirName && <span className="picker__folder-hint"> → зберігається в {dirName}</span>}
            </div>
            {picker.audio && (
              <div style={{ marginBottom: '0.75rem' }}>
                <button className="btn-save" onClick={() => handlePickerItem({ url: picker.audio })} style={{ fontSize: '0.85rem', padding: '0.5rem 1rem' }}>
                  🎵 Завантажити аудіо-трек
                </button>
              </div>
            )}
            <div className="picker__grid">
              {picker.picker?.map((item, i) => (
                <div key={i} className="picker__item" onClick={() => handlePickerItem(item)} title={`Завантажити ${item.type} #${i + 1}`}>
                  {item.thumb ? (
                    <img src={item.thumb} alt={`Item ${i + 1}`} loading="lazy" />
                  ) : (
                    <span style={{ fontSize: '2rem' }}>
                      {item.type === 'photo' ? '🖼️' : item.type === 'video' ? '🎬' : '📄'}
                    </span>
                  )}
                  <div className="picker__item-overlay">
                    <span className="picker__item-label">
                      {item.type === 'photo' ? '📥 Фото' : item.type === 'video' ? '📥 Відео' : '📥 GIF'} #{i + 1}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* Download Queue */}
      {localEngineActive && queue.length > 0 && (
        <section className="history-section glass" id="queue-section">
          <button className="history-toggle" onClick={() => setShowQueue(!showQueue)}>
            <span className="history-toggle__icon">📦</span>
            <span>Черга завантажень</span>
            <span className="history-toggle__badge">{queue.length}</span>
            <span className={`history-toggle__chevron ${showQueue ? 'history-toggle__chevron--open' : ''}`}>▾</span>
          </button>

          {showQueue && (
            <div className="history-list" id="queue-list">
              <div className="history-actions">
                <button className="btn-queue" onClick={processQueue} disabled={queue.every(q => q.status !== 'pending')}>
                  ▶ Завантажити все
                </button>
                <button className="history-clear" onClick={clearQueue} style={{ marginLeft: '0.5rem' }}>🗑️ Очистити</button>
              </div>
              {queue.map((item) => (
                <div key={item.id} className="history-item">
                  <div className="history-item__icon">
                    {item.status === 'completed' ? '✅' : item.status === 'downloading' ? '⏳' : item.status === 'error' ? '❌' : '⏸️'}
                  </div>
                  <div className="history-item__info">
                    <div className="history-item__name">{item.filename || item.url}</div>
                    <div className="history-item__meta">
                      {item.platform} · {item.mode === 'audio' ? '🎵 Аудіо' : '🎬 Відео'}
                      {item.error && <span style={{ color: '#f87171' }}> · {item.error}</span>}
                    </div>
                  </div>
                  <div className="history-item__action" onClick={() => removeFromQueue(item.id)}>✕</div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Download History */}
      <section className="history-section glass" id="history-section">
        <button className="history-toggle" onClick={() => setShowHistory(!showHistory)} id="history-toggle">
          <span className="history-toggle__icon">📋</span>
          <span>Історія завантажень</span>
          {historyCount > 0 && <span className="history-toggle__badge">{historyCount}</span>}
          <span className={`history-toggle__chevron ${showHistory ? 'history-toggle__chevron--open' : ''}`}>▾</span>
        </button>

        {showHistory && (
          <div className="history-list" id="history-list">
            {history.length === 0 ? (
              <div className="history-empty">Поки що нічого не завантажували</div>
            ) : (
              <>
                <div className="history-actions">
                  <button className="history-clear" onClick={clearHistory}>🗑️ Очистити</button>
                </div>
                {history.map((item, i) => (
                  <div key={i} className="history-item" onClick={() => handleHistoryRedownload(item)}>
                    <div className="history-item__icon">
                      {item.mode === 'audio' ? '🎵' : '🎬'}
                    </div>
                    <div className="history-item__info">
                      <div className="history-item__name">{item.filename || item.url}</div>
                      <div className="history-item__meta">
                        {item.platform} · {new Date(item.timestamp).toLocaleDateString('uk-UA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                    <div className="history-item__action">↻</div>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </section>

      {/* Features */}
      <section className="features glass">
        <h3 className="features__title">Можливості</h3>
        <ul className="features__grid">
          <li className="features__item"><span className="features__icon">✨</span> Максимальна якість (до 8K)</li>
          <li className="features__item"><span className="features__icon">⚡</span> Прогрес завантаження</li>
          <li className="features__item"><span className="features__icon">🎵</span> MP3 320kbps аудіо</li>
          <li className="features__item"><span className="features__icon">📦</span> Черга завантажень</li>
          <li className="features__item"><span className="features__icon">🖼️</span> Прев'ю перед завантаженням</li>
          <li className="features__item"><span className="features__icon">📂</span> Автозбереження в папку</li>
          <li className="features__item"><span className="features__icon">🔄</span> Drag & Drop посилань</li>
          <li className="features__item"><span className="features__icon">🛡️</span> Без реклами та трекерів</li>
        </ul>
        <div className="platforms-strip">
          {PLATFORMS.map((p) => (
            <span className="platforms-strip__badge" key={p}>{p}</span>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="footer">
        Infinity Downloader · Powered by Local Engine + yt-dlp
      </footer>
    </main>
  );
}
