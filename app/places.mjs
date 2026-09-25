import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const TYPES = ['smb', 'sftp', 's3'];
const secretKeys = { smb: 'pass', sftp: 'pass', s3: 'secret_access_key' };

function rclone(configFile, args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('rclone', ['--config', configFile, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const stop = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { err = (err + c).slice(-4000); });
    child.on('error', error => { signal?.removeEventListener('abort', stop); reject(error.code === 'ENOENT' ? new Error('rclone mangler i containeren. Genbyg imaget for at bruge SMB, SFTP og S3.') : error); });
    child.on('close', code => {
      signal?.removeEventListener('abort', stop);
      if (code === 0) resolve(out);
      else reject(new Error((err || `rclone fejlede (${code})`).trim()));
    });
  });
}

export function placePath(id, rel = '') {
  const clean = String(rel || '').replace(/^\/+/, '');
  return `place:${id}/${clean}`;
}
export function parsePlacePath(value) {
  const match = /^place:([a-f0-9-]{36})\/(.*)$/.exec(value || '');
  return match ? { id: match[1], rel: match[2] } : null;
}

export class Places {
  constructor(store, configDir) {
    this.store = store;
    this.configDir = configDir;
    this.file = path.join(configDir, 'places-rclone.conf');
    store.db.exec(`CREATE TABLE IF NOT EXISTS places (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
      config TEXT NOT NULL, secret TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL
    )`);
  }
  list() {
    return this.store.all('SELECT * FROM places ORDER BY created').map(row => this.public(row));
  }
  get(id) {
    const row = this.store.get('SELECT * FROM places WHERE id=?', id);
    if (!row) throw new Error('Stedet findes ikke.');
    return row;
  }
  public(row) {
    const config = JSON.parse(row.config);
    return { id: row.id, name: row.name, type: row.type, enabled: Boolean(row.enabled), config, hasSecret: Boolean(row.secret) };
  }
  validate(input, existing) {
    const type = input.type || existing?.type;
    if (!TYPES.includes(type)) throw new Error('Vælg SMB, SFTP eller S3.');
    const name = String(input.name ?? existing?.name ?? '').trim();
    if (!name || name.length > 60) throw new Error('Navnet skal være mellem 1 og 60 tegn.');
    const previous = existing ? JSON.parse(existing.config) : {};
    const config = { ...previous, ...(input.config || {}) };
    if (type === 'smb') {
      if (!/^[\w.-]{1,253}$/.test(config.host || '')) throw new Error('Angiv SMB-værten, fx nas.home.');
      if (!/^[^\\/]{1,80}$/.test(config.share || '')) throw new Error('Angiv sharenavnet uden skråstreger.');
    } else if (type === 'sftp') {
      if (!/^[\w.-]{1,253}$/.test(config.host || '')) throw new Error('Angiv SFTP-værten.');
      config.port = Number(config.port || 22);
      if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('Ugyldig SFTP-port.');
      if (!/^[\w.-]{1,64}$/.test(config.user || '')) throw new Error('Angiv SFTP-brugeren.');
    } else {
      if (!/^https?:\/\/[\w.-]+(?::\d+)?$/.test(config.endpoint || '')) throw new Error('S3-endpoint skal starte med http:// eller https://.');
      if (!/^[\w.-]{1,80}$/.test(config.bucket || '')) throw new Error('Angiv bucket-navnet.');
      if (!/^[\w][\w.-]{0,80}$/.test(config.access_key_id || '')) throw new Error('Angiv access key.');
    }
    config.path = String(config.path || '').replace(/^\/+|\/+$/g, '');
    if (config.path && config.path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Stien må ikke indeholde ..');
    const secret = input.secret === undefined ? existing?.secret || '' : String(input.secret);
    if (!existing && !secret) throw new Error('Adgangskoden eller nøglen mangler.');
    return { name, type, config, secret, enabled: input.enabled !== false };
  }
  save(input, id) {
    const existing = id ? this.get(id) : null;
    const place = this.validate(input, existing);
    const next = id || randomUUID();
    if (id) this.store.run('UPDATE places SET name=?,type=?,config=?,secret=?,enabled=? WHERE id=?', place.name, place.type, JSON.stringify(place.config), place.secret, Number(place.enabled), id);
    else this.store.run('INSERT INTO places (id,name,type,config,secret,enabled,created) VALUES (?,?,?,?,?,?,?)', next, place.name, place.type, JSON.stringify(place.config), place.secret, Number(place.enabled), Date.now());
    return this.public(this.get(next));
  }
  remove(id) {
    this.get(id);
    this.store.run('DELETE FROM places WHERE id=?', id);
  }
  async writeConfig() {
    const lines = [];
    for (const row of this.store.all('SELECT * FROM places WHERE enabled=1')) {
      const config = JSON.parse(row.config);
      lines.push(`[${row.id}]`, `type = ${row.type === 'smb' ? 'smb' : row.type}`);
      if (row.type === 'smb') lines.push(`host = ${config.host}`, `user = ${config.user || 'guest'}`, `pass = ${row.secret}`, config.domain ? `domain = ${config.domain}` : '');
      if (row.type === 'sftp') lines.push(`host = ${config.host}`, `port = ${config.port || 22}`, `user = ${config.user}`, `pass = ${row.secret}`);
      if (row.type === 's3') lines.push(`provider = Other`, `endpoint = ${config.endpoint}`, `access_key_id = ${config.access_key_id}`, `secret_access_key = ${row.secret}`, `region = ${config.region || 'us-east-1'}`, `force_path_style = true`);
    }
    await fs.writeFile(this.file, lines.filter(Boolean).join('\n') + '\n', { mode: 0o600 });
  }
  remote(row, rel = '') {
    const config = JSON.parse(row.config);
    const base = row.type === 'smb' ? config.share : row.type === 's3' ? config.bucket : '';
    const sub = [config.path, rel].filter(Boolean).join('/');
    return `${row.id}:${[base, sub].filter(Boolean).join('/')}`;
  }
  async test(id) {
    const row = this.get(id);
    await this.writeConfig();
    await rclone(this.file, ['lsd', this.remote(row), '--max-depth', '1', '--contimeout', '15s', '--timeout', '30s']);
    return { ok: true };
  }
  async listVideos(row, signal) {
    await this.writeConfig();
    const raw = await rclone(this.file, ['lsjson', this.remote(row), '-R', '--files-only', '--contimeout', '20s', '--timeout', '120s'], { signal });
    const videos = [];
    for (const item of JSON.parse(raw || '[]')) {
      if (!/\.(mkv|mp4|m4v|avi|mov|ts|m2ts|webm)$/i.test(item.Path)) continue;
      videos.push({ path: placePath(row.id, item.Path), relative: item.Path, size: item.Size, mtimeMs: Date.parse(item.ModTime) || 0 });
    }
    return videos;
  }
  async copyTo(row, rel, dest, signal) {
    await this.writeConfig();
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await rclone(this.file, ['copyto', this.remote(row, rel), dest, '--contimeout', '20s', '--timeout', '6h', '--retries', '3'], { signal });
  }
  async copyFrom(row, rel, source, signal) {
    await this.writeConfig();
    await rclone(this.file, ['copyto', source, this.remote(row, rel), '--contimeout', '20s', '--timeout', '6h', '--retries', '3'], { signal });
  }
  async removeFile(row, rel, signal) {
    await this.writeConfig();
    await rclone(this.file, ['deletefile', this.remote(row, rel)], { signal });
  }
}

export { secretKeys };
