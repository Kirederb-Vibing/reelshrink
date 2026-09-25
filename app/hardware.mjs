import fs from 'node:fs/promises';
import { run } from './media.mjs';

const FAMILIES = {
  hevc: { cpu: 'libx265', nvidia: 'hevc_nvenc', intel: 'hevc_qsv', vaapi: 'hevc_vaapi' },
  h264: { cpu: 'libx264', nvidia: 'h264_nvenc', intel: 'h264_qsv', vaapi: 'h264_vaapi' },
  av1: { cpu: 'libsvtav1', nvidia: 'av1_nvenc', intel: 'av1_qsv', vaapi: 'av1_vaapi' },
};

export async function detectHardware(c) {
  const encoders = await run(c.ffmpeg, ['-hide_banner', '-encoders'], { timeout: 10000 });
  const hw = await run(c.ffmpeg, ['-hide_banner', '-hwaccels'], { timeout: 10000 }).catch(() => ({ out: '' }));
  const names = new Set([...encoders.out.matchAll(/\b(libx264|libx265|libsvtav1|libaom-av1|[ah]264_\w+|hevc_\w+|av1_\w+)\b/g)].map(m => m[0]));
  if (!names.has('libx265') || !names.has('libx264')) throw new Error('FFmpeg skal indeholde libx265 og libx264.');
  const dri = await fs.readdir('/dev/dri').catch(() => []);
  const nvidiaNode = await fs.stat('/dev/nvidia0').then(() => true, () => false);
  const devices = {
    cpu: true,
    nvidia: nvidiaNode && (names.has('hevc_nvenc') || names.has('h264_nvenc') || names.has('av1_nvenc')),
    intel: dri.some(n => n.startsWith('renderD')) && (names.has('hevc_qsv') || names.has('h264_qsv')),
    vaapi: dri.some(n => n.startsWith('renderD')) && (names.has('hevc_vaapi') || names.has('h264_vaapi')),
  };
  const render = dri.find(n => n.startsWith('renderD'));
  return { encoders: [...names], hwaccels: hw.out.split(/\s+/).filter(Boolean), devices, render: render ? `/dev/dri/${render}` : null, parallel: devices.nvidia || devices.intel || devices.vaapi };
}

export function planEncode(options, hardware) {
  const family = FAMILIES[options.codec];
  const order = options.device === 'auto' ? ['nvidia', 'intel', 'vaapi', 'cpu'] : [options.device, 'cpu'];
  const tried = [];
  for (const device of order) {
    const encoder = family[device];
    tried.push(encoder);
    const available = device === 'cpu' || (hardware?.devices?.[device] && hardware.encoders.includes(encoder));
    if (available && (device === 'cpu' || hardware.encoders.includes(encoder))) {
      return { encoder, device, codec: options.codec, fallback: device !== order[0] && order[0] !== 'cpu', tried };
    }
  }
  return { encoder: family.cpu, device: 'cpu', codec: options.codec, fallback: options.device !== 'cpu', tried };
}
