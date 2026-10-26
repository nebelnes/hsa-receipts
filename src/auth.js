// Checks that each request came through the Cloudflare Access sign-in
// (one-time email codes) and belongs to an allowed email address.
// Access already blocks strangers at Cloudflare's edge; this second check
// means the site stays locked even if Access were misconfigured.

let jwksCache = { at: 0, keys: [] };

function b64urlToBytes(text) {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function b64urlToJson(text) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(text)));
}

function teamUrl(env) {
  let t = (env.ACCESS_TEAM_DOMAIN || '').trim().replace(/\/+$/, '');
  if (t && !t.startsWith('http')) t = `https://${t}`;
  return t;
}

async function getKeys(env, force = false) {
  if (!force && jwksCache.keys.length && Date.now() - jwksCache.at < 3600_000) return jwksCache.keys;
  const res = await fetch(`${teamUrl(env)}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Could not load Access keys (${res.status})`);
  const body = await res.json();
  jwksCache = { at: Date.now(), keys: body.keys || [] };
  return jwksCache.keys;
}

export function authConfigured(env) {
  return !!(teamUrl(env) && (env.ACCESS_AUD || '').trim() && allowedEmails(env).length);
}

export function allowedEmails(env) {
  return (env.ALLOWED_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

// Returns { email } when the visitor is allowed, otherwise { error }.
export async function authenticate(request, env) {
  if (env.DEV_NO_AUTH === '1') return { email: 'dev@localhost' };
  if (!authConfigured(env)) return { error: 'not-configured' };

  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return { error: 'no-token' };
  const parts = token.split('.');
  if (parts.length !== 3) return { error: 'bad-token' };

  let header, payload;
  try {
    header = b64urlToJson(parts[0]);
    payload = b64urlToJson(parts[1]);
  } catch {
    return { error: 'bad-token' };
  }

  let keys = await getKeys(env);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await getKeys(env, true);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) return { error: 'unknown-key' };

  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) return { error: 'bad-signature' };

  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD.trim())) return { error: 'wrong-audience' };
  if (payload.exp && payload.exp < now) return { error: 'expired' };
  if (payload.iss && payload.iss !== teamUrl(env)) return { error: 'wrong-issuer' };

  const email = String(payload.email || '').toLowerCase();
  if (!email || !allowedEmails(env).includes(email)) return { error: 'not-allowed' };
  return { email };
}
