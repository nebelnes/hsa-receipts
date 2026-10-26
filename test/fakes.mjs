// Test doubles: an in-memory D1 database (Node's built-in SQLite),
// an in-memory R2 bucket, and the static-assets binding (reads ./public).

import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';

class Stmt {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }
  bind(...args) {
    return new Stmt(this.db, this.sql, args.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v)));
  }
  async all() {
    return { results: this.db.prepare(this.sql).all(...this.args).map((r) => ({ ...r })) };
  }
  async first() {
    const r = this.db.prepare(this.sql).get(...this.args);
    return r ? { ...r } : null;
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

export class FakeD1 {
  constructor() {
    this.db = new DatabaseSync(':memory:');
  }
  prepare(sql) {
    return new Stmt(this.db, sql);
  }
  async batch(stmts) {
    this.db.exec('BEGIN');
    try {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}

export class FakeR2 {
  constructor() {
    this.objects = new Map();
  }
  async put(key, value, opts = {}) {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(await new Response(value).arrayBuffer());
    this.objects.set(key, { bytes, httpMetadata: opts.httpMetadata || {} });
    return { key, size: bytes.length };
  }
  async get(key) {
    const o = this.objects.get(key);
    if (!o) return null;
    return { body: new Blob([o.bytes]).stream(), size: o.bytes.length, httpMetadata: o.httpMetadata, arrayBuffer: async () => o.bytes.buffer };
  }
  async delete(keys) {
    for (const k of [].concat(keys)) this.objects.delete(k);
  }
}

const TYPES = { js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', css: 'text/css' };

export class FakeAssets {
  constructor(dir) {
    this.dir = dir;
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.includes('..')) return new Response('Not found', { status: 404 });
    try {
      const body = await readFile(new URL(`.${path}`, this.dir));
      const ext = path.split('.').pop();
      return new Response(body, { headers: { 'Content-Type': TYPES[ext] || 'application/octet-stream' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  }
}
