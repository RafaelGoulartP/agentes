// Web Push sem dependências (RFC 8030/8291/8292): chave VAPID, criptografia aes128gcm e envio.
// O celular instala o painel como app e entrega uma "inscrição" (endpoint + chaves); o painel cifra o aviso
// com a chave do aparelho e o serviço de push da Apple/Google/Mozilla só repassa bytes que não consegue ler.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const b64u = (value) => Buffer.from(value).toString('base64url');

// Só serviços de push conhecidos: o painel não tem senha, e uma inscrição forjada não pode virar um jeito
// de fazer este PC chamar endereços internos.
const PUSH_HOSTS = [/^([a-z0-9-]+\.)*push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^([a-z0-9-]+\.)*notify\.windows\.com$/];

export function validSubscription(sub) {
  try {
    const url = new URL(sub?.endpoint);
    const p256dh = Buffer.from(String(sub?.keys?.p256dh ?? ''), 'base64url');
    const auth = Buffer.from(String(sub?.keys?.auth ?? ''), 'base64url');
    return url.protocol === 'https:' && !url.port && PUSH_HOSTS.some((re) => re.test(url.hostname)) &&
      sub.endpoint.length < 1024 && p256dh.length === 65 && p256dh[0] === 4 && auth.length === 16;
  } catch { return false; }
}

export function loadVapid(file) {
  try {
    const jwk = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (jwk.d && jwk.x && jwk.y) return jwk;
  } catch { /* primeira vez: gera abaixo */ }
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(jwk), { mode: 0o600 });
  return jwk;
}

export function vapidPublicKey(jwk) {
  return b64u(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]));
}

export function vapidAuthorization(jwk, endpoint, subject, now = Date.now()) {
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const key = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${vapidPublicKey(jwk)}`;
}

// RFC 8291: um único registro aes128gcm, com a chave efêmera do servidor no cabeçalho.
export function encrypt(payload, keys, { salt = crypto.randomBytes(16), ecdh } = {}) {
  const uaPublic = Buffer.from(keys.p256dh, 'base64url');
  const authSecret = Buffer.from(keys.auth, 'base64url');
  const server = ecdh ?? crypto.createECDH('prime256v1');
  if (!ecdh) server.generateKeys();
  const asPublic = server.getPublicKey();
  const shared = server.computeSecret(uaPublic);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

// Devolve o status HTTP do serviço de push (201 = entregue; 404/410 = inscrição morta).
export async function sendPush(sub, message, { vapid, subject, fetch = globalThis.fetch, now = Date.now() }) {
  const response = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '86400', urgency: 'high',
      authorization: vapidAuthorization(vapid, sub.endpoint, subject, now)
    },
    body: encrypt(JSON.stringify(message), sub.keys),
    signal: AbortSignal.timeout(15_000),
    redirect: 'error'
  });
  await response.body?.cancel();
  return response.status;
}
