import { assertMedia, compatibleMedia, normalizedCommand, concatenateCommand, musicCommand, cleanMusic } from './core.js';

const ASSET_ROOT = new URL('./vendor/', import.meta.url);
export async function assembleDocumentary(clips, { musicBlob = null, music = {}, signal, onProgress = () => {}, onEngine = () => {} } = {}) {
  if (!Array.isArray(clips) || clips.length !== 13 || clips.some(b => !(b instanceof Blob) || !b.size)) throw new Error('All 13 scene files are required before assembling.');
  if (clips.reduce((n, b) => n + b.size, musicBlob?.size || 0) > 512 * 1024 * 1024) throw new Error('These files are too large for browser assembly. Use smaller scene files.');
  const { FFmpeg } = await import('./vendor/ffmpeg/dist/esm/index.js');
  const ffmpeg = new FFmpeg(), files = new Set(), log = [];
  let stage = 'Loading video engine', part = 0, latestDuration = 156, probeSequence = 0;
  const cancel = () => ffmpeg.terminate();
  if (signal?.aborted) throw new DOMException('Assembly stopped.', 'AbortError');
  signal?.addEventListener('abort', cancel, { once: true });
  ffmpeg.on('log', ({ message }) => { log.push(message); if (log.length > 60) log.shift(); });
  ffmpeg.on('progress', ({ progress }) => onProgress({ stage, part, progress: Math.max(0, Math.min(1, progress)), duration: latestDuration }));
  onEngine(ffmpeg);
  const exec = async args => {
    if (signal?.aborted) throw new DOMException('Assembly stopped.', 'AbortError');
    const code = await ffmpeg.exec(args);
    if (code !== 0) throw new Error('Video assembly failed. ' + log.slice(-4).join(' ').slice(0, 240));
  };
  const probe = async path => {
    const out = `probe_${++probeSequence}.json`; files.add(out);
    const code = await ffmpeg.ffprobe(['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path, '-o', out]);
    let data;
    try { data = JSON.parse(await ffmpeg.readFile(out, 'utf8')); }
    catch { throw new Error('This scene could not be inspected. Upload a valid MP4 containing narration.'); }
    // The pinned core's ffprobe returns its initial -1 sentinel after a successful
    // inspection. Accept it only with fresh metadata for this exact input file.
    if (![0, -1].includes(code) || data.format?.filename !== path || !Array.isArray(data.streams) || !data.streams.length || !(Number(data.format.duration) > 0)) {
      throw new Error('This scene could not be inspected. Upload a valid MP4 containing narration.');
    }
    return data;
  };
  try {
    onProgress({ stage, part: 0, progress: 0 });
    await ffmpeg.load({ coreURL: new URL('core/dist/esm/ffmpeg-core.js', ASSET_ROOT).href, wasmURL: new URL('core/dist/esm/ffmpeg-core.wasm', ASSET_ROOT).href });
    const names = [], infos = [];
    stage = 'Checking scene files';
    for (let i = 0; i < clips.length; i++) {
      if (signal?.aborted) throw new DOMException('Assembly stopped.', 'AbortError');
      part = i + 1; const name = `scene_${String(part).padStart(2, '0')}.mp4`;
      names.push(name); files.add(name); await ffmpeg.writeFile(name, new Uint8Array(await clips[i].arrayBuffer()));
      infos.push(assertMedia(await probe(name))); onProgress({ stage, part, progress: (i + 1) / clips.length });
    }
    latestDuration = infos.reduce((n, i) => n + i.duration, 0);
    let inputs = names;
    if (!compatibleMedia(infos)) {
      inputs = []; stage = 'Matching scene formats';
      for (let i = 0; i < names.length; i++) {
        part = i + 1; const out = `normalized_${part}.mp4`; files.add(out);
        onProgress({ stage, part, progress: 0 }); await exec(normalizedCommand(names[i], out));
        await ffmpeg.deleteFile(names[i]); files.delete(names[i]); inputs.push(out);
      }
    }
    const list = 'scenes.txt'; files.add(list);
    await ffmpeg.writeFile(list, new TextEncoder().encode(inputs.map(n => `file '${n}'`).join('\n') + '\n'));
    stage = 'Joining all 13 scenes'; part = 13; const joined = 'joined.mp4'; files.add(joined);
    onProgress({ stage, part, progress: 0 }); await exec(concatenateCommand(list, joined));
    const joinedProbe = await probe(joined);
    const joinedSeconds = Number(joinedProbe.format?.duration);
    if (!Number.isFinite(joinedSeconds) || Math.abs(joinedSeconds - latestDuration) > 1) throw new Error('The joined video duration does not match the scenes. Export was stopped to avoid missing material.');
    latestDuration = joinedSeconds;
    let output = joined;
    const m = cleanMusic(music);
    if (musicBlob || m.narrationVolumeDb !== 0) {
      const musicName = musicBlob ? 'music.bin' : null;
      if (musicBlob) { files.add(musicName); await ffmpeg.writeFile(musicName, new Uint8Array(await musicBlob.arrayBuffer())); }
      stage = musicBlob ? 'Mixing background music' : 'Adjusting narration volume'; onProgress({ stage, part, progress: 0 });
      output = 'final.mp4'; files.add(output); await exec(musicCommand(joined, musicName, output, joinedSeconds, m));
    }
    const finalProbe = await probe(output), finalDuration = Number(finalProbe.format?.duration);
    const video = finalProbe.streams?.find(s => s.codec_type === 'video'), audio = finalProbe.streams?.find(s => s.codec_type === 'audio');
    if (!video || !audio || !Number.isFinite(finalDuration) || Math.abs(finalDuration - joinedSeconds) > 1) throw new Error('Final video verification failed. No incomplete export was saved.');
    const bytes = await ffmpeg.readFile(output);
    const blob = new Blob([bytes], { type: 'video/mp4' });
    onProgress({ stage: 'Final video ready', part: 13, progress: 1 });
    return { blob, duration: finalDuration, engine: compatibleMedia(infos) ? 'FFmpeg · original video preserved' : 'FFmpeg · normalized video', width: video.width, height: video.height };
  } catch (e) {
    if (signal?.aborted) throw new DOMException('Assembly stopped.', 'AbortError');
    throw e;
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (!signal?.aborted) for (const name of files) try { await ffmpeg.deleteFile(name); } catch { /* worker may already be stopped */ }
    ffmpeg.terminate(); onEngine(null);
  }
}
