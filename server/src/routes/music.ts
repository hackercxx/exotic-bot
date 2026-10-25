import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import multer from 'multer';
import { prisma } from '../db';
import { config } from '../config';
import { requireAuth, type AuthedRequest } from '../middleware/auth';
import { logEvent } from '../services/events';

export const musicRouter = Router();
musicRouter.use(requireAuth);

fs.mkdirSync(config.paths.uploads, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, config.paths.uploads),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().slice(0, 10);
    cb(null, `track-${Date.now()}-${crypto.randomBytes(5).toString('hex')}${ext}`);
  },
});

const AUDIO = new Set(['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/webm', 'audio/flac', 'audio/aac', 'audio/mp4']);
const audioUpload = multer({
  storage,
  limits: { fileSize: 60 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (AUDIO.has(file.mimetype) || /\.(mp3|wav|ogg|flac|aac|m4a)$/i.test(file.originalname)) return cb(null, true);
    cb(new Error('Only audio files are allowed (mp3, wav, ogg, flac, m4a)'));
  },
});

const coverUpload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => (file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Cover must be an image'))),
});

function basename(p: string) {
  // stored paths look like /uploads/track-x.mp3 → disk path under uploads/
  return path.join(config.paths.uploads, path.basename(p));
}

musicRouter.get('/tracks', async (req: AuthedRequest, res) => {
  const tracks = await prisma.track.findMany({ where: { userId: req.userId }, orderBy: { createdAt: 'desc' }, take: 500 });
  res.json({ tracks });
});

musicRouter.post('/tracks', (req: AuthedRequest, res) => {
  audioUpload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No audio file received' });
    const fallbackTitle = path.basename(req.file.originalname, path.extname(req.file.originalname));
    const track = await prisma.track.create({
      data: {
        userId: req.userId!,
        title: String(req.body?.title || fallbackTitle).slice(0, 200),
        artist: String(req.body?.artist || 'Unknown Artist').slice(0, 200),
        genre: String(req.body?.genre || 'Uncategorized').slice(0, 100),
        audioPath: `/uploads/${req.file.filename}`,
        durationMs: req.body?.durationMs ? Number(req.body.durationMs) : null,
      },
    });
    await logEvent({ level: 'success', message: `Track added: ${track.title} — ${track.artist}` });
    res.status(201).json({ track });
  });
});

musicRouter.patch('/tracks/:id', async (req: AuthedRequest, res) => {
  const track = await prisma.track.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!track) return res.status(404).json({ error: 'Track not found' });
  const data: Record<string, unknown> = {};
  if (typeof req.body?.title === 'string') data.title = req.body.title.slice(0, 200);
  if (typeof req.body?.artist === 'string') data.artist = req.body.artist.slice(0, 200);
  if (typeof req.body?.genre === 'string') data.genre = req.body.genre.slice(0, 100);
  if (req.body?.durationMs !== undefined) data.durationMs = Number(req.body.durationMs) || null;
  const updated = await prisma.track.update({ where: { id: track.id }, data });
  res.json({ track: updated });
});

musicRouter.post('/tracks/:id/cover', (req: AuthedRequest, res) => {
  coverUpload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const track = await prisma.track.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!track) return res.status(404).json({ error: 'Track not found' });
    if (!req.file) return res.status(400).json({ error: 'No cover image received' });
    const updated = await prisma.track.update({
      where: { id: track.id },
      data: { coverPath: `/uploads/${req.file.filename}` },
    });
    res.json({ track: updated });
  });
});

/** Streams the real audio file with HTTP range support (HTML5 <audio>). */
musicRouter.get('/tracks/:id/stream', async (req: AuthedRequest, res) => {
  const track = await prisma.track.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!track) return res.status(404).json({ error: 'Track not found' });
  const abs = basename(track.audioPath);
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'Audio file missing on disk' });
  res.sendFile(abs, { dotfiles: 'deny' });
});

musicRouter.delete('/tracks/:id', async (req: AuthedRequest, res) => {
  const track = await prisma.track.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!track) return res.status(404).json({ error: 'Track not found' });
  for (const p of [track.audioPath, track.coverPath]) {
    if (!p) continue;
    try {
      const abs = basename(p);
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    } catch {
      /* best effort */
    }
  }
  await prisma.track.delete({ where: { id: track.id } });
  await logEvent({ level: 'info', message: `Track removed: ${track.title}` });
  res.json({ ok: true });
});

/**
 * "Share to post" (§4.6): attaches the track's metadata as a caption suggestion.
 * Real audio on Instagram must be baked into a video — this returns the helper
 * hint so the UI can offer the video+audio mux path (requires ffmpeg on host).
 */
musicRouter.post('/tracks/:id/share-to-post', async (req: AuthedRequest, res) => {
  const track = await prisma.track.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!track) return res.status(404).json({ error: 'Track not found' });
  const platform = req.body?.platform === 'WHATSAPP' ? 'WHATSAPP' : 'INSTAGRAM';
  const caption = [
    `🎵 ${track.title}`,
    `by ${track.artist}`,
    track.genre && track.genre !== 'Uncategorized' ? `Genre: ${track.genre}` : null,
    '',
    'Shared from the EXOTIC BOT music library',
  ]
    .filter((l) => l !== null)
    .join('\n');
  const post = await prisma.post.create({
    data: {
      userId: req.userId!,
      platform,
      caption,
      mediaType: 'NONE',
      status: 'DRAFT',
      mediaUrl: null,
    },
  });
  await logEvent({ level: 'info', message: `Share-to-post draft created from “${track.title}”`, meta: { postId: post.id } });
  res.status(201).json({
    post,
    caption,
    hint: 'Instagram publishes require image/video media. To attach this audio, mux it into an MP4 (ffmpeg -i video.mp4 -i track.mp3 -c:v copy -shortest out.mp4), upload it in Content → Media, then schedule.',
  });
});
