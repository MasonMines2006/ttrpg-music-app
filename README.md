# ttrpg-music-app

Loop sections of a soundtrack for tabletop games — pick a track, mark section
boundaries, and loop the current section until you click "Next Section"
(e.g. right when you finish reading a room description out loud). You can
also pull audio straight from a YouTube or SoundCloud link.

## Setup

Requires [Node.js](https://nodejs.org), `ffmpeg`, and `yt-dlp`:

```
brew install ffmpeg yt-dlp
npm install
npm start
```

Then open http://localhost:3000

## Note on the YouTube/SoundCloud import

This downloads audio to your own computer for personal use only (e.g. DM
prep) — it doesn't upload, host, or share anything. Downloading from YouTube
does technically go against its Terms of Service, so only use this for music
you have the right to use for your own sessions.