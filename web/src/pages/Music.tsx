import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  MusicNotes,
  UploadSimple,
  Play,
  Pause,
  Sparkle,
  Trash,
  SkipForward,
} from '@phosphor-icons/react';
import { api, getToken, ApiError } from '../lib/api';
import { pushToast, bumpRev } from '../lib/store';
import { fmtDur, relTime } from '../lib/format';
import { Page, PageHeader, GlassCard, Button, Badge, Field, Input, Spinner, EmptyState } from '../components/ui';
import type { Track } from '../lib/types';

async function uploadTrack(file: File, title: string, artist: string, genre: string): Promise<Track> {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('title', title);
  fd.append('artist', artist);
  fd.append('genre', genre);
  const res = await fetch('/api/music/tracks', {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken()}` },
    body: fd,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.error || 'Upload failed', res.status);
  return data.track as Track;
}

/**
 * Music page (§4.6): real <audio> playback of uploaded files, animated
 * waveform bound to actual audio (Web Audio analyser), full-title playlist,
 * share-to-post caption helper.
 */
export function Music() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [genre, setGenre] = useState('');

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number>(0);
  const dataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);

  const active = tracks.find((t) => t.id === activeId) || null;

  const load = useCallback(() => {
    api<{ tracks: Track[] }>('/music/tracks')
      .then((r) => setTracks(r.tracks))
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  // ── waveform: analyser bound to the real <audio> element ──────────
  const ensureAudioGraph = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return null;
    if (!ctxRef.current) {
      try {
        const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new Ctor();
        const source = ctx.createMediaElementSource(audio);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 128;
        analyser.smoothingTimeConstant = 0.82;
        source.connect(analyser);
        analyser.connect(ctx.destination);
        ctxRef.current = ctx;
        analyserRef.current = analyser;
        dataRef.current = new Uint8Array(analyser.frequencyBinCount);
      } catch (err) {
        pushToast('error', 'Audio graph failed', err instanceof Error ? err.message : '');
        return null;
      }
    }
    void ctxRef.current?.resume().catch(() => undefined);
    return analyserRef.current;
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const analyser = analyserRef.current;
    if (!canvas || !analyser || !dataRef.current) return;
    const g = canvas.getContext('2d');
    if (!g) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    analyser.getByteFrequencyData(dataRef.current);
    const bins = dataRef.current.length;
    const bars = Math.min(48, bins);
    const gap = 3;
    const barW = (w - gap * (bars - 1)) / bars;

    for (let i = 0; i < bars; i++) {
      const value = dataRef.current[Math.floor((i / bars) * bins)] / 255;
      const barH = Math.max(3, value * h);
      const x = i * (barW + gap);
      const y = (h - barH) / 2;
      const grad = g.createLinearGradient(0, y, 0, y + barH);
      grad.addColorStop(0, '#7A0B14');
      grad.addColorStop(1, '#E5192D');
      g.fillStyle = grad;
      g.beginPath();
      g.roundRect(x, y, barW, barH, 3);
      g.fill();
    }
    rafRef.current = requestAnimationFrame(draw);
  }, []);

  useEffect(() => {
    if (playing) {
      ensureAudioGraph();
      rafRef.current = requestAnimationFrame(draw);
    } else {
      cancelAnimationFrame(rafRef.current);
      // freeze the last frame at low bars
      const canvas = canvasRef.current;
      const g = canvas?.getContext('2d');
      if (canvas && g) {
        g.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
        const bars = 40;
        const gap = 3;
        const barW = (canvas.clientWidth - gap * (bars - 1)) / bars;
        for (let i = 0; i < bars; i++) {
          g.fillStyle = 'rgba(229,25,45,0.4)';
          g.beginPath();
          g.roundRect(i * (barW + gap), canvas.clientHeight / 2 - 2, barW, 4, 2);
          g.fill();
        }
      }
    }
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, draw, ensureAudioGraph]);

  const selectAndPlay = (track: Track) => {
    if (activeId === track.id) {
      const audio = audioRef.current;
      if (!audio) return;
      if (playing) audio.pause();
      else void audio.play().catch(() => pushToast('error', 'Playback blocked', 'Click play again'));
      return;
    }
    setActiveId(track.id);
    setPlaying(false);
    setTimeout(() => {
      const audio = audioRef.current;
      if (audio) {
        audio.src = `/api/music/tracks/${track.id}/stream?token=${encodeURIComponent(getToken() || '')}`;
        void audio
          .play()
          .then(() => setPlaying(true))
          .catch(() => pushToast('error', 'Playback blocked', 'Browser autoplay policy — press play'));
      }
    }, 60);
  };

  const next = () => {
    if (tracks.length === 0) return;
    const idx = tracks.findIndex((t) => t.id === activeId);
    const nxt = tracks[(idx + 1) % tracks.length];
    selectAndPlay(nxt);
  };

  const onUpload = async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setUploading(true);
      try {
        const fallback = file.name.replace(/\.[^.]+$/, '');
        const track = await uploadTrack(file, title.trim() || fallback, artist.trim() || 'Unknown Artist', genre.trim() || 'Uncategorized');
        pushToast('success', 'Track uploaded', track.title);
        setTitle('');
        setArtist('');
        setGenre('');
        bumpRev();
        load();
      } catch (err) {
        pushToast('error', 'Upload failed', err instanceof Error ? err.message : '');
      } finally {
        setUploading(false);
      }
    };
    input.click();
  };

  const shareToPost = async (track: Track) => {
    try {
      const res = await api<{ caption: string; hint: string }>(`/music/tracks/${track.id}/share-to-post`, {
        method: 'POST',
        body: { platform: 'INSTAGRAM' },
      });
      pushToast('success', 'Draft created from this track', 'Open Content to schedule it');
      bumpRev();
      void res;
      window.setTimeout(() => {
        if (window.confirm('Draft created. Open the Content page now?')) window.location.href = '/content';
      }, 400);
    } catch (err) {
      pushToast('error', 'Share failed', err instanceof Error ? err.message : '');
    }
  };

  const remove = async (track: Track) => {
    if (!window.confirm(`Delete “${track.title}”?`)) return;
    try {
      await api(`/music/tracks/${track.id}`, { method: 'DELETE' });
      if (activeId === track.id) {
        setActiveId(null);
        setPlaying(false);
      }
      bumpRev();
      load();
    } catch (err) {
      pushToast('error', 'Delete failed', err instanceof Error ? err.message : '');
    }
  };

  const onMeta = () => {
    const audio = audioRef.current;
    if (!audio || !activeId) return;
    const ms = Math.round(audio.duration * 1000);
    if (Number.isFinite(ms) && ms > 0) {
      const track = tracks.find((t) => t.id === activeId);
      if (track && !track.durationMs) {
        void api(`/music/tracks/${activeId}`, { method: 'PATCH', body: { durationMs: ms } }).catch(() => undefined);
        setTracks((prev) => prev.map((t) => (t.id === activeId ? { ...t, durationMs: ms } : t)));
      }
    }
  };

  return (
    <Page>
      <PageHeader
        title="Music Library"
        subtitle="Real audio files you upload — played through the browser, visualized from the actual signal."
        actions={
          <Button onClick={() => void onUpload()} loading={uploading}>
            <UploadSimple size={15} /> Upload audio
          </Button>
        }
      />

      <div className="grid grid-cols-[1fr_380px] gap-4 max-[1000px]:grid-cols-1">
        {/* Now playing */}
        <div className="space-y-4">
          <GlassCard className="p-6">
            <div className="flex items-start gap-5">
              <div className="relative flex h-28 w-28 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-violet/30 to-cyan/20">
                {active?.coverPath ? (
                  <img src={active.coverPath} alt="" className="h-full w-full object-cover" />
                ) : (
                  <MusicNotes size={40} weight="duotone" className="text-violet-200" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="label">Now playing</div>
                <div className="mt-1 truncate font-display text-xl font-semibold text-white" title={active?.title}>
                  {active?.title || 'Nothing loaded'}
                </div>
                <div className="truncate text-sm text-slate-400">{active?.artist || '—'}</div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Badge tone="cyan">{active?.genre || '—'}</Badge>
                  <span className="font-mono text-[11px] text-slate-500">{fmtDur(active?.durationMs)}</span>
                </div>

                <div className="mt-4 flex items-center gap-2">
                  <button
                    onClick={() => {
                      if (!active && tracks[0]) return selectAndPlay(tracks[0]);
                      const audio = audioRef.current;
                      if (!audio) return;
                      if (playing) audio.pause();
                      else void audio.play().catch(() => pushToast('error', 'Playback blocked'));
                    }}
                    aria-label={playing ? 'Pause' : 'Play'}
                    className="btn-primary flex h-10 w-10 items-center justify-center !rounded-full"
                  >
                    {playing ? <Pause size={17} weight="fill" /> : <Play size={17} weight="fill" />}
                  </button>
                  <button onClick={next} aria-label="Next track" className="btn-ghost p-2.5">
                    <SkipForward size={15} />
                  </button>
                  <div className="ml-2 flex-1">
                    <input
                      type="range"
                      min={0}
                      max={1000}
                      value={progress}
                      onChange={(e) => {
                        const audio = audioRef.current;
                        if (audio && Number.isFinite(audio.duration)) {
                          const nextPos = (Number(e.target.value) / 1000) * audio.duration;
                          audio.currentTime = nextPos;
                          setProgress(Number(e.target.value));
                        }
                      }}
                      className="w-full accent-cyan-400"
                      aria-label="Seek"
                    />
                  </div>
                  {active && (
                    <Button variant="ghost" className="!px-3 !py-1.5 !text-xs" onClick={() => void shareToPost(active)}>
                      <Sparkle size={13} /> Share to post
                    </Button>
                  )}
                </div>
              </div>
            </div>

            {/* waveform */}
            <div className="mt-5 rounded-[12px] border border-white/[0.07] bg-black/25 p-3">
              <canvas ref={canvasRef} className="h-24 w-full" />
              <div className="mt-1 text-center font-mono text-[10px] text-slate-600">
                live waveform · web audio analyser{playing ? ' · streaming' : ' · idle'}
              </div>
            </div>

            <audio
              ref={audioRef}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => setPlaying(false)}
              onTimeUpdate={() => {
                const audio = audioRef.current;
                if (audio && Number.isFinite(audio.duration) && audio.duration > 0) {
                  setProgress(Math.min(1000, Math.round((audio.currentTime / audio.duration) * 1000)));
                }
              }}
              onLoadedMetadata={onMeta}
              className="hidden"
              preload="metadata"
            />
          </GlassCard>

          {/* upload meta row */}
          <GlassCard className="p-4">
            <div className="grid grid-cols-3 gap-3 max-[700px]:grid-cols-1">
              <Field label="Title (next upload)">
                <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="auto from filename" />
              </Field>
              <Field label="Artist">
                <Input value={artist} onChange={(e) => setArtist(e.target.value)} placeholder="Unknown Artist" />
              </Field>
              <Field label="Genre">
                <Input value={genre} onChange={(e) => setGenre(e.target.value)} placeholder="Uncategorized" />
              </Field>
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              To attach audio to an Instagram post, mux it into a video first:{' '}
              <span className="font-mono text-cyan-300">ffmpeg -i video.mp4 -i track.mp3 -c:v copy -shortest out.mp4</span>
            </p>
          </GlassCard>
        </div>

        {/* Playlist */}
        <GlassCard className="flex max-h-[70vh] flex-col overflow-hidden">
          <div className="flex items-center justify-between border-b border-white/[0.07] px-4 py-3">
            <span className="font-display text-sm font-semibold text-white">Playlist</span>
            <Badge tone="gray">{tracks.length} track{tracks.length === 1 ? '' : 's'}</Badge>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {loading && (
              <div className="flex justify-center py-10">
                <Spinner size={18} />
              </div>
            )}
            {!loading && tracks.length === 0 && (
              <EmptyState
                icon={MusicNotes}
                title="No tracks yet"
                body="Upload real audio files (mp3, wav, ogg, flac, m4a). They are stored on this host and streamed with range support — nothing is truncated in this playlist."
              />
            )}
            {tracks.map((t) => {
              const isActive = t.id === activeId;
              return (
                <div
                  key={t.id}
                  className={`group mb-1 flex items-center gap-3 rounded-[10px] border px-3 py-2.5 transition-colors ${
                    isActive ? 'border-violet-400/40 bg-violet-500/15' : 'border-transparent hover:bg-white/5'
                  }`}
                >
                  <button onClick={() => selectAndPlay(t)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                    <span
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border text-[10px] ${
                        isActive && playing
                          ? 'border-cyan-400/40 bg-cyan-500/15 text-cyan-300'
                          : 'border-white/10 bg-white/5 text-slate-400'
                      }`}
                    >
                      {isActive && playing ? <Pause size={12} weight="fill" /> : <Play size={12} weight="fill" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate text-sm ${isActive ? 'text-white' : 'text-slate-200'}`} title={t.title}>
                        {t.title}
                      </span>
                      <span className="block truncate text-xs text-slate-500" title={`${t.artist} · ${t.genre}`}>
                        {t.artist} · {t.genre}
                      </span>
                    </span>
                  </button>
                  <span className="shrink-0 font-mono text-[10px] text-slate-500">{fmtDur(t.durationMs)}</span>
                  <button
                    onClick={() => void shareToPost(t)}
                    aria-label={`Share ${t.title} to post`}
                    className="shrink-0 text-slate-500 opacity-0 transition-opacity hover:text-violet-300 group-hover:opacity-100"
                  >
                    <Sparkle size={13} />
                  </button>
                  <button
                    onClick={() => void remove(t)}
                    aria-label={`Delete ${t.title}`}
                    className="shrink-0 text-slate-500 opacity-0 transition-opacity hover:text-red-300 group-hover:opacity-100"
                  >
                    <Trash size={13} />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="border-t border-white/[0.07] px-4 py-3 text-[11px] text-slate-500">
            Added {tracks[0] ? relTime(tracks[0].createdAt) : '—'}
            <Link to="/content" className="ml-2 text-cyan-300 hover:underline">
              schedule a post →
            </Link>
          </div>
        </GlassCard>
      </div>
    </Page>
  );
}
