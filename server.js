// Small local server: serves the frontend, and downloads audio from
// YouTube/SoundCloud links using yt-dlp + ffmpeg (both must be installed
// separately, e.g. `brew install yt-dlp ffmpeg`).
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile, exec } = require('child_process');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const PREVIEWS_DIR = path.join(__dirname, 'previews');
const WAVEFORMS_DIR = path.join(__dirname, 'waveforms');
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR);
if (!fs.existsSync(PREVIEWS_DIR)) fs.mkdirSync(PREVIEWS_DIR);
if (!fs.existsSync(WAVEFORMS_DIR)) fs.mkdirSync(WAVEFORMS_DIR);

const WAVEFORM_BUCKETS = 1200; // resolution of the waveform overview
const WAVEFORM_SAMPLE_RATE = 4000; // low rate: plenty of detail for an overview, keeps decode fast

// The track library (names, markers, sections, queue) is saved here so it
// survives a server restart — the audio files themselves already do,
// since they just sit in downloads/, but this metadata previously only
// lived in the browser tab's memory.
const LIBRARY_FILE = path.join(__dirname, 'library.json');
function loadLibrary() {
  try {
    return JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8'));
  } catch {
    return { tracks: [], sectionQueue: [], currentTrackId: null };
  }
}

// Previews are throwaway clips — clear old ones out on each server start
// so they don't pile up.
for (const file of fs.readdirSync(PREVIEWS_DIR)) {
  fs.unlinkSync(path.join(PREVIEWS_DIR, file));
}

