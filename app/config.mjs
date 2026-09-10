import path from 'node:path';
import fs from 'node:fs';

export const VERSION = '0.3.0';
export function config(env = process.env) {
  const integer = (key, fallback, min, max) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key}: forventede ${min}–${max}`);
    return value;
  };
  const c = {
    port: integer('PORT', 8080, 1, 65535),
    host: env.HOST || '0.0.0.0',
    mediaRoots: (env.MEDIA_ROOTS || '/media').split(':').map(p => path.resolve(p)),
    outputRoot: path.resolve(env.OUTPUT_ROOT || '/output'),
    returnInputRoots: (env.RETURN_INPUT_ROOTS || '/incoming').split(':').filter(Boolean).map(p => path.resolve(p)),
    configDir: path.resolve(env.CONFIG_DIR || '/config'),
    scanInterval: integer('SCAN_INTERVAL', 30, 5, 86400),
    stableSeconds: integer('STABLE_SECONDS', 60, 5, 86400),
    threads: integer('ENCODE_THREADS', 2, 1, 128),
    minFreeBytes: integer('MIN_FREE_GB', 2, 0, 100000) * 1024 ** 3,
    username: env.AUTH_USERNAME || '',
    password: env.AUTH_PASSWORD_FILE ? fs.readFileSync(env.AUTH_PASSWORD_FILE, 'utf8').trimEnd() : env.AUTH_PASSWORD || '',
    ffmpeg: env.FFMPEG_PATH || 'ffmpeg',
    ffprobe: env.FFPROBE_PATH || 'ffprobe',
  };
  if (Boolean(c.username) !== Boolean(c.password)) throw new Error('Angiv både AUTH_USERNAME og AUTH_PASSWORD (eller AUTH_PASSWORD_FILE).');
  for (const root of c.mediaRoots) {
    if (inside(c.outputRoot, root) || inside(root, c.outputRoot)) throw new Error('Input og output må ikke overlappe.');
    if (inside(c.configDir, root) || inside(root, c.configDir)) throw new Error('Konfiguration og input må ikke overlappe.');
  }
  if (inside(c.configDir, c.outputRoot) || inside(c.outputRoot, c.configDir)) throw new Error('Konfiguration og output må ikke overlappe.');
  for (const root of c.returnInputRoots) {
    if ([c.configDir, c.outputRoot, ...c.mediaRoots].some(other => inside(root, other) || inside(other, root))) throw new Error('Ekstra fra-mapper skal være adskilt fra medier, output og konfiguration.');
  }
  return c;
}
export function inside(candidate, root) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
export function mediaPath(candidate, c) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) throw new Error('Vælg en absolut sti i en mediemappe.');
  const real = fs.realpathSync(candidate);
  if (!c.mediaRoots.some(root => { try {return inside(real, fs.realpathSync(root));} catch {return false;} })) throw new Error('Stien ligger uden for de tilladte mediemapper.');
  return real;
}
export const FILTER_DEFAULTS = Object.freeze({ minSizeGB: 0, maxSizeGB: 0, minDurationMinutes: 0, minSourceHeight: 0, skipCodecs: Object.freeze([]) });
export const DEFAULT_SETTINGS = Object.freeze({ codec: 'hevc', quality: 'balanced', preset: 'medium', maxHeight: 0, audio: 'copy', onlySmaller: true, copySidecars: true, ...FILTER_DEFAULTS });
export function settings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Ugyldige indstillinger.');
  const s = { ...DEFAULT_SETTINGS, ...input };
  const choices = { codec: ['hevc', 'h264'], quality: ['high', 'balanced', 'small'], preset: ['fast', 'medium', 'slow'], maxHeight: [0, 1080, 720], audio: ['copy', 'aac_stereo'] };
  for (const [k, values] of Object.entries(choices)) if (!values.includes(s[k])) throw new Error(`Ugyldig indstilling: ${k}`);
  for (const k of ['onlySmaller', 'copySidecars']) if (typeof s[k] !== 'boolean') throw new Error(`Ugyldig indstilling: ${k}`);
  for (const [k,max] of Object.entries({ minSizeGB: 100000, maxSizeGB: 100000, minDurationMinutes: 100000, minSourceHeight: 16384 })) {
    if (typeof s[k] !== 'number' || !Number.isFinite(s[k]) || s[k] < 0 || s[k] > max) throw new Error(`Ugyldigt filter: ${k}`);
  }
  if (!Number.isInteger(s.minSourceHeight)) throw new Error('Minimumhøjden skal være et helt antal pixels.');
  if (s.maxSizeGB && s.minSizeGB > s.maxSizeGB) throw new Error('Minimum filstørrelse må ikke overstige maksimum.');
  if (!Array.isArray(s.skipCodecs) || s.skipCodecs.length > 3 || s.skipCodecs.some(c => !['hevc','av1','h264'].includes(c))) throw new Error('Ugyldigt codec-filter.');
  s.skipCodecs = [...new Set(s.skipCodecs)];
  return Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map(k => [k, s[k]]));
}

// GB are decimal, as labelled in the form. Equality passes each minimum/maximum.
export function filterReason(options, size, media = null) {
  const s = { ...FILTER_DEFAULTS, ...options };
  if (s.minSizeGB && size < s.minSizeGB * 1e9) return `Filter: Filen er under minimum på ${s.minSizeGB} GB.`;
  if (s.maxSizeGB && size > s.maxSizeGB * 1e9) return `Filter: Filen er over maksimum på ${s.maxSizeGB} GB.`;
  if (!media) return null;
  if (s.minDurationMinutes && media.duration < s.minDurationMinutes * 60) return `Filter: Videoen er kortere end ${s.minDurationMinutes} minutter.`;
  if (s.minSourceHeight && media.video.height < s.minSourceHeight) return `Filter: Kildens højde er under ${s.minSourceHeight} pixels.`;
  if (s.skipCodecs.includes(media.video.codec_name)) return `Filter: Kildens codec (${media.video.codec_name}) er fravalgt.`;
  return null;
}
