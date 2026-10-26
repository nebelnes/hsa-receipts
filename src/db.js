// Database helpers.

export async function all(env, sql, ...args) {
  const r = await env.DB.prepare(sql).bind(...args).all();
  return r.results || [];
}

export async function one(env, sql, ...args) {
  return env.DB.prepare(sql).bind(...args).first();
}

export async function run(env, sql, ...args) {
  return env.DB.prepare(sql).bind(...args).run();
}

export async function getSetting(env, key, fallback = null) {
  const r = await one(env, 'SELECT value FROM settings WHERE key = ?', key);
  return r && r.value !== null ? r.value : fallback;
}

export async function setSetting(env, key, value) {
  await run(
    env,
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    value === null || value === undefined ? null : String(value),
  );
}