const PREVIEW_SECONDS = 20;
const upload = multer({ dest: DOWNLOADS_DIR, limits: { fileSize: 1024 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Spotify's OAuth login redirects the browser back here with a ?code=...
// The whole token exchange happens client-side (PKCE needs no server
// secret), so this just needs to serve the same page as "/".
app.get('/callback', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use('/downloads', express.static(DOWNLOADS_DIR));
app.use('/previews', express.static(PREVIEWS_DIR));

// Keep this tool scoped to what it's meant for (personal soundtrack
// prep), rather than a general-purpose "download anything" endpoint.
function isAllowedUrl(url) {
  try {
    const { hostname } = new URL(url);
    return /(^|\.)youtube\.com$|^youtu\.be$|(^|\.)soundcloud\.com$/i.test(hostname);
  } catch {
    return false;
  }
}

// Picks a thumbnail that's big enough to look decent but not full
// resolution — this is just for a small UI square, not a poster.
function pickThumbnail(thumbnails) {
  if (!Array.isArray(thumbnails) || !thumbnails.length) return null;
  const sized = thumbnails.filter(t => t.url && t.width).sort((a, b) => a.width - b.width);
  if (!sized.length) return thumbnails[thumbnails.length - 1].url || null;
  const target = sized.find(t => t.width >= 100) || sized[sized.length - 1];
  return target.url;
}

app.post('/api/search', (req, res) => {
  const { query, source } = req.body || {};
  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: 'Please enter something to search for.' });
  }

  // ytsearchN:/scsearchN: are yt-dlp's built-in search prefixes — no API key needed.
  const prefix = source === 'soundcloud' ? 'scsearch5' : 'ytsearch5';

  execFile('yt-dlp', [
    '--flat-playlist',
    '-j',
    `${prefix}:${query.trim()}`
  ], { timeout: 30 * 1000, maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
    if (err) {
      console.error(stderr || err.message);
      return res.status(500).json({ error: 'Search failed. Try again in a moment.' });
    }
    const results = stdout.trim().split('\n').filter(Boolean).map(line => {
      try {
        const entry = JSON.parse(line);
        return {
          title: entry.title,
          duration: entry.duration || null,
          uploader: entry.uploader || entry.channel || '',
          url: entry.webpage_url || entry.url,
          image: pickThumbnail(entry.thumbnails)
        };
      } catch {
        return null;
      }
    }).filter(Boolean);
    res.json({ results });
  });
});

app.post('/api/preview', (req, res) => {
  const { url } = req.body || {};
  if (!url || !isAllowedUrl(url)) {
    return res.status(400).json({ error: 'Please provide a valid YouTube or SoundCloud URL.' });
  }

  const id = crypto.randomBytes(6).toString('hex');
  const outputTemplate = path.join(PREVIEWS_DIR, `${id}.%(ext)s`);
  const isYoutube = /youtube\.com|youtu\.be/i.test(new URL(url).hostname);

  const args = [
    '-x', '--audio-format', 'mp3',
    '--download-sections', `*0-${PREVIEW_SECONDS}`,
    '--no-playlist',
    '--socket-timeout', '15'
  ];
  // The "android" client is what lets yt-dlp fetch just this short section
  // instead of the whole file — other clients require extra auth tokens
  // for partial downloads and fail with a 403.
  if (isYoutube) args.push('--extractor-args', 'youtube:player_client=android');
  args.push('--output', outputTemplate, '--print', 'after_move:filepath', url);

  execFile('yt-dlp', args, { timeout: 30 * 1000, maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
    if (err) {
      console.error(stderr || err.message);
      return res.status(500).json({ error: 'Preview failed for this link.' });
    }
    const filePath = stdout.trim().split('\n').filter(Boolean).pop();
    if (!filePath) {
      return res.status(500).json({ error: 'Preview finished but the file could not be located.' });
    }
    res.json({ url: `/previews/${encodeURIComponent(path.basename(filePath))}` });
  });
});

function runYtDlpDownload(url, outputTemplate, extraArgs, callback) {
  execFile('yt-dlp', [
    '-x', '--audio-format', 'mp3',
    '--no-playlist',
    '--output', outputTemplate,
    // yt-dlp's JSON-dict print bundles both fields into one properly-escaped
    // JSON object, so there's no risk of a title/thumbnail containing some
    // separator string and corrupting the parse (a plain string join with a
    // hand-picked delimiter would have exactly that risk).
    '--print', 'after_move:%(.{thumbnail,filepath})j',
    ...extraArgs,
    url
  ], { timeout: 5 * 60 * 1000, maxBuffer: 1024 * 1024 * 10 }, callback);
}

app.post('/api/download', (req, res) => {
  const { url } = req.body || {};
  if (!url || !isAllowedUrl(url)) {
    return res.status(400).json({ error: 'Please provide a valid YouTube or SoundCloud URL.' });
  }

  // Random id prefix avoids filename collisions between different downloads.
  const id = crypto.randomBytes(6).toString('hex');
  const outputTemplate = path.join(DOWNLOADS_DIR, `${id} - %(title)s.%(ext)s`);
  const isYoutube = /youtube\.com|youtu\.be/i.test(new URL(url).hostname);

  const finish = (err, stdout, stderr) => {
    if (err) {
      console.error(stderr || err.message);
      return res.status(500).json({ error: 'Download failed. The link may be private, region-locked, or unsupported.' });
    }
    const line = stdout.trim().split('\n').filter(Boolean).pop();
    if (!line) {
      return res.status(500).json({ error: 'Download finished but the file could not be located.' });
    }
    let thumbnail, filePath;
    try {
      ({ thumbnail, filepath: filePath } = JSON.parse(line));
    } catch {
      return res.status(500).json({ error: 'Download finished but the result could not be parsed.' });
    }
    const filename = path.basename(filePath);
    // Strip the leading "id - " prefix for a cleaner display name.
    const displayName = filename.replace(/^[0-9a-f]{12} - /, '').replace(/\.mp3$/, '');
    res.json({
      name: displayName,
      url: `/downloads/${encodeURIComponent(filename)}`,
      image: thumbnail || null
    });
  };

  runYtDlpDownload(url, outputTemplate, [], (err, stdout, stderr) => {
    if (err && isYoutube) {
      // YouTube periodically reshuffles which "client" yt-dlp's default
      // format selection works with, and some videos 403 with whatever
      // that default currently is. The "android" client (also used for
      // previews) tends to still work when that happens, so it's worth
      // one automatic retry before giving up.
      console.error('Default download failed, retrying with the android client:', stderr || err.message);
      runYtDlpDownload(url, outputTemplate, ['--extractor-args', 'youtube:player_client=android'], finish);
    } else {
      finish(err, stdout, stderr);
    }
  });
});

// Local file uploads are saved into the same downloads folder as
// yt-dlp downloads, so every track (uploaded or fetched) can be
// waveform-generated the same way below.
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file received.' });
  }
  const ext = path.extname(req.file.originalname) || '';
  const finalFilename = req.file.filename + ext;
  fs.renameSync(req.file.path, path.join(DOWNLOADS_DIR, finalFilename));
  res.json({ name: req.file.originalname, url: `/downloads/${encodeURIComponent(finalFilename)}` });
});

