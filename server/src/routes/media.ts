import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import multer from 'multer';
import sharp from 'sharp';
import { prisma } from '../db';
import { config } from '../config';
import { requireAuth, type AuthedRequest } from '../middleware/auth';
import { logEvent } from '../services/events';

export const mediaRouter = Router();
mediaRouter.use(requireAuth);

fs.mkdirSync(config.paths.uploads, { recursive: true });
fs.mkdirSync(config.paths.thumbs, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, config.paths.uploads),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().slice(0, 10);
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/quicktime', 'video/webm']);

export const upload = multer({
  storage,
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED.has(file.mimetype)) return cb(null, true);
    cb(new Error('Only JPEG/PNG/WebP/GIF images and MP4/MOV/WebM videos are allowed'));
  },
});

mediaRouter.post('/upload', (req: AuthedRequest, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });

    const relPath = `/uploads/${file.filename}`;
    let width: number | undefined;
    let height: number | undefined;
    let thumbPath: string | null = null;

    if (file.mimetype.startsWith('image/')) {
      try {
        const meta = await sharp(file.path).metadata();
        width = meta.width;
        height = meta.height;
        const thumbName = `thumb-${file.filename.replace(/\.[^.]+$/, '')}.jpg`;
        const thumbAbs = path.join(config.paths.thumbs, thumbName);
        await sharp(file.path).resize({ width: 480, withoutEnlargement: true }).jpeg({ quality: 78 }).toFile(thumbAbs);
        thumbPath = `/uploads/thumbs/${thumbName}`;
      } catch {
        thumbPath = null; // animated gif etc. — thumbnail optional
      }
    }

    const asset = await prisma.mediaAsset.create({
      data: {
        userId: req.userId!,
        filename: file.originalname,
        path: relPath,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        thumbnailPath: thumbPath,
        width,
        height,
      },
    });
    await logEvent({ level: 'success', message: `Media uploaded: ${file.originalname}`, meta: { assetId: asset.id } });
    res.status(201).json({ asset });
  });
});

mediaRouter.get('/', async (req: AuthedRequest, res) => {
  const assets = await prisma.mediaAsset.findMany({
    where: { userId: req.userId },
    orderBy: { createdAt: 'desc' },
    take: 300,
  });
  res.json({ assets });
});

mediaRouter.delete('/:id', async (req: AuthedRequest, res) => {
  const asset = await prisma.mediaAsset.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  for (const p of [asset.path, asset.thumbnailPath]) {
    if (!p) continue;
    const abs = path.join(config.paths.uploads, path.basename(path.dirname(p)) === 'thumbs' ? `thumbs/${path.basename(p)}` : path.basename(p));
    try {
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    } catch {
      /* best effort */
    }
  }
  await prisma.mediaAsset.delete({ where: { id: asset.id } });
  await logEvent({ level: 'info', message: `Media deleted: ${asset.filename}` });
  res.json({ ok: true });
});
