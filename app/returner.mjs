import fs from 'node:fs/promises';
import { createReadStream, constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { inside } from './config.mjs';
import { discover, bundleFor, signatureFor, probe, run } from './media.mjs';

export async function fingerprint(file) {
  const s = await fs.lstat(file, { bigint: true });
  if (!s.isFile() || s.isSymbolicLink()) throw new Error('Forventede en almindelig fil.');
  return [s.dev, s.ino, s.size, s.mtimeNs].join(':');
}
export async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
const exists = async file => { try { await fs.lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const normalize = value => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Only conservative filename identities. Never fuzzy-match different titles or remakes.
export function identity(file) {
  const stem = path.basename(file, path.extname(file));
  if (/(?:^|[ ._-])(sample|trailer|extras?|old)(?:$|[ ._-])/i.test(stem)) return null;
  const episode = /(?:^|[ ._-])s(\d{1,3})e(\d{1,3})((?:e\d{1,3}|-e?\d{1,3})*)(?!\d)/i.exec(stem);
  const alternate = !episode && /(?:^|[ ._-])(\d{1,2})x(\d{2,3})(?!\d)/i.exec(stem);
  const e = episode || alternate;
  if (e) {
    const title = normalize(stem.slice(0, e.index));
    // Ranges, combined episodes and unusual suffixes require manual filename correction.
    if (!title || e[3] || /^[- ._]*(?:e\d|\d+x\d|s\d+e\d|\d{2}(?:\D|$))/i.test(stem.slice(e.index + e[0].length))) return null;
    return `episode:${title}:${Number(e[1])}:${Number(e[2])}`;
  }
  const year = /(?:^|[ ._([\-])((?:19|20)\d{2})(?=$|[ ._)\]\-])/.exec(stem);
  if (!year) return null;
  const title = normalize(stem.slice(0, year.index));
  if (!title) return null;
  // Keep editions in the identity, so extended/director cuts cannot replace theatrical cuts.
  const edition = normalize(stem.slice(year.index + year[0].length)).replace(/director s cut|directors cut/g, 'director cut').match(/extended|unrated|director cut|theatrical|remastered|imax/g)?.sort().join(',') || '';
  return `movie:${title}:${year[1]}:${edition}`;
}

export function sourceHeld(store, file) {
  return Boolean(store.archiveHeld?.(file) || store.get("SELECT id FROM returns WHERE original=? AND state IN ('queued','working','attention')", file));
}

export class Returner {
  constructor(c, store, engine) {
    this.c = c; this.store = store; this.engine = engine;
    this.seen = new Map(); this.scanning = false; this.active = null; this.stopping = false;
    this.controller = new AbortController(); this.scanError = null; this.lastScan = null;
  }
  async init() {
    // An interrupted transaction is never retried without explicit review.
    this.store.run("UPDATE returns SET state='attention',error='Afbrudt under flytning. Kontrollér stierne og vælg Gendan original.' WHERE state='working'");
    this.store.run("UPDATE returns SET state='ready',error='Flyttekø afbrudt af genstart; vælg Flyt igen.' WHERE state='queued'");
    for (const r of this.list().filter(r => r.state === 'deleting')) {
      const present = await exists(r.details.backup);
      this.update(r.id, { state: present ? 'done' : 'deleted', error: present ? 'Sletning afbrudt; OLD er bevaret.' : 'OLD blev slettet før genstart.' });
    }
  }
  options() {
    const row = this.store.get("SELECT value FROM settings WHERE key='return_options'");
    return row ? JSON.parse(row.value) : { automatic: false, from: '', to: '' };
  }
  async allowed(candidate, roots, directory = false) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) throw new Error('Brug en absolut containersti.');
    const real = await fs.realpath(candidate);
    if (real !== path.resolve(candidate)) throw new Error('Symlinks er ikke tilladt ved tilbageflytning.');
    const allowedRoots = await Promise.all(roots.map(r => fs.realpath(r).catch(() => null)));
    if (!allowedRoots.some(r => r && inside(real, r))) throw new Error('Stien er uden for de tilladte mapper.');
    if (inside(real, this.c.configDir)) throw new Error('Konfigurationsmappen kan ikke bruges.');
    if (directory ? !(await fs.stat(real)).isDirectory() : !(await fs.lstat(real)).isFile()) throw new Error('Forkert filtype.');
    return real;
  }
  inputRoots() { return [this.c.outputRoot, ...this.c.returnInputRoots]; }
  async setOptions(data) {
    if (typeof data.automatic !== 'boolean' || typeof data.from !== 'string' || typeof data.to !== 'string') throw new Error('Ugyldige indstillinger.');
    const previous = this.options();
    const samePaths = data.from === previous.from && data.to === previous.to;
    if (samePaths) {
      this.store.run("INSERT OR REPLACE INTO settings VALUES ('return_options',?)", JSON.stringify({ ...previous, automatic: data.automatic }));
      if (!data.automatic) this.store.run("UPDATE returns SET state='ready',error='Automatisk flytning er sat på pause.' WHERE state='queued' AND mode='reelshrink'");
      return this.options();
    }
    if (this.scanning || this.active || this.store.get("SELECT id FROM returns WHERE state='queued'")) throw new Error('Vent til den aktuelle scanning eller flyttekø er afsluttet, før du ændrer mapper.');
    if (Boolean(data.from) !== Boolean(data.to)) throw new Error('Angiv både fra- og tilmappe, eller lad begge være tomme.');
    let from = '', to = '';
    if (data.from) {
      from = await this.allowed(data.from, this.inputRoots(), true);
      to = await this.allowed(data.to, this.c.mediaRoots, true);
      if (inside(from, to) || inside(to, from)) throw new Error('Fra- og tilmapper må ikke overlappe.');
    }
    this.store.run("INSERT OR REPLACE INTO settings VALUES ('return_options',?)", JSON.stringify({ automatic: data.automatic, from, to }));
    // Proposals from an old mapping must not remain actionable.
    this.store.run("DELETE FROM returns WHERE state IN ('waiting','ready','ambiguous','unmatched','blocked') AND mode='filename'");
    this.seen.clear();
    return this.options();
  }
  start() {
    this.timer = setInterval(() => this.scan(), this.c.scanInterval * 1000);
    this.scan(); this.tick();
  }
  async stop() {
    this.stopping = true; clearInterval(this.timer); this.controller.abort();
    await this.workerPromise?.catch(() => {});
    while (this.scanning) await new Promise(r => setTimeout(r, 20));
  }
  row(id) {
    const row = this.store.get('SELECT * FROM returns WHERE id=?', id);
    return row ? { ...row, details: JSON.parse(row.details) } : null;
  }
  list() {
    return this.store.all('SELECT id FROM returns ORDER BY updated DESC, id').map(r => this.row(r.id));
  }
  status() {
    return { workRoot: this.c.workRoot, options: this.options(), scanning: this.scanning, active: this.active, scanError: this.scanError, lastScan: this.lastScan, inputRoots: this.inputRoots(), mediaRoots: this.c.mediaRoots, stableSeconds: this.c.stableSeconds, items: this.list().map(r => ({ ...r, canUnsafe: r.mode === 'reelshrink' && Boolean(r.details.jobId) && ['ready','blocked','failed'].includes(r.state) })) };
  }
  update(id, fields) {
    const keys = Object.keys(fields);
    if (keys.some(k => !['state','error','details','original','updated'].includes(k))) throw new Error('Unknown return field');
    fields.updated = Date.now();
    this.store.run(`UPDATE returns SET ${Object.keys(fields).map(k => `${k}=?`).join(',')} WHERE id=?`, ...Object.values(fields), id);
  }
  async scan() {
    if (this.stopping || this.scanning || this.active) return;
    this.scanning = true; this.scanError = null;
    try {
      const opts = this.options(), scans = [{ from: this.c.outputRoot, to: null }];
      if (opts.from && opts.from !== this.c.outputRoot) scans.push({ from: opts.from, to: opts.to });
      else if (opts.from) scans[0].to = opts.to;
      let library = null;
      const live = new Set();
      for (const scope of scans) {
        const from = await this.allowed(scope.from, this.inputRoots(), true);
        for (const input of await discover(from, this.controller.signal)) {
          if (this.stopping) break;
          const stamp = await fingerprint(input), key = input + '|' + stamp;
          live.add(key);
          let old = this.store.get('SELECT * FROM returns WHERE input=? AND input_stamp=?', input, stamp);
          if (old && !['waiting','ready','ambiguous','unmatched','blocked'].includes(old.state)) continue;
          const since = this.seen.get(key) ?? Date.now(); this.seen.set(key, since);
          const job = this.store.get("SELECT * FROM jobs WHERE output=? AND state='completed'", input);
          let state = 'waiting', reason = 'Venter på uændret filstørrelse og ændringstid.', original = '', candidates = [], mode = job ? 'reelshrink' : 'filename', targetStamp = null;
          if (Date.now() - since >= this.c.stableSeconds * 1000 && (await fs.stat(input)).size) {
            if (job) {
              try {
                original = await this.allowed(job.source, this.c.mediaRoots);
                if (await signatureFor(original, await bundleFor(original)) !== job.signature) throw new Error('Originalen eller dens sidefiler er ændret siden encoding.');
                if ((await fs.stat(input)).size !== job.output_bytes) throw new Error('Outputstørrelsen er ændret siden encoding.');
                state = 'ready'; reason = 'Præcist match fra Reelshrinks jobhistorik.';
              } catch (e) { state = 'blocked'; reason = e.message; }
            } else if (!scope.to) {
              state = 'unmatched'; reason = 'Ingen jobforbindelse. Vælg fra- og tilmappe for navnesammenligning.';
            } else {
              const to = await this.allowed(scope.to, this.c.mediaRoots, true);
              library ??= await discover(to, this.controller.signal);
              const id = identity(input);
              candidates = id ? library.filter(file => identity(file) === id) : [];
              if (candidates.length === 1) { original = candidates[0]; state = 'ready'; reason = 'Titel + år / serie + sæson og episode matcher. Kræver dit valg af Flyt.'; }
              else if (candidates.length > 1) { state = 'ambiguous'; reason = 'Flere originaler matcher. Vælg den rigtige fil.'; }
              else { state = 'unmatched'; reason = 'Intet sikkert navnematch. Film kræver titel og år; serier kræver titel og SxxExx eller 1x01.'; }
              if (old && JSON.parse(old.details).chosen && candidates.includes(old.original)) {
                original = old.original; state = 'ready'; reason = 'Original valgt manuelt.';
              }
            }
            if (state === 'ready') {
              targetStamp = await fingerprint(original);
              if (sourceHeld(this.store, original) || this.engine.active && this.store.job(this.engine.active.id)?.source === original) {
                state = 'blocked'; reason = 'Originalen bruges af et aktivt job eller en uafsluttet flytning.';
              }
            }
          }
          const details = { candidates, targetStamp, inputBytes: (await fs.stat(input)).size, originalBytes: original && state === 'ready' ? (await fs.stat(original)).size : null, jobId: job?.id || null, chosen: old ? JSON.parse(old.details).chosen : false };
          if (old) this.update(old.id, { state, error: reason, original, details: JSON.stringify(details) });
          else {
            const id = randomUUID();
            this.store.run('INSERT INTO returns (id,input,input_stamp,original,mode,state,error,details,updated) VALUES (?,?,?,?,?,?,?,?,?)', id, input, stamp, original, mode, state, reason, JSON.stringify(details), Date.now());
          }
        }
      }
      for (const row of this.list()) {
        if (['waiting','ready','ambiguous','unmatched','blocked'].includes(row.state) && !live.has(row.input + '|' + row.input_stamp)) this.update(row.id, { state: 'missing', error: 'Frafilen er flyttet, ændret eller ikke længere i den valgte mappe.' });
      }
      for (const key of this.seen.keys()) if (!live.has(key)) this.seen.delete(key);
      this.lastScan = Date.now();
      if (this.options().automatic) {
        for (const row of this.list().filter(r => r.state === 'ready' && r.mode === 'reelshrink')) this.update(row.id, { state: 'queued', error: 'Automatisk tilbageflytning i kø.' });
      }
    } catch (e) { this.scanError = e.message; }
    finally { this.scanning = false; if (!this.stopping) this.tick(); }
  }
  async choose(id, original) {
    if (this.scanning) throw new Error('Vent til scanningen er afsluttet.');
    const r = this.row(id);
    if (!r || r.state !== 'ambiguous' || !r.details.candidates.includes(original)) throw new Error('Vælg en af de foreslåede originaler.');
    await this.allowed(original, this.c.mediaRoots);
    this.update(id, { original, state: 'ready', error: 'Original valgt manuelt.', details: JSON.stringify({ ...r.details, chosen: true, targetStamp: await fingerprint(original) }) });
  }
  enqueue(ids, unsafeIds = []) {
    if (this.scanning) throw new Error('Vent til scanningen er afsluttet.');
    this.validateIds(ids); if (!Array.isArray(unsafeIds) || unsafeIds.some(id => !ids.includes(id)) || new Set(unsafeIds).size !== unsafeIds.length) throw new Error('Ugyldigt valg af usikker tilbageflytning.');
    const unsafe = new Set(unsafeIds);
    const rows = ids.map(id => this.row(id));
    if (rows.some(r => {
      if (!r) return true;
      return unsafe.has(r.id) ? !(r.mode === 'reelshrink' && r.details.jobId && ['ready','blocked','failed'].includes(r.state)) : r.state !== 'ready';
    })) throw new Error('Alle valgte filer skal være klar, eller markeres som usikker ReelShrink-tilbageflytning.');
    if (new Set(rows.map(r => r.original)).size !== rows.length) throw new Error('Flere valgte filer erstatter samme original. Vælg én version.');
    for (const r of rows) this.update(r.id, { state: 'queued', error: unsafe.has(r.id) ? 'Venter på usikker tilbageflytning.' : 'Venter på kontrol og flytning.', details: JSON.stringify({ ...r.details, unsafe: unsafe.has(r.id) }) });
    this.tick();
  }
  validateIds(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string')) throw new Error('Vælg 1–100 forskellige filer.');
  }
  retry(id) {
    if (this.active || this.scanning) throw new Error('Vent til igangværende arbejde er afsluttet.');
    const r = this.row(id);
    if (!r || r.state !== 'failed') throw new Error('Kun fejlede flytninger uden filændringer kan genstartes.');
    this.seen.delete(r.input + '|' + r.input_stamp);
    this.update(id, { state: 'waiting', error: 'Afventer ny stabilitetskontrol.' });
    this.scan();
  }
  tick() {
    if (this.stopping || this.active || this.scanning) return;
    const next = this.store.get("SELECT id FROM returns WHERE state='queued' ORDER BY updated,id LIMIT 1");
    if (!next) return;
    this.active = next.id;
    this.workerPromise = this.transfer(next.id).catch(e => {
      this.update(next.id, { state: 'attention', error: e.message });
    }).finally(() => { this.active = null; this.workerPromise = null; if (!this.stopping) setImmediate(() => this.tick()); });
  }
  async checkUnchanged(file, stamp, roots) {
    await this.allowed(file, roots);
    if (await fingerprint(file) !== stamp) throw new Error('En fil er ændret siden scanning/kopiering. Intet overskrives.');
  }
  async sync(file) { const h = await fs.open(file, 'r'); try { await h.sync(); } finally { await h.close(); } }
  async transfer(id) {
    const r = this.row(id);
    if (!r || !['ready','queued'].includes(r.state)) throw new Error('Filen er ikke klar.');
    if (this.store.archiveHeld?.(r.original)) throw new Error('Emnet er valgt til serveroverførsel eller allerede afsendt.');
    if (this.engine.active && this.store.job(this.engine.active.id)?.source === r.original) {
      this.update(id, { state: 'failed', error: 'Originalen encodes lige nu. Prøv igen når jobbet er færdigt.' }); return;
    }
    if (r.details.unsafe) return this.unsafeTransfer(r);
    this.update(id, { state: 'working', error: 'Kontrollerer medier og kopierer til destinationsdisken…' });
    let journal = null;
    try {
      await this.checkUnchanged(r.input, r.input_stamp, this.inputRoots());
      await this.checkUnchanged(r.original, r.details.targetStamp, this.c.mediaRoots);
      if (r.details.jobId) {
        const job = this.store.get("SELECT * FROM jobs WHERE id=? AND state='completed'", r.details.jobId);
        if (!job || job.output !== r.input || await signatureFor(r.original, await bundleFor(r.original)) !== job.signature) throw new Error('Jobforbindelsen eller originalen er ændret.');
        if (job.output_sha256 && await digest(r.input) !== job.output_sha256) throw new Error('Outputindholdet er ændret siden encoding.');
      }
      const signal = this.controller.signal;
      const before = await probe(r.original, this.c, signal), incoming = await probe(r.input, this.c, signal);
      if (Math.abs(before.duration - incoming.duration) > Math.max(2, before.duration * 0.01)) throw new Error('Varigheden afviger for meget. Filerne kan være forskellige udgaver eller afsnit.');
      await run(this.c.ffmpeg, ['-nostdin','-v','error','-xerror','-threads',String(this.c.threads),'-protocol_whitelist','file,pipe','-i',r.input,'-map','0:v:0','-map','0:a?','-f','null','-'], { signal });
      const target = path.join(path.dirname(r.original), path.basename(r.original, path.extname(r.original)) + path.extname(r.input));
      if (target !== r.original && await exists(target)) throw new Error('Destinationsfilen findes allerede. Den overskrives ikke.');
      const backup = r.original + '.OLD';
      if (await exists(backup)) throw new Error('Der findes allerede en OLD-fil. Gennemgå den først.');
      const bundle = await bundleFor(r.input), sidecars = [];
      for (const file of [...bundle.subtitles.map(s => s.path), ...bundle.sidecars]) {
        await this.allowed(file, this.inputRoots());
        const rel = path.relative(path.dirname(r.input), file);
        const sourceStem = path.basename(r.input, path.extname(r.input)), targetStem = path.basename(r.original, path.extname(r.original));
        let name = path.basename(rel);
        if (name.startsWith(sourceStem)) name = targetStem + name.slice(sourceStem.length);
        const dest = path.join(path.dirname(target), path.dirname(rel), name);
        if (!inside(dest, path.dirname(target))) throw new Error('Ugyldig sidefilsti.');
        const hash = await digest(file), present = await exists(dest);
        if (present) { await this.allowed(dest, this.c.mediaRoots); if (await digest(dest) !== hash) throw new Error('Sidefil-konflikt: ' + dest + '. Eksisterende undertekster/metadata bevares.'); }
        sidecars.push({ input: file, target: dest, hash, stamp: await fingerprint(file), present });
      }
      const disk = await fs.statfs(path.dirname(target)), size = (await fs.stat(r.input)).size;
      let required = size;
      for (const s of sidecars) if (!s.present) required += (await fs.stat(s.input)).size;
      if (disk.bavail * disk.bsize < required + this.c.minFreeBytes) throw new Error('For lidt ledig plads på destinationsdisken til sikker kopiering.');
      const temp = path.join(path.dirname(target), '.reelshrink-return-' + id);
      journal = { ...r.details, target, backup, temp, sidecars, hash: await digest(r.input), originalHash: await digest(r.original), phase: 'copying' };
      this.update(id, { details: JSON.stringify(journal) });
      await fs.copyFile(r.input, temp, constants.COPYFILE_EXCL);
      await this.sync(temp);
      if (await digest(temp) !== journal.hash) throw new Error('Kopieringen bestod ikke checksumkontrollen.');
      await this.checkUnchanged(r.input, r.input_stamp, this.inputRoots());
      await this.checkUnchanged(r.original, r.details.targetStamp, this.c.mediaRoots);
      if (await digest(r.original) !== journal.originalHash) throw new Error('Originalen ændrede indhold under kopieringen.');
      if (signal.aborted) throw new Error('Flytningen blev afbrudt før ændring af originalen.');
      journal.phase = 'prepared'; this.update(id, { details: JSON.stringify(journal) });
      // Exclusive same-filesystem hardlinks provide no-clobber publication. A NAS without
      // hardlink support fails here, before the original is removed. Never fall back to overwrite.
      await fs.link(r.original, backup); await this.sync(path.dirname(backup));
      journal.phase = 'backup'; this.update(id, { details: JSON.stringify(journal) });
      await this.checkUnchanged(r.original, r.details.targetStamp, this.c.mediaRoots);
      await fs.unlink(r.original); await this.sync(path.dirname(backup));
      await fs.link(temp, target); await this.sync(path.dirname(target));
      journal.phase = 'installed'; this.update(id, { details: JSON.stringify(journal) });
      for (const s of sidecars) {
        await this.checkUnchanged(s.input, s.stamp, this.inputRoots());
        if (s.present) continue;
        await fs.mkdir(path.dirname(s.target), { recursive: true });
        await this.allowed(path.dirname(s.target), this.c.mediaRoots, true);
        const stage = path.join(path.dirname(s.target), '.reelshrink-sidecar-' + randomUUID());
        try {
          await fs.copyFile(s.input, stage, constants.COPYFILE_EXCL); await this.sync(stage);
          if (await digest(stage) !== s.hash) throw new Error('Sidefilen ændrede sig under kopiering.');
          await fs.link(stage, s.target); await this.sync(path.dirname(s.target));
        } finally { await fs.rm(stage, { force: true }); }
      }
      await this.allowed(target, this.c.mediaRoots);
      if (await digest(target) !== journal.hash) throw new Error('Den installerede fil bestod ikke checksumkontrollen.');
      journal.targetStamp = await fingerprint(target); journal.backupStamp = await fingerprint(backup);
      journal.phase = 'verified'; this.update(id, { details: JSON.stringify(journal) });
      this.store.run('INSERT OR REPLACE INTO returned_files VALUES (?,?,?)', target, journal.targetStamp, id);
      this.store.run("UPDATE jobs SET state='cancelled',error='Originalen er erstattet via Tilbageflytning.',updated=? WHERE source=? AND state='queued'", Date.now(), r.original);
      // Only remove the incoming VIDEO after durable destination + backup verification.
      // Keep input sidecars/manifest as an audit bundle; never recursively delete directories.
      await this.checkUnchanged(r.input, r.input_stamp, this.inputRoots());
      if (await digest(r.input) !== journal.hash) throw new Error('Frafilen er ændret; den beholdes.');
      await fs.unlink(r.input); await this.sync(path.dirname(r.input));
      await fs.unlink(temp); await this.sync(path.dirname(temp));
      journal.phase = 'done';
      this.update(id, { state: 'done', error: 'Flyttet og kontrolleret. Originalen venter som OLD.', details: JSON.stringify(journal) });
    } catch (e) {
      this.update(id, { state: journal ? 'attention' : 'failed', error: e.message });
      // Keep all journal-owned files for explicit recovery after partial operations.
    }
  }
  async unsafeTransfer(r) {
    const id = r.id;
    this.update(id, { state: 'working', error: 'Usikker flytning: kopierer uden medietest…' });
    let journal = null;
    try {
      const input = await this.allowed(r.input, this.inputRoots());
      await this.allowed(r.original, this.c.mediaRoots);
      const job = this.store.get("SELECT * FROM jobs WHERE id=? AND state='completed'", r.details.jobId);
      if (!job || job.output !== input || job.source !== r.original) throw new Error('Den præcise ReelShrink-jobforbindelse findes ikke længere.');
      const target = path.join(path.dirname(r.original), path.basename(r.original, path.extname(r.original)) + path.extname(input));
      await this.allowed(path.dirname(target), this.c.mediaRoots, true);
      const temp = path.join(path.dirname(target), '.reelshrink-unsafe-new-' + id);
      const backup = path.join(path.dirname(r.original), '.reelshrink-unsafe-old-' + id);
      if (await exists(temp) || await exists(backup)) throw new Error('En tidligere usikker flytning kræver manuel gendannelse først.');
      const inputBytes = (await fs.stat(input)).size, originalBytes = (await fs.stat(r.original)).size;
      const disk = await fs.statfs(path.dirname(target));
      if (disk.bavail * disk.bsize < inputBytes + this.c.minFreeBytes) throw new Error('For lidt ledig plads på destinationsdisken.');
      const hash = await digest(input), originalHash = await digest(r.original);
      journal = { ...r.details, unsafe: true, target, backup, temp, sidecars: [], hash, originalHash, inputBytes, originalBytes, phase: 'copying' };
      this.update(id, { details: JSON.stringify(journal) });
      await fs.copyFile(input, temp, constants.COPYFILE_EXCL); await this.sync(temp);
      if (await digest(temp) !== hash) throw new Error('Kopieringen bestod ikke checksumkontrollen.');
      journal.phase = 'prepared'; this.update(id, { details: JSON.stringify(journal) });
      await fs.rename(r.original, backup); await this.sync(path.dirname(backup));
      journal.phase = 'backup'; this.update(id, { details: JSON.stringify(journal) });
      if (target !== r.original && await exists(target)) { await this.allowed(target, this.c.mediaRoots); await fs.unlink(target); }
      await fs.rename(temp, target); await this.sync(path.dirname(target));
      if (await digest(target) !== hash) throw new Error('Den installerede fil bestod ikke checksumkontrollen.');
      journal.targetStamp = await fingerprint(target); journal.phase = 'installed'; this.update(id, { details: JSON.stringify(journal) });
      this.store.run('INSERT OR REPLACE INTO returned_files VALUES (?,?,?)', target, journal.targetStamp, id);
      this.store.run("UPDATE jobs SET state='cancelled',error='Originalen er erstattet via usikker Tilbageflytning.',updated=? WHERE source=? AND state='queued'", Date.now(), r.original);
      await fs.unlink(input); await this.sync(path.dirname(input));
      await fs.unlink(backup); await this.sync(path.dirname(backup));
      journal.phase = 'done';
      this.update(id, { state: 'deleted', error: 'Usikkert flyttet. Den registrerede original blev slettet uden OLD-kø.', details: JSON.stringify(journal) });
    } catch (e) {
      this.update(id, { state: journal ? 'attention' : 'failed', error: e.message });
    }
  }
  async restore(id) {
    if (this.active || this.scanning) throw new Error('Vent til igangværende arbejde er afsluttet.');
    this.active = 'restore';
    this.workerPromise = this.restoreFiles(id);
    try { return await this.workerPromise; } finally { this.active = null; this.workerPromise = null; }
  }
  async restoreFiles(id) {
    const r = this.row(id);
    if (!r || !['attention','done'].includes(r.state)) throw new Error('Denne original kan ikke gendannes.');
    if (this.store.archiveHeld?.(r.original)) throw new Error('Emnet er valgt til serveroverførsel eller allerede afsendt.');
    const j = r.details;
    await this.allowed(path.dirname(r.original), this.c.mediaRoots, true);
    if (!j.backup) { this.update(id, { state: 'failed', error: 'Ingen filændring var startet. Ret fejlen og vælg Prøv igen.' }); return; }
    // Never delete a file as part of recovery. Move a verified replacement out of the way.
    const originalExists = await exists(r.original), backupExists = await exists(j.backup);
    if (backupExists) {
      await this.allowed(j.backup, this.c.mediaRoots);
      if (await digest(j.backup) !== j.originalHash) throw new Error('OLD-filen er ændret; automatisk gendannelse er blokeret.');
    }
    if (originalExists) {
      await this.allowed(r.original, this.c.mediaRoots);
      const currentHash = await digest(r.original);
      if (currentHash !== j.originalHash) {
        if (!backupExists || r.original !== j.target || currentHash !== j.hash) throw new Error('Originalstien indeholder en anden fil. Gennemgå stierne manuelt.');
        const keep = j.target + '.RETURNED-' + id;
        if (!await exists(keep)) await fs.link(j.target, keep);
        else if (await digest(keep) !== j.hash) throw new Error('Gendannelsesfilen findes allerede med andet indhold.');
        await this.sync(path.dirname(keep)); await fs.unlink(r.original);
      }
    }
    if (!await exists(r.original)) {
      if (!backupExists) throw new Error('Original og OLD mangler. Ingen filer ændres.');
      await fs.link(j.backup, r.original); await this.sync(path.dirname(r.original));
    }
    // For changed extensions, keep the replacement away from the media scanner too.
    if (j.target !== r.original && await exists(j.target)) {
      await this.allowed(j.target, this.c.mediaRoots);
      if (await digest(j.target) !== j.hash) throw new Error('Den nye fil er ændret. Den flyttes ikke.');
      const keep = j.target + '.RETURNED-' + id;
      if (!await exists(keep)) await fs.link(j.target, keep);
      else if (await digest(keep) !== j.hash) throw new Error('Gendannelsesfilen har andet indhold.');
      await this.sync(path.dirname(keep)); await fs.unlink(j.target);
    }
    this.store.run('DELETE FROM returned_files WHERE return_id=?', id);
    this.update(id, { state: 'restored', error: 'Originalen er gendannet. OLD, midlertidige og RETURNED-filer bevares til manuel gennemgang.' });
  }
  async deleteOld(ids, confirmation) {
    if (confirmation !== 'SLET OLD') throw new Error('Bekræft permanent sletning med SLET OLD.');
    if (this.active || this.scanning) throw new Error('Vent til igangværende arbejde er afsluttet.');
    this.validateIds(ids);
    this.active = 'delete';
    const operation = async () => {
      const rows = ids.map(id => this.row(id));
      // Preflight the whole selection, then recheck each file immediately before unlink.
      const check = async r => {
        if (!r || r.state !== 'done') throw new Error('Kun OLD-filer fra afsluttede flytninger kan slettes.');
        const j = r.details;
        await this.checkUnchanged(j.backup, j.backupStamp, this.c.mediaRoots);
        await this.checkUnchanged(j.target, j.targetStamp, this.c.mediaRoots);
        if (await digest(j.backup) !== j.originalHash || await digest(j.target) !== j.hash) throw new Error('Original eller erstatning er ændret. Sletning er blokeret.');
      };
      for (const r of rows) await check(r);
      const deleted = [];
      for (const r of rows) {
        await check(r);
        this.update(r.id, { state: 'deleting', error: 'Sletter den valgte OLD-fil.' });
        try { await fs.unlink(r.details.backup); await this.sync(path.dirname(r.details.backup)); }
        catch (e) {
          const present = await exists(r.details.backup);
          this.update(r.id, { state: present ? 'done' : 'deleted', error: 'Sletning afbrudt: ' + e.message });
          throw new Error(`${deleted.length} OLD-fil(er) allerede slettet. ${e.message} Opdater og gennemgå listen.`);
        }
        this.update(r.id, { state: 'deleted', error: 'OLD-filen er slettet manuelt.' }); deleted.push(r.id);
      }
      return { deleted };
    };
    this.workerPromise = operation();
    try { return await this.workerPromise; } finally { this.active = null; this.workerPromise = null; }
  }
}
