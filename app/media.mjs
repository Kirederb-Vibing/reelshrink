import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { inside } from './config.mjs';

export const VIDEO_EXT = new Set(['.mkv','.mp4','.m4v','.avi','.mov','.ts','.m2ts','.webm']);
const ART_EXT = new Set(['.nfo','.jpg','.jpeg','.png','.webp']);
const LANGUAGES = { da:'dan',dan:'dan',dk:'dan',dansk:'dan',danish:'dan',en:'eng',eng:'eng',english:'eng',sv:'swe',swe:'swe',swedish:'swe',no:'nor',nor:'nor',nb:'nob',nn:'nno',de:'deu',deu:'deu',ger:'deu',german:'deu',fr:'fra',fra:'fra',fre:'fra',es:'spa',spa:'spa',it:'ita',ita:'ita',nl:'nld',nld:'nld',dut:'nld',fi:'fin',fin:'fin',pl:'pol',pol:'pol',pt:'por',por:'por',ja:'jpn',jpn:'jpn',ko:'kor',kor:'kor',zh:'zho',zho:'zho',chi:'zho',ar:'ara',ara:'ara',uk:'ukr',ukr:'ukr' };
const stemOf = file => path.basename(file, path.extname(file));
function startsTitle(name, stem) { return name === stem || ['.',' ','_','-'].some(s => name.startsWith(stem + s)); }
function subtitleInfo(file, stem) {
  const tail = stemOf(file).toLowerCase().replace(stem.toLowerCase(), '');
  const tokens = tail.split(/[.\s_\-()[\]]+/).filter(Boolean);
  const language = tokens.map(x => LANGUAGES[x]).find(Boolean) || 'und';
  return { path: file, language, title: stemOf(file) };
}
export async function discover(directory, signal) {
  const videos = [];
  async function walk(dir) {
    if (signal?.aborted) return;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && VIDEO_EXT.has(path.extname(entry.name).toLowerCase())) videos.push(file);
    }
  }
  await walk(directory);
  return videos.sort();
}
export async function bundleFor(source) {
  const dir = path.dirname(source), stem = stemOf(source), subtitles = [], sidecars = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const videoStems = entries.filter(e => e.isFile() && VIDEO_EXT.has(path.extname(e.name).toLowerCase())).map(e => stemOf(e.name).toLowerCase());
  const single = videoStems.length === 1;
  const own = (name) => {
    const matches = videoStems.filter(s => startsTitle(stemOf(name).toLowerCase(), s)).sort((a,b) => b.length - a.length);
    return matches[0] === stem.toLowerCase();
  };
  const collect = (entries, folder, allowGeneric) => {
    for (const e of entries) {
      if (!e.isFile() || e.name.startsWith('.')) continue;
      const ext = path.extname(e.name).toLowerCase(), file = path.join(folder, e.name);
      if (ext === '.srt' && (own(e.name) || (single && allowGeneric))) subtitles.push(subtitleInfo(file, stem));
      else if (ART_EXT.has(ext) && (own(e.name) || (single && /^(poster|folder|fanart|banner|landscape|movie|tvshow)\./i.test(e.name)))) sidecars.push(file);
    }
  };
  collect(entries, dir, true);
  for (const e of entries) {
    if (e.isDirectory() && ['subs','subtitles'].includes(e.name.toLowerCase())) collect(await fs.readdir(path.join(dir,e.name), {withFileTypes:true}), path.join(dir,e.name), true);
  }
  return { subtitles: subtitles.sort((a,b) => a.path.localeCompare(b.path)), sidecars: sidecars.sort() };
}
export async function signatureFor(source, bundle) {
  const hash = createHash('sha256');
  for (const file of [source, ...bundle.subtitles.map(s => s.path), ...bundle.sidecars]) {
    const stat = await fs.lstat(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('En kildefil er ikke en almindelig fil.');
    hash.update(JSON.stringify([file, String(stat.size), String(stat.mtimeNs)]));
  }
  return hash.digest('hex');
}
export async function assertBundleAllowed(source, bundle, roots) {
  for (const file of [source,...bundle.subtitles.map(s=>s.path),...bundle.sidecars]) {
    const real = await fs.realpath(file);
    if (real !== file || !roots.some(root => inside(real, root))) throw new Error('Kildefilen er flyttet eller peger uden for mediemappen.');
  }
}
export function run(command, args, {signal, onProgress, timeout = 0} = {}) {
  return new Promise((resolve,reject) => {
    if (signal?.aborted) return reject(new Error('Afbrudt'));
    const child = spawn(command, args, { stdio: ['ignore','pipe','pipe'], shell: false });
    let out = '', log = '', pending = '', terminated = false, killTimer;
    const stop = () => { terminated = true; child.kill('SIGTERM'); killTimer ??= setTimeout(() => child.kill('SIGKILL'), 5000).unref(); };
    signal?.addEventListener('abort',stop,{once:true});
    const timer = timeout ? setTimeout(stop,timeout).unref() : null;
    child.stdout.on('data', chunk => {
      if (!onProgress) out = (out + chunk).slice(-4 * 1024 * 1024);
      else {
        pending += chunk.toString();
        const lines = pending.split('\n'); pending = lines.pop();
        for (const line of lines) { const i=line.indexOf('='); if(i>0) onProgress(line.slice(0,i),line.slice(i+1).trim()); }
      }
    });
    child.stderr.on('data', chunk => { log = (log + chunk).slice(-16000); });
    const cleanup = () => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort',stop); };
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', code => {
      cleanup();
      if (code === 0 && !terminated) resolve({out,log});
      else reject(Object.assign(new Error(terminated ? 'Afbrudt eller tidsgrænse overskredet.' : `FFmpeg/FFprobe fejlede (kode ${code}). Se jobloggen.`), {log}));
    });
  });
}
export async function probe(file,c,signal) {
  const {out} = await run(c.ffprobe,['-v','error','-protocol_whitelist','file,pipe','-show_format','-show_streams','-show_chapters','-of','json',file],{signal,timeout:60000});
  const data = JSON.parse(out);
  const video = data.streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!video) throw new Error('Filen indeholder ikke et videospor.');
  const duration = Number(video.duration || data.format.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Kunne ikke bestemme filmens varighed.');
  return { ...data, video, duration };
}
export function hdrReason(media) {
  const v=media.video;
  if (['smpte2084','arib-std-b67'].includes(v.color_transfer) || v.side_data_list?.some(d => /dovi|dolby|mastering display|content light|hdr/i.test(d.side_data_type))) return 'HDR/Dolby Vision springes over i v0.1 for at beskytte farver og dynamiske metadata.';
  if (v.field_order && !['unknown','progressive'].includes(v.field_order)) return 'Interlaced video springes over i v0.1; den kræver en særskilt deinterlacing-profil.';
  return null;
}
export function encodeArgs(source, media, subtitles, output, options, c) {
  const crf = { hevc: {high:21,balanced:24,small:27}, h264: {high:18,balanced:21,small:24} }[options.codec][options.quality];
  const args = ['-hide_banner','-nostdin','-n','-xerror','-loglevel','warning','-stats_period','1','-progress','pipe:1','-threads',String(c.threads),'-protocol_whitelist','file,pipe','-i',source];
  for (const s of subtitles) args.push('-protocol_whitelist','file,pipe','-sub_charenc','UTF-8','-i',s.path);
  args.push('-map',`0:${media.video.index}`,'-map','0:a?','-map','0:s?','-map','0:t?');
  for (let i=0;i<subtitles.length;i++) args.push('-map',`${i+1}:s:0`);
  args.push('-map_metadata','0','-map_chapters','0','-c','copy','-c:v',options.codec==='hevc'?'libx265':'libx264','-crf',String(crf),'-preset',options.preset,'-threads',String(c.threads));
  const is10 = /(?:p|le|be)10|p10|p12/.test(media.video.pix_fmt || '') || Number(media.video.bits_per_raw_sample)>8;
  args.push('-pix_fmt',is10?'yuv420p10le':'yuv420p','-filter_threads',String(c.threads));
  if(options.codec==='hevc') args.push('-x265-params',`pools=${c.threads}:frame-threads=1:log-level=error`);
  if (options.maxHeight && media.video.height > options.maxHeight) args.push('-vf',`scale=-2:${options.maxHeight}`);
  // Transfer characteristics for SDR are retained explicitly; HDR never reaches this path.
  for (const [field,flag] of [['color_primaries','-color_primaries'],['color_transfer','-color_trc'],['color_space','-colorspace'],['color_range','-color_range']]) {
    if (media.video[field] && media.video[field] !== 'unknown') args.push(flag,media.video[field]);
  }
  if (options.audio === 'aac_stereo') args.push('-c:a','aac','-ac','2','-b:a','192k');
  const existing = media.streams.filter(s=>s.codec_type==='subtitle');
  existing.forEach((s,i) => { if (['mov_text','webvtt','text','ttml'].includes(s.codec_name)) args.push(`-c:s:${i}`,'srt'); });
  subtitles.forEach((s,i) => args.push(`-c:s:${existing.length+i}`,'srt',`-metadata:s:s:${existing.length+i}`,`language=${s.language}`,`-metadata:s:s:${existing.length+i}`,`title=${s.title}`));
  // Clear default AND forced flags on every subtitle; never render subtitles into video.
  if (existing.length+subtitles.length) args.push('-disposition:s','0');
  args.push('-max_muxing_queue_size','4096',output);
  return args;
}
export async function prepareSubtitles(subtitles, dir) {
  const prepared=[];
  for (let i=0;i<subtitles.length;i++) {
    const s=subtitles[i];
    if((await fs.stat(s.path)).size>16*1024*1024) throw new Error('En SRT-fil er større end 16 MiB.');
    const bytes=await fs.readFile(s.path);
    let content;
    if(bytes[0]===0xff && bytes[1]===0xfe) content=new TextDecoder('utf-16le').decode(bytes);
    else if(bytes[0]===0xfe && bytes[1]===0xff) content=new TextDecoder('utf-16be').decode(bytes);
    else { try {content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);} catch {content=new TextDecoder('windows-1252').decode(bytes);} }
    content=content.replace(/^\uFEFF/,'');
    const file=path.join(dir,`subtitle-${i}.srt`);
    await fs.writeFile(file,content,{flag:'wx'});
    prepared.push({...s,path:file});
  }
  return prepared;
}
export function validateOutput(original, output, subtitleCount, options) {
  if (Math.abs(output.duration-original.duration)>Math.max(2,original.duration*0.01)) throw new Error('Outputkontrol: varigheden afviger for meget.');
  for (const type of ['audio','attachment']) {
    if (original.streams.filter(s=>s.codec_type===type).length!==output.streams.filter(s=>s.codec_type===type).length) throw new Error(`Outputkontrol: antal ${type}-spor stemmer ikke.`);
  }
  if (output.streams.filter(s=>s.codec_type==='subtitle').length !== original.streams.filter(s=>s.codec_type==='subtitle').length+subtitleCount) throw new Error('Outputkontrol: undertekstspor mangler.');
  if (output.streams.some(s=>s.codec_type==='subtitle' && (s.disposition?.default || s.disposition?.forced))) throw new Error('Outputkontrol: undertekster er markeret som automatiske.');
  const expectedHeight=options.maxHeight?Math.min(original.video.height,options.maxHeight):original.video.height;
  if (output.video.height!==expectedHeight || (!options.maxHeight && output.video.width!==original.video.width)) throw new Error('Outputkontrol: uventet opløsning.');
  if(output.video.codec_name !== options.codec) throw new Error('Outputkontrol: uventet videocodec.');
}
