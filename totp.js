'use strict';
// TOTP (RFC 6238) — compatible Google Authenticator / Microsoft Authenticator / Authy. Aucune dépendance externe.
const crypto = require('crypto'), A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32enc = buf => { let bits = 0, v = 0, o = ''; for (const b of buf) { v = (v << 8) | b; bits += 8; while (bits >= 5) { o += A[(v >>> (bits - 5)) & 31]; bits -= 5; } v &= (1 << bits) - 1; } if (bits > 0) o += A[(v << (5 - bits)) & 31]; return o; };
const b32dec = s => { let bits = 0, v = 0; const o = []; for (const c of String(s).replace(/[=\s]/g, '').toUpperCase()) { const i = A.indexOf(c); if (i < 0) throw Error('base32 invalide'); v = (v << 5) | i; bits += 5; if (bits >= 8) { o.push((v >>> (bits - 8)) & 255); bits -= 8; } v &= (1 << bits) - 1; } return Buffer.from(o); };
const hotp = (key, counter) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(counter)); const h = crypto.createHmac('sha1', key).update(b).digest(), o = h[19] & 15; return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, '0'); };
const stepOf = (t = Date.now()) => Math.floor(t / 30000);
const code = (secret, t) => hotp(b32dec(secret), stepOf(t));
// Retourne le pas de temps validé (pour interdire le rejeu) ou null. Tolérance ±30 s.
const verify = (secret, input, lastStep = 0, t = Date.now()) => { const c = String(input || '').replace(/\s/g, ''); if (!/^\d{6}$/.test(c)) return null; const key = b32dec(secret), s = stepOf(t);
  for (const d of [0, -1, 1]) { const st = s + d; if (st <= lastStep) continue; if (crypto.timingSafeEqual(Buffer.from(hotp(key, st)), Buffer.from(c))) return st; } return null; };
const newSecret = () => b32enc(crypto.randomBytes(20));
const kdf = m => crypto.createHash('sha256').update('cm-totp:' + m).digest();
const enc = (text, material) => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', kdf(material), iv), ct = Buffer.concat([c.update(text, 'utf8'), c.final()]); return ['v1', iv.toString('hex'), c.getAuthTag().toString('hex'), ct.toString('hex')].join('.'); };
const dec = (blob, material) => { const [v, iv, tag, ct] = String(blob).split('.'); if (v !== 'v1') throw Error('format'); const d = crypto.createDecipheriv('aes-256-gcm', kdf(material), Buffer.from(iv, 'hex')); d.setAuthTag(Buffer.from(tag, 'hex')); return Buffer.concat([d.update(Buffer.from(ct, 'hex')), d.final()]).toString('utf8'); };
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const recoveryCodes = (n = 10) => Array.from({ length: n }, () => crypto.randomBytes(6).toString('hex').toUpperCase());
const fmtRecovery = r => `${r.slice(0, 6)}-${r.slice(6)}`;
module.exports = { b32enc, b32dec, hotp, code, verify, newSecret, enc, dec, sha, recoveryCodes, fmtRecovery };