// Resolves a "/downloads/xxx.mp3" URL (as returned by our own upload/
// download/preview endpoints) to the real file on disk, refusing
// anything that isn't actually inside our downloads folder.
function resolveDownloadPath(relativeUrl) {
  if (typeof relativeUrl !== 'string' || !relativeUrl.startsWith('/downloads/')) return null;
  const filename = decodeURIComponent(relativeUrl.slice('/downloads/'.length));
  const fullPath = path.join(DOWNLOADS_DIR, filename);
  if (!fullPath.startsWith(DOWNLOADS_DIR + path.sep)) return null; // blocks ../ escapes
  return fullPath;
}

// Downsamples raw PCM into one peak (0-1) per bucket, for a fast
// Audacity-style amplitude overview of the whole track.
function computePeaks(pcmBuffer, buckets) {
  const samples = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, Math.floor(pcmBuffer.length / 2));
  const bucketSize = Math.max(1, Math.ceil(samples.length / buckets));
  const peaks = new Array(buckets).fill(0);
  for (let b = 0; b < buckets; b++) {
    const start = b * bucketSize;
    const end = Math.min(start + bucketSize, samples.length);
    let max = 0;
    for (let i = start; i < end; i++) {
      const v = Math.abs(samples[i]);
      if (v > max) max = v;
    }
    peaks[b] = +(max / 32768).toFixed(3);
  }
  return peaks;
}

app.post('/api/waveform', (req, res) => {
  const { url } = req.body || {};
  const sourcePath = resolveDownloadPath(url);
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return res.status(400).json({ error: 'Unknown track.' });
  }

  const cacheKey = crypto.createHash('sha1').update(sourcePath).digest('hex');
  const cachedPath = path.join(WAVEFORMS_DIR, `${cacheKey}.json`);

  if (fs.existsSync(cachedPath)) {
    return res.json({ peaks: JSON.parse(fs.readFileSync(cachedPath, 'utf8')) });
  }

  // Decoding to raw PCM and computing peaks ourselves is dramatically
  // faster than ffmpeg's own showwavespic filter (~7s vs ~90s on a
  // 2-hour file) — plain decode runs at ~900x realtime.
  execFile('ffmpeg', [
    '-i', sourcePath,
    '-f', 's16le', '-ac', '1', '-ar', String(WAVEFORM_SAMPLE_RATE),
    'pipe:1'
  ], { encoding: 'buffer', maxBuffer: 300 * 1024 * 1024, timeout: 120 * 1000 }, (err, stdout, stderr) => {
    if (err) {
      console.error((stderr && stderr.toString()) || err.message);
      return res.status(500).json({ error: 'Could not generate a waveform for this track.' });
    }
    const peaks = computePeaks(stdout, WAVEFORM_BUCKETS);
    fs.writeFileSync(cachedPath, JSON.stringify(peaks));
    res.json({ peaks });
  });
});

app.get('/api/library', (req, res) => {
  res.json(loadLibrary());
});

app.post('/api/library', (req, res) => {
  const { tracks, sectionQueue, currentTrackId } = req.body || {};
  if (!Array.isArray(tracks)) {
    return res.status(400).json({ error: 'Invalid library data.' });
  }
  fs.writeFileSync(LIBRARY_FILE, JSON.stringify({
    tracks,
    sectionQueue: Array.isArray(sectionQueue) ? sectionQueue : [],
    currentTrackId: currentTrackId || null
  }, null, 2));
  res.json({ ok: true });
});

// Opens the app in the default browser. 127.0.0.1 (not "localhost") matters
// here — it's the exact origin Spotify's login redirect is registered for.
function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? `open "${url}"`
    : platform === 'win32' ? `start "" "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) console.log(`Could not auto-open a browser — open ${url} manually.`);
  });
}

app.listen(PORT, () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`TTRPG Music App running at ${url}`);
  openBrowser(url);
});
