'use strict';
// Double authentification (TOTP) : activation, connexion en 2 étapes, codes de secours, réinitialisation par l'admin
const T = require('./totp.js'), QR = require('qrcode');
module.exports = function twofa(ctx) {
  const { app, db, one, persist, audit, adminOnly, z, bcrypt, jwt, secret, limiter, tries } = ctx;
  const ISSUER = 'Comptabilité Maroc PRO', KEY = process.env.TOTP_KEY || secret, fails = new Map();
  for (const [c, d] of [['totp_secret', "TEXT DEFAULT ''"], ['totp_enabled', 'INTEGER DEFAULT 0'], ['totp_last_step', 'INTEGER DEFAULT 0'], ['recovery_codes', "TEXT DEFAULT '[]'"]]) if (!db.exec('PRAGMA table_info(users)')[0].values.some(r => r[1] === c)) db.run(`ALTER TABLE users ADD COLUMN ${c} ${d}`);
  persist();
  const err = (res, m, s = 400) => res.status(s).json({ error: m });
  const left = u => { try { return JSON.parse(u.recovery_codes || '[]').length; } catch { return 0; } };
  const session = u => ({ token: jwt.sign({ id: u.id, name: u.name, role: u.role }, secret, { expiresIn: '8h' }), user: { id: u.id, name: u.name, email: u.email, role: u.role } });
  // Vérifie un code TOTP (6 chiffres) ou un code de secours (usage unique). Retourne 'totp' | 'recovery' | null.
  function check(u, input) {
    const raw = String(input || '').trim(); if (!raw) return null;
    if (/^\d{6}$/.test(raw.replace(/\s/g, ''))) { let key; try { key = T.dec(u.totp_secret, KEY); } catch { return null; } const st = T.verify(key, raw, u.totp_last_step || 0); if (st) { db.run('UPDATE users SET totp_last_step=? WHERE id=?', [st, u.id]); return 'totp'; } return null; }
    const h = T.sha(raw.toUpperCase().replace(/[^A-Z0-9]/g, '')); let list = []; try { list = JSON.parse(u.recovery_codes || '[]'); } catch {}
    const i = list.indexOf(h); if (i < 0) return null; list.splice(i, 1); db.run('UPDATE users SET recovery_codes=? WHERE id=?', [JSON.stringify(list), u.id]); return 'recovery';
  }
  const lockedOut = id => { const f = fails.get(id); return f && f.until && f.until > Date.now(); };
  const fail = (u, how) => { const f = fails.get(u.id) || { n: 0 }; f.n++; if (f.n >= 5) { f.until = Date.now() + 15 * 60e3; f.n = 0; } fails.set(u.id, f); audit(u.id, null, 'LOGIN_2FA_FAIL', 'user', u.id, how); persist(); };

  // Étape 2 de la connexion
  app.post('/api/auth/2fa', limiter, (req, res) => {
    let p; try { p = jwt.verify(String(req.body?.challenge || ''), secret + ':2fa'); } catch { return err(res, 'Vérification expirée : reconnectez-vous.', 401); }
    const u = one('SELECT * FROM users WHERE id=?', [p.uid]); if (!u || !u.totp_enabled) return err(res, 'Vérification impossible.', 401);
    if (lockedOut(u.id)) return err(res, 'Trop d\'essais. Réessayez dans 15 minutes.', 429);
    const how = check(u, req.body?.code); if (!how) { fail(u, 'code incorrect'); return err(res, 'Code incorrect ou expiré.', 401); }
    fails.delete(u.id); tries.delete(req.limiterKey); audit(u.id, null, 'LOGIN_2FA', 'user', u.id, how); persist();
    res.json({ ...session(u), recoveryLeft: left(one('SELECT recovery_codes FROM users WHERE id=?', [u.id])), usedRecovery: how === 'recovery' });
  });

  // Gestion par l'utilisateur connecté
  app.get('/api/me/2fa', (req, res) => { const u = one('SELECT * FROM users WHERE id=?', [req.user.id]); res.json({ enabled: !!u?.totp_enabled, recoveryLeft: u ? left(u) : 0 }); });
  app.post('/api/me/2fa/setup', async (req, res) => {
    const u = one('SELECT * FROM users WHERE id=?', [req.user.id]); if (!u) return err(res, 'Utilisateur introuvable.', 404); if (u.totp_enabled) return err(res, 'La double authentification est déjà activée.');
    const s = T.newSecret(); db.run('UPDATE users SET totp_secret=?,totp_enabled=0,totp_last_step=0 WHERE id=?', [T.enc(s, KEY), u.id]); persist();
    const uri = `otpauth://totp/${encodeURIComponent(ISSUER)}:${encodeURIComponent(u.email)}?secret=${s}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=6&period=30`;
    res.json({ secret: s.match(/.{1,4}/g).join(' '), uri, qr: await QR.toDataURL(uri, { margin: 1, width: 240 }) });
  });
  app.post('/api/me/2fa/enable', (req, res) => {
    const u = one('SELECT * FROM users WHERE id=?', [req.user.id]); if (!u?.totp_secret || u.totp_enabled) return err(res, 'Lancez d\'abord la configuration.');
    let key; try { key = T.dec(u.totp_secret, KEY); } catch { return err(res, 'Configuration invalide, recommencez.'); }
    const st = T.verify(key, req.body?.code, 0); if (!st) return err(res, 'Code incorrect. Vérifiez l\'heure de votre téléphone et réessayez.');
    const raw = T.recoveryCodes(10); db.run('UPDATE users SET totp_enabled=1,totp_last_step=?,recovery_codes=? WHERE id=?', [st, JSON.stringify(raw.map(T.sha)), u.id]);
    audit(u.id, null, 'ENABLE_2FA', 'user', u.id, ''); persist(); res.json({ ok: true, recoveryCodes: raw.map(T.fmtRecovery) });
  });
  app.post('/api/me/2fa/disable', (req, res) => {
    const u = one('SELECT * FROM users WHERE id=?', [req.user.id]); if (!u?.totp_enabled) return err(res, 'La double authentification n\'est pas activée.');
    if (!bcrypt.compareSync(String(req.body?.password || ''), u.password_hash)) return err(res, 'Mot de passe incorrect.', 401);
    if (lockedOut(u.id)) return err(res, 'Trop d\'essais. Réessayez dans 15 minutes.', 429); if (!check(u, req.body?.code)) { fail(u, 'désactivation'); return err(res, 'Code incorrect ou expiré.', 401); }
    db.run("UPDATE users SET totp_secret='',totp_enabled=0,totp_last_step=0,recovery_codes='[]' WHERE id=?", [u.id]); fails.delete(u.id); audit(u.id, null, 'DISABLE_2FA', 'user', u.id, ''); persist(); res.json({ ok: true });
  });
  // Réinitialisation par un administrateur (téléphone perdu)
  app.post('/api/users/:id/2fa/reset', adminOnly, (req, res) => {
    const id = Number(req.params.id); if (!one('SELECT id FROM users WHERE id=?', [id])) return err(res, 'Utilisateur introuvable.', 404);
    db.run("UPDATE users SET totp_secret='',totp_enabled=0,totp_last_step=0,recovery_codes='[]' WHERE id=?", [id]); audit(req.user.id, null, 'RESET_2FA', 'user', id, ''); persist(); res.json({ ok: true });
  });
};
