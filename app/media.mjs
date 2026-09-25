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
export function run(command, args, {signal, onProgress, timeout = 0, stallMs = 0} = {}) {
  return new Promise((resolve,reject) => {
    if (signal?.aborted) return reject(new Error('Afbrudt'));
    const child = spawn(command, args, { stdio: ['ignore','pipe','pipe'], shell: false });
    let out = '', log = '', pending = '', terminated = false, killTimer, lastBeat = Date.now();
    const stop = (reason) => { terminated = reason || true; child.kill('SIGTERM'); killTimer ??= setTimeout(() => child.kill('SIGKILL'), 5000).unref(); };
    signal?.addEventListener('abort',()=>stop(),{once:true});
    const timer = timeout ? setTimeout(() => stop('timeout'), timeout).unref() : null;
    const stall = stallMs ? setInterval(() => { if (Date.now() - lastBeat > stallMs) stop('stall'); }, Math.min(stallMs, 5000)).unref() : null;
    child.stdout.on('data', chunk => {
      lastBeat = Date.now();
      if (!onProgress) out = (out + chunk).slice(-4 * 1024 * 1024);
      else {
        pending += chunk.toString();
        const lines = pending.split('\n'); pending = lines.pop();
        for (const line of lines) { const i=line.indexOf('='); if(i>0) onProgress(line.slice(0,i),line.slice(i+1).trim()); }
      }
    });
    child.stderr.on('data', chunk => { lastBeat = Date.now(); log = (log + chunk).slice(-16000); });
    const cleanup = () => { clearTimeout(timer); clearInterval(stall); clearTimeout(killTimer); signal?.removeEventListener('abort', stop); };
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', code => {
      cleanup();
      if (code === 0 && !terminated) resolve({out,log});
      else reject(Object.assign(new Error(terminated === 'stall' ? 'Encodingen gik i stå uden fremdrift.' : terminated ? 'Afbrudt eller tidsgrænse overskredet.' : `FFmpeg/FFprobe fejlede (kode ${code}). Se jobloggen.`), {log, transient: Boolean(terminated) || code === 255}));
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
export function hdrReason(media, options = {}) {
  const v=media.video;
  if (!options.allowHDR && options.tonemap !== 'sdr' && (['smpte2084','arib-std-b67'].includes(v.color_transfer) || v.side_data_list?.some(d => /dovi|dolby|mastering display|content light|hdr/i.test(d.side_data_type)))) return 'HDR/Dolby Vision er beskyttet. Tillad HDR, eller vælg tone mapping til SDR.';
  if (!options.deinterlace && v.field_order && !['unknown','progressive'].includes(v.field_order)) return 'Interlaced video springes over, medmindre deinterlace er slået til.';
  return null;
}
export function atmosReason(media, options) {
  const possibleAtmos=media.streams.some(s=>s.codec_type==='audio'&&(['truehd','eac3'].includes(s.codec_name)||/atmos|joc/i.test(JSON.stringify(s))));
  return possibleAtmos&&options.audio!=='copy'&&!options.allowAtmosLoss?'Mulig Atmos-lyd er beskyttet. Vælg lydkopiering eller tillad tab af Atmos for denne fil/profil.':null;
}
const CRF = { hevc: {high:21,balanced:24,small:27}, h264: {high:18,balanced:21,small:24}, av1: {high:26,balanced:30,small:34} };
function videoFilters(options, media) {
  const chain = [];
  if (options.deinterlace) chain.push('bwdif');
  if (options.crop) chain.push('crop=' + options.crop);
  if (options.maxHeight && media.video.height > options.maxHeight) chain.push(`scale=-2:${options.maxHeight}`);
  if (options.fps) chain.push(`fps=${options.fps}`);
  if (options.tonemap === 'sdr') chain.push('zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p');
  return chain;
}
export function encodeArgs(source, media, subtitles, output, options, c, plan) {
  const crf = CRF[options.codec][options.quality];
  const device = plan?.device || 'cpu';
  const encoder = plan?.encoder || (options.codec === 'h264' ? 'libx264' : options.codec === 'av1' ? 'libsvtav1' : 'libx265');
  const hw = [];
  const filters = videoFilters(options, media);
  if (!filters.length && device === 'nvidia') hw.push('-hwaccel','cuda');
  if (!filters.length && device === 'vaapi' && c.hardware?.render) hw.push('-hwaccel','vaapi','-vaapi_device',c.hardware.render);
  if (!filters.length && device === 'intel') hw.push('-hwaccel','qsv');
  const args = ['-hide_banner','-nostdin','-n','-xerror','-loglevel','warning','-stats_period','1','-progress','pipe:1','-threads',String(c.threads),'-protocol_whitelist','file,pipe',...hw,'-i',source];
  for (const s of subtitles) args.push('-protocol_whitelist','file,pipe','-sub_charenc','UTF-8','-i',s.path);
  args.push('-map',`0:${media.video.index}`,'-map','0:a?','-map','0:s?','-map','0:t?');
  for (let i=0;i<subtitles.length;i++) args.push('-map',`${i+1}:s:0`);
  args.push('-map_metadata','0','-map_chapters','0','-c','copy','-c:v',encoder,'-threads',String(c.threads));
  const quality = options.rateControl || 'crf';
  const nvenc = encoder.endsWith('_nvenc'), qsv = encoder.endsWith('_qsv'), vaapi = encoder.endsWith('_vaapi');
  const preset = nvenc && !/^p[1-7]$/.test(options.preset) ? ({fast:'p4',medium:'p5',slow:'p6'}[options.preset] || 'p5') : options.preset;
  if (quality === 'vbr' || quality === 'cbr') {
    const rate = `${options.videoBitrate || 4000}k`;
    args.push('-b:v', rate, '-maxrate', `${options.maxrate || options.videoBitrate || 4000}k`, '-bufsize', `${options.bufsize || (options.videoBitrate || 4000) * 2}k`);
    if (quality === 'cbr') args.push('-minrate', rate);
  } else if (nvenc) args.push(quality === 'cqp' ? '-qp' : '-cq', String(crf), '-rc', quality === 'cqp' ? 'constqp' : 'vbr');
  else if (qsv) args.push('-global_quality', String(crf));
  else if (vaapi) args.push('-qp', String(crf));
  else if (encoder === 'libsvtav1') args.push('-crf', String(crf), '-preset', String({ultrafast:12,superfast:11,veryfast:10,faster:9,fast:8,medium:6,slow:4,slower:2,veryslow:1}[options.preset] ?? 6));
  else args.push(quality === 'cqp' ? '-qp' : '-crf', String(crf), '-preset', preset);
  if (nvenc || qsv || vaapi) args.push('-preset', preset);
  const is10 = options.pixFmt === 'auto' ? (/(?:p|le|be)10|p10|p12/.test(media.video.pix_fmt || '') || Number(media.video.bits_per_raw_sample) > 8) : options.pixFmt.includes('10');
  const pix = options.pixFmt === 'auto' ? (options.tonemap === 'sdr' ? 'yuv420p' : (is10 ? 'yuv420p10le' : 'yuv420p')) : options.pixFmt;
  if (!vaapi) args.push('-pix_fmt', pix);
  args.push('-filter_threads', String(c.threads));
  if (encoder === 'libx265') args.push('-x265-params', [options.encoderParams, `pools=${c.threads}:frame-threads=1:log-level=error`].filter(Boolean).join(':'));
  else if (encoder === 'libx264' && options.encoderParams) args.push('-x264-params', options.encoderParams);
  else if (encoder === 'libsvtav1' && options.encoderParams) args.push('-svtav1-params', options.encoderParams);
  if (options.tune && encoder.startsWith('libx')) args.push('-tune', options.tune);
  if (options.profile) args.push('-profile:v', options.profile);
  if (options.level) args.push('-level', options.level);
  if (options.keyint) args.push('-g', String(options.keyint));
  if (filters.length) args.push('-vf', filters.join(','));
  if (options.allowHDR && options.tonemap !== 'sdr' && media.video.color_transfer === 'smpte2084' && nvenc) args.push('-hdr10', '1');
  // Preserve colour signalling. HDR override does not promise preservation of
  // mastering metadata or dynamic Dolby Vision metadata and does not tone map.
  for (const [field,flag] of [['color_primaries','-color_primaries'],['color_transfer','-color_trc'],['color_space','-colorspace'],['color_range','-color_range']]) {
    if (media.video[field] && media.video[field] !== 'unknown') args.push(flag,media.video[field]);
  }
  if (options.audio === 'aac_stereo') args.push('-c:a','aac','-ac','2','-b:a',`${options.audioBitrate || 192}k`);
  else if (options.audio !== 'copy') {
    const codec = {aac:'aac', opus:'libopus', ac3:'ac3', eac3:'eac3', flac:'flac'}[options.audio];
    args.push('-c:a', codec);
    if (options.audio !== 'flac') args.push('-b:a', `${options.audioBitrate || 192}k`);
    if (options.audioChannels) args.push('-ac', String(options.audioChannels));
  }
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
