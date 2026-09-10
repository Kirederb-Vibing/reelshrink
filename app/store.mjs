import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { settings } from './config.mjs';

export const ACTIVE = ['queued', 'running', 'cancel_requested'];
export class Store {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(path.join(dir, 'reelshrink.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO settings VALUES ('paused','false');
      CREATE TABLE IF NOT EXISTS watches (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
        settings TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        created INTEGER NOT NULL, last_scan INTEGER, scan_error TEXT, waiting INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, watch_id TEXT NOT NULL REFERENCES watches(id), source TEXT NOT NULL,
        relative TEXT NOT NULL, signature TEXT NOT NULL, bundle TEXT NOT NULL, settings TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued', created INTEGER NOT NULL, updated INTEGER NOT NULL,
        progress REAL NOT NULL DEFAULT 0, speed TEXT, eta REAL, input_bytes INTEGER NOT NULL,
        output_bytes INTEGER, saved_bytes INTEGER NOT NULL DEFAULT 0, output TEXT, error TEXT,
        log TEXT, info TEXT, UNIQUE(watch_id, source, signature)
      );
      CREATE INDEX IF NOT EXISTS job_queue ON jobs(state,created);
      `);
    if (!this.all('PRAGMA table_info(jobs)').some(c => c.name === 'hidden')) {
      this.db.exec('ALTER TABLE jobs ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
    }
    if (!this.all('PRAGMA table_info(jobs)').some(c => c.name === 'output_sha256')) this.db.exec('ALTER TABLE jobs ADD COLUMN output_sha256 TEXT');
    this.db.exec(`PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS returns (
        id TEXT PRIMARY KEY, input TEXT NOT NULL, input_stamp TEXT NOT NULL,
        original TEXT NOT NULL, mode TEXT NOT NULL, state TEXT NOT NULL,
        error TEXT, details TEXT NOT NULL, updated INTEGER NOT NULL,
        UNIQUE(input,input_stamp)
      );
      CREATE INDEX IF NOT EXISTS return_original ON returns(original,state);
      CREATE TABLE IF NOT EXISTS returned_files (path TEXT PRIMARY KEY, stamp TEXT NOT NULL, return_id TEXT NOT NULL);
      PRAGMA user_version=3;`);
  }
  all(sql, ...p) { return this.db.prepare(sql).all(...p); }
  get(sql, ...p) { return this.db.prepare(sql).get(...p); }
  run(sql, ...p) { return this.db.prepare(sql).run(...p); }
  paused() { return this.get("SELECT value FROM settings WHERE key='paused'").value === 'true'; }
  setPaused(value) { this.run("UPDATE settings SET value=? WHERE key='paused'", String(value)); }
  watches() { return this.all('SELECT * FROM watches ORDER BY created').map(w => ({ ...w, settings: settings(JSON.parse(w.settings)), enabled: Boolean(w.enabled) })); }
  watch(id) { return this.watches().find(w => w.id === id); }
  addWatch(name, directory, options) {
    const id = randomUUID();
    this.run('INSERT INTO watches (id,name,path,settings,created) VALUES (?,?,?,?,?)', id, name, directory, JSON.stringify(options), Date.now());
    return this.watch(id);
  }
  updateJob(id, fields) {
    const allowed = new Set(['state','progress','speed','eta','output_bytes','saved_bytes','output','output_sha256','error','log','info','settings']);
    if (Object.keys(fields).some(k => !allowed.has(k))) throw new Error('Unknown job field');
    const entries = Object.entries({ ...fields, updated: Date.now() });
    this.run(`UPDATE jobs SET ${entries.map(([k]) => `${k}=?`).join(',')} WHERE id=?`, ...entries.map(([, v]) => v ?? null), id);
  }
  job(id) {
    const j = this.get('SELECT j.*, w.name AS watch_name FROM jobs j JOIN watches w ON w.id=j.watch_id WHERE j.id=? AND j.hidden=0', id);
    return j ? this.parseJob(j) : null;
  }
  parseJob(j) {
    const returned = this.get("SELECT details FROM returns WHERE input=? AND state IN ('done','deleted') ORDER BY updated DESC LIMIT 1",j.output||'');
    return { ...j, returned_output: returned ? JSON.parse(returned.details).target : null, bundle: JSON.parse(j.bundle), settings: settings(JSON.parse(j.settings)), info: j.info ? JSON.parse(j.info) : null };
  }
  removeJobs(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id))) throw new Error('Vælg mellem 1 og 100 jobs.');
    ids = [...new Set(ids)];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const jobs = ids.map(id => this.job(id));
      if (jobs.some(j => !j)) throw Object.assign(new Error('Et valgt job findes ikke længere. Opdater listen.'), {status:404});
      if (jobs.some(j => ['running','cancel_requested'].includes(j.state))) throw Object.assign(new Error('Annullér aktive jobs, og vent til de er stoppet, før du fjerner dem. Ingen jobs blev fjernet.'), {status:409});
      // Retain signatures so scanning does not immediately recreate removed jobs.
      for (const id of ids) this.run("UPDATE jobs SET hidden=1,state=CASE WHEN state='queued' THEN 'cancelled' ELSE state END,updated=? WHERE id=?", Date.now(), id);
      this.db.exec('COMMIT');
      return ids.length;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  enqueue(watch, source, relative, signature, bundle, size) {
    const id = randomUUID();
    const r = this.run(`INSERT OR IGNORE INTO jobs
      (id,watch_id,source,relative,signature,bundle,settings,created,updated,input_bytes) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id, watch.id, source, relative, signature, JSON.stringify(bundle), JSON.stringify(watch.settings), Date.now(), Date.now(), size);
    return r.changes ? id : null;
  }
  close() { this.db.close(); }
}
