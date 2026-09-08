import path from 'node:path';
import fs from 'node:fs';

export const VERSION = '0.1.0';
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
export const DEFAULT_SETTINGS = Object.freeze({ codec: 'hevc', quality: 'balanced', preset: 'medium', maxHeight: 0, audio: 'copy', onlySmaller: true, copySidecars: true });
export function settings(input = {}) {
  const s = { ...DEFAULT_SETTINGS, ...input };
  const choices = { codec: ['hevc', 'h264'], quality: ['high', 'balanced', 'small'], preset: ['fast', 'medium', 'slow'], maxHeight: [0, 1080, 720], audio: ['copy', 'aac_stereo'] };
  for (const [k, values] of Object.entries(choices)) if (!values.includes(s[k])) throw new Error(`Ugyldig indstilling: ${k}`);
  for (const k of ['onlySmaller', 'copySidecars']) if (typeof s[k] !== 'boolean') throw new Error(`Ugyldig indstilling: ${k}`);
  return Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map(k => [k, s[k]]));
}
