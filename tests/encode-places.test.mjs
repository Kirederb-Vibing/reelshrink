import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { settings } from '../app/config.mjs';
import { failureKind, transferRetry } from '../app/engine.mjs';
import { planEncode } from '../app/hardware.mjs';
import { encodeArgs } from '../app/media.mjs';
import { Places, parsePlacePath, parseRcloneStats } from '../app/places.mjs';
import { Store } from '../app/store.mjs';

test('existing profiles stay valid and gain the new encoding fields', () => {
  const basic = settings({ codec: 'h264', quality: 'high', preset: 'fast' });
  assert.equal(basic.codec, 'h264');
  assert.equal(basic.device, 'auto');
  assert.equal(basic.rateControl, 'crf');
  assert.equal(settings({ codec: 'av1', device: 'nvidia', audio: 'opus', deinterlace: true, tonemap: 'sdr' }).codec, 'av1');
  assert.throws(() => settings({ encoderParams: 'rm -rf /' }));
});

test('gpu encoders fall back to the matching cpu encoder', () => {
  const hardware = { encoders: ['libx265', 'libx264'], devices: { cpu: true, nvidia: false, intel: false, vaapi: false } };
  const plan = planEncode(settings({ codec: 'hevc', device: 'nvidia' }), hardware);
  assert.equal(plan.encoder, 'libx265');
  assert.equal(plan.device, 'cpu');
  assert.equal(plan.fallback, true);
  const ready = planEncode(settings({ codec: 'av1', device: 'nvidia' }), { encoders: ['libsvtav1', 'av1_nvenc', 'libx264', 'libx265'], devices: { cpu: true, nvidia: true } });
  assert.equal(ready.encoder, 'av1_nvenc');
});

test('encode args keep crf for the default cpu profile and add filters', () => {
  const media = { video: { index: 0, height: 2160, pix_fmt: 'yuv420p', color_transfer: 'bt709' }, streams: [] };
  const args = encodeArgs('/film.mkv', media, [], '/out.mkv', settings(), { threads: 2 });
  assert.ok(args.includes('libx265'));
  assert.ok(args.includes('-crf'));
  assert.equal(args.at(-1), '/out.mkv');
  const filtered = encodeArgs('/film.mkv', media, [], '/out.mkv', settings({ maxHeight: 1080, deinterlace: true, tonemap: 'sdr' }), { threads: 2 });
  assert.match(filtered[filtered.indexOf('-vf') + 1], /bwdif.*scale=-2:1080.*tonemap/);
});

test('transient failures are retried and permanent ones are not', () => {
  assert.equal(failureKind(Object.assign(new Error('læsefejl'), { code: 'EIO' })), 'transient');
  assert.equal(failureKind(new Error('Der er for lidt ledig plads')), 'permanent');
  assert.equal(failureKind(new Error('Outputkontrol: varigheden afviger for meget.')), 'permanent');
  assert.equal(failureKind(new Error('Kilden blev ændret under encodingen.')), 'permanent');
  assert.equal(failureKind(new Error('Fatal error: unknown flag: --inplace')), 'permanent');
  const first = transferRetry({});
  assert.equal(first.attempts, 1);
  assert.equal(first.wait, 60_000);
  assert.equal(transferRetry({ attempts: 5 }), null);
});

test('a storage place stores the secret outside the public view', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-places-'));
  const store = new Store(dir);
  const places = new Places(store, dir);
  const saved = places.save({ name: 'NAS', type: 'smb', config: { host: 'nas.home', share: 'film', user: 'frederik' }, secret: 'hemmelig' });
  assert.equal(saved.hasSecret, true);
  assert.equal(saved.config.share, 'film');
  assert.equal(JSON.stringify(saved).includes('hemmelig'), false);
  assert.deepEqual(parsePlacePath(`place:${saved.id}/Film/a.mkv`), { id: saved.id, rel: 'Film/a.mkv' });
  assert.throws(() => places.save({ name: 'x', type: 'sftp', config: { host: 'h', user: 'u', path: '../x' }, secret: 'p' }));
  const sftp = places.save({ name: 'NAS SFTP', type: 'sftp', config: { host: 'nas.home', user: 'film', path: '/srv/storage/media/movies' }, secret: 'p@ss' });
  assert.equal(sftp.config.path, '/srv/storage/media/movies');
  assert.equal(places.remote(places.get(sftp.id)), `${sftp.id}:/srv/storage/media/movies`);
  store.close();
});

test('rclone transfer stats become bytes, total and speed', () => {
  const text = parseRcloneStats('Transferred:   10.5 MiB / 1.5 GiB, 1%, 8.5 MiB/s, ETA 2m');
  assert.equal(text.bytes, 10.5 * 1024 ** 2);
  assert.equal(text.total, 1.5 * 1024 ** 3);
  assert.equal(text.speed, 8.5 * 1024 ** 2);
  const json = parseRcloneStats('{"level":"info","msg":"stats","stats":{"bytes":4096,"totalBytes":8192,"speed":100}}');
  assert.deepEqual(json, { bytes: 4096, total: 8192, speed: 100 });
  assert.equal(parseRcloneStats('directory not found'), null);
});
