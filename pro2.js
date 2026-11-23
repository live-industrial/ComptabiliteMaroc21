'use strict';
// Module 2 : OCR factures, pièces jointes, plan CGNC de référence, états CGNC, import bancaire, amortissements
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const REF = require('./data/cgnc.js');

/* ---------- Lecture de nombres / dates d'un texte OCR ---------- */
const num = s => { const t = String(s ?? '').replace(/[^\d.,]/g, ''); if (!t) return null; const m = t.match(/[.,](\d{1,2})$/); const v = m ? t.slice(0, t.length - m[1].length - 1).replace(/[.,]/g, '') + '.' + m[1] : t.replace(/[.,]/g, ''); const n = Number(v); return Number.isFinite(n) ? n : null; };
const iso = s => { const m = String(s || '').match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/) || null; let y, mo, d; if (m) { d = +m[1]; mo = +m[2]; y = +m[3]; if (y < 100) y += 2000; } else { const k = String(s || '').match(/(\d{4})-(\d{2})-(\d{2})/); if (!k) return null; y = +k[1]; mo = +k[2]; d = +k[3]; } if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null; return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`; };
const NUM = '(\\d[\\d \\u00a0.,]*\\d|\\d)';

function parseInvoice(text) {
  const T = String(text || '').replace(/\r/g, ''), f = {}, warnings = [];
  f.ice = (T.match(/ICE\s*[:\-]?\s*(\d{15})/i) || T.match(/\b(\d{15})\b/) || [])[1] || '';
  f.if_number = (T.match(/\bI\.?F\.?\s*[:\-]?\s*(\d{6,9})\b/) || [])[1] || '';
  f.number = ((T.match(/(?:facture|invoice)\s*(?:n[°o]\.?|num[ée]ro|#)?\s*:?\s*(?=[A-Za-z0-9\-\/_.]*\d)([A-Za-z0-9][A-Za-z0-9\-\/_.]{2,24})/i) || T.match(/\bn[°o]\s*(?:de\s*)?(?:facture)?\s*:?\s*(?=[A-Za-z0-9\-\/_.]*\d)([A-Za-z0-9][A-Za-z0-9\-\/_.]{2,24})/i) || [])[1] || '').replace(/[.,;]+$/, '');
  f.date = iso((T.match(/(?:date(?:\s*de\s*(?:la\s*)?facture)?|le)\s*:?\s*(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})/i) || T.match(/(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})/) || [])[1]);
  f.due_date = iso((T.match(/[ée]ch[ée]ance[^\d\n]{0,12}(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})/i) || [])[1]);
  const first = T.split('\n').map(l => l.trim()).find(l => /[A-Za-zÀ-ÿ]{3,}/.test(l) && !/^(facture|date|ice|tel|t[ée]l|page|www|n[°o])/i.test(l));
  f.supplier_name = first ? first.split(/\s+(?:FACTURE|Facture|INVOICE|N°|Date|DATE)\b/)[0].trim().slice(0, 80) : '';
  const rateM = T.match(/T\.?V\.?A\.?[^\n\d]{0,12}(\d{1,2}(?:[.,]\d)?)\s*%/i); f.rate = rateM ? num(rateM[1]) : null;
  const rates = [...T.matchAll(/T\.?V\.?A\.?[^\n\d]{0,12}(\d{1,2}(?:[.,]\d)?)\s*%/gi)].map(m => num(m[1])); if (new Set(rates).size > 1) warnings.push('Plusieurs taux de TVA détectés : saisissez les lignes manuellement.');
  const tvaM = T.match(new RegExp('T\\.?V\\.?A\\.?[^\\n\\d]{0,12}\\d{1,2}(?:[.,]\\d)?\\s*%[^\\d\\n]{0,14}' + NUM, 'i')) || T.match(new RegExp('(?:montant\\s*)?T\\.?V\\.?A\\.?\\s*:?\\s*' + NUM, 'i'));
  f.tva = tvaM ? num(tvaM[1]) : null;
  const m1 = T.match(new RegExp('(?:total\\s*h\\.?t\\.?|montant\\s*h\\.?t\\.?|sous[- ]total(?:\\s*h\\.?t\\.?)?|total\\s*hors\\s*taxes?)[^\\d\\n]{0,25}' + NUM, 'i')); f.ht = m1 ? num(m1[1]) : null;
  const m2 = T.match(new RegExp('(?:total\\s*t\\.?t\\.?c\\.?|net\\s*[àa]\\s*payer|montant\\s*t\\.?t\\.?c\\.?|total\\s*g[ée]n[ée]ral)[^\\d\\n]{0,25}' + NUM, 'i')); f.ttc = m2 ? num(m2[1]) : null;
  const r2 = x => Math.round(x * 100) / 100;
  if (f.ht != null && f.ttc != null && f.tva == null) f.tva = r2(f.ttc - f.ht);
  if (f.ht != null && f.tva != null && f.ttc == null) f.ttc = r2(f.ht + f.tva);
  if (f.ttc != null && f.rate != null && f.ht == null) { f.ht = r2(f.ttc / (1 + f.rate / 100)); f.tva = r2(f.ttc - f.ht); }
  if (f.rate == null && f.ht > 0 && f.tva != null) { const r = (f.tva / f.ht) * 100, near = [0, 7, 10, 14, 20].find(x => Math.abs(x - r) < 0.4); if (near != null) f.rate = near; }
  if (f.ht != null && f.tva != null && f.ttc != null && Math.abs(f.ht + f.tva - f.ttc) > 0.02) warnings.push(`Incohérence : HT ${f.ht} + TVA ${f.tva} ≠ TTC ${f.ttc}. Vérifiez les montants.`);
  const missing = [['number', 'numéro'], ['date', 'date'], ['ht', 'montant HT'], ['ttc', 'montant TTC']].filter(([k]) => f[k] == null || f[k] === '').map(x => x[1]); if (missing.length) warnings.push('Non détecté : ' + missing.join(', ') + '.');
  if (f.ice && !/^\d{15}$/.test(f.ice)) warnings.push('ICE invalide (15 chiffres attendus).');
  return { fields: f, warnings };
}

const typeFor = code => { const c = String(code); if (/^1[12]/.test(c)) return 'CAPITAUX_PROPRES'; if (c[0] === '1') return 'PASSIF'; if (c[0] === '2' || c[0] === '3') return 'ACTIF'; if (c[0] === '4') return 'PASSIF'; if (c[0] === '5') return /^55/.test(c) ? 'PASSIF' : 'ACTIF'; if (c[0] === '6') return 'CHARGE'; if (c[0] === '7') return 'PRODUIT'; return null; };
const CAT = { CONSTRUCTIONS: { label: 'Constructions', asset: '2321', amort: '2831' }, INSTALLATIONS: { label: 'Matériel et outillage', asset: '2332', amort: '2832' }, TRANSPORT: { label: 'Matériel de transport', asset: '2340', amort: '2834' }, MOBILIER: { label: 'Mobilier de bureau', asset: '2351', amort: '2835' }, INFORMATIQUE: { label: 'Matériel informatique', asset: '2355', amort: '2835' } };
const DOTATION = '6193';

module.exports = function pro2(ctx) {
  const { app, db, q, one, persist, audit, company, money, fmt, Decimal, z, ROOT, tx, fail, insertEntry, acct, balances, range, DATE } = ctx;
  const D0 = () => new Decimal(0);
  const cols = t => q(`PRAGMA table_info(${t})`).map(c => c.name), addCol = (t, c, d) => { if (!cols(t).includes(c)) db.run(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); };
  db.run("CREATE TABLE IF NOT EXISTS attachments(id INTEGER PRIMARY KEY AUTOINCREMENT,company_id INTEGER NOT NULL,entity TEXT NOT NULL DEFAULT '',entity_id INTEGER,filename TEXT NOT NULL,stored TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,created_by INTEGER,created_at TEXT NOT NULL)");
  db.run('CREATE TABLE IF NOT EXISTS asset_depreciations(id INTEGER PRIMARY KEY AUTOINCREMENT,company_id INTEGER NOT NULL,asset_id INTEGER NOT NULL,year INTEGER NOT NULL,amount TEXT NOT NULL,entry_id INTEGER,UNIQUE(asset_id,year))');
  addCol('bank_statement_items', 'matched_payment_id', 'INTEGER'); addCol('fixed_assets', 'category', "TEXT DEFAULT ''"); persist();

  /* ---------- Pièces jointes ---------- */
  const sniff = b => b.slice(0, 4).toString('hex') === '89504e47' ? ['image/png', 'png'] : b.slice(0, 3).toString('hex') === 'ffd8ff' ? ['image/jpeg', 'jpg'] : b.slice(0, 4).toString() === '%PDF' ? ['application/pdf', 'pdf'] : (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') ? ['image/webp', 'webp'] : null;
  const storeFile = (c, uid, filename, data, entity = '', entityId = null) => {
    const buf = Buffer.from(String(data || '').replace(/^data:[^,]+,/, ''), 'base64');
    if (!buf.length || buf.length > 10 * 1048576) throw Error('Fichier vide ou supérieur à 10 Mo.');
    const t = sniff(buf); if (!t) throw Error('Format non pris en charge (PNG, JPG, WEBP ou PDF).');
    const dir = path.join(ROOT, 'uploads', String(c)); fs.mkdirSync(dir, { recursive: true });
    const stored = crypto.randomBytes(16).toString('hex') + '.' + t[1]; fs.writeFileSync(path.join(dir, stored), buf);
    db.run("INSERT INTO attachments(company_id,entity,entity_id,filename,stored,mime,size,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,datetime('now'))", [c, entity, entityId, String(filename || 'piece').replace(/[^\w.\-() ]/g, '_').slice(0, 120), stored, t[0], buf.length, uid]);
    const id = one('SELECT last_insert_rowid() id').id; audit(uid, c, 'UPLOAD', 'attachment', id, filename); persist(); return { id, buf, mime: t[0] };
  };
  app.post('/api/attachments', company, (req, res) => {
    try {
      const p = z.object({ entity: z.enum(['invoice', 'entry']), entityId: z.number().int().positive(), filename: z.string(), data: z.string() }).parse(req.body);
      if (!one(p.entity === 'invoice' ? 'SELECT id FROM invoices WHERE id=? AND company_id=?' : 'SELECT id FROM entries WHERE id=? AND company_id=?', [p.entityId, req.companyId])) throw Error('Pièce de rattachement introuvable.');
      res.status(201).json({ id: storeFile(req.companyId, req.user.id, p.filename, p.data, p.entity, p.entityId).id });
    } catch (e) { fail(res, e.name === 'ZodError' ? Error('Envoi invalide.') : e); }
  });
  app.get('/api/attachments/:id', company, (req, res) => {
    const a = one('SELECT * FROM attachments WHERE id=? AND company_id=?', [Number(req.params.id), req.companyId]); if (!a) return fail(res, Error('Pièce introuvable.'), 404);
    res.setHeader('Content-Type', a.mime); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Disposition', `inline; filename="${a.filename}"`); res.sendFile(path.join(ROOT, 'uploads', String(a.company_id), a.stored));
  });

  /* ---------- OCR (local, hors-ligne : Tesseract + extraction texte PDF) ---------- */
  let workerP = null, queue = Promise.resolve();
  const worker = () => workerP ||= require('tesseract.js').createWorker('fra', 1, { langPath: path.join(ROOT, 'node_modules/@tesseract.js-data/fra/4.0.0_best_int'), gzip: true, cacheMethod: 'none' }).catch(e => { workerP = null; throw e; });
  const ocr = (buf, mime) => { const job = queue.then(async () => {
    if (mime === 'application/pdf') { const r = await require('pdf-parse/lib/pdf-parse.js')(buf); if ((r.text || '').trim().length < 30) throw Error('PDF scanné sans texte lisible : exportez-le en image PNG ou JPG puis réessayez.'); return { text: r.text, confidence: 100 }; }
    if (mime === 'image/webp') throw Error('Le WEBP n\'est pas pris en charge pour l\'OCR : utilisez PNG ou JPG.');
    const w = await worker(); const { data } = await Promise.race([w.recognize(buf), new Promise((_, rej) => setTimeout(() => rej(Error('Lecture trop longue (90 s). Essayez une image plus nette ou plus petite.')), 90000))]); return { text: data.text, confidence: Math.round(data.confidence) };
  }); queue = job.catch(() => {}); return job; };
  app.post('/api/ocr/invoice', company, async (req, res) => {
    try {
      const p = z.object({ filename: z.string().default('facture'), data: z.string() }).parse(req.body); const c = req.companyId;
      const file = storeFile(c, req.user.id, p.filename, p.data); const r = await ocr(file.buf, file.mime), { fields, warnings } = parseInvoice(r.text);
      let party = fields.ice ? one("SELECT id,name FROM third_parties WHERE company_id=? AND kind='FOURNISSEUR' AND ice=?", [c, fields.ice]) : null, by = party ? 'ICE' : '';
      if (!party && fields.supplier_name) { const nz = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, ''), want = nz(fields.supplier_name); const hit = q("SELECT id,name FROM third_parties WHERE company_id=? AND kind='FOURNISSEUR'", [c]).find(t => nz(t.name) && (nz(t.name) === want || (want.length > 5 && (want.includes(nz(t.name)) || nz(t.name).includes(want))))); if (hit) { party = hit; by = 'nom'; } }
      if (party && fields.number && one("SELECT id FROM invoices WHERE company_id=? AND party_id=? AND kind='ACHAT' AND number=? AND status<>'ANNULEE'", [c, party.id, fields.number])) warnings.unshift('⚠ Cette facture semble déjà enregistrée pour ce fournisseur (même numéro).');
      if (r.confidence < 60) warnings.unshift('Qualité de lecture faible (' + r.confidence + ' %) : relisez attentivement.');
      res.json({ attachmentId: file.id, text: r.text, confidence: r.confidence, fields, warnings, party: party ? { ...party, matchedBy: by } : null });
    } catch (e) { fail(res, e.name === 'ZodError' ? Error('Envoi invalide.') : e); }
  });

  /* ---------- Plan comptable de référence & import CSV ---------- */
  app.get('/api/chart/reference', company, (req, res) => { const have = new Set(q('SELECT code FROM accounts WHERE company_id=?', [req.companyId]).map(a => a.code)); res.json(REF.map(([code, label]) => ({ code, label, type: typeFor(code), exists: have.has(code) }))); });
  app.post('/api/chart/load-reference', company, (req, res) => {
    try { const n = tx(() => { let k = 0; for (const [code, label] of REF) { const r = one('SELECT id FROM accounts WHERE company_id=? AND code=?', [req.companyId, code]); if (!r) { db.run('INSERT INTO accounts(company_id,code,label,type) VALUES(?,?,?,?)', [req.companyId, code, label, typeFor(code)]); k++; } } audit(req.user.id, req.companyId, 'LOAD', 'chart', 'reference', k + ' comptes'); return k; }); res.json({ added: n, total: REF.length }); } catch (e) { fail(res, e); }
  });
  app.post('/api/chart/import', company, (req, res) => {
    try {
      const lines = String(req.body?.csv || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean); if (!lines.length) throw Error('Fichier vide.'); if (lines.length > 5000) throw Error('Maximum 5000 comptes par import.');
      const sep = [';', '\t', ','].sort((a, b) => lines[0].split(b).length - lines[0].split(a).length)[0], TYPES = ['ACTIF', 'PASSIF', 'CAPITAUX_PROPRES', 'CHARGE', 'PRODUIT'], errors = []; let added = 0, skipped = 0;
      tx(() => lines.forEach((l, i) => { const [code, label, type] = l.split(sep).map(x => x.replace(/^"|"$/g, '').trim()); if (!/^\d{3,10}$/.test(code || '')) { if (i > 0) errors.push(`Ligne ${i + 1} : code invalide`); return; }
        const t = TYPES.includes((type || '').toUpperCase()) ? type.toUpperCase() : typeFor(code); if (!label || !t) { errors.push(`Ligne ${i + 1} : libellé ou nature manquants`); return; }
        if (one('SELECT id FROM accounts WHERE company_id=? AND code=?', [req.companyId, code])) { skipped++; return; } db.run('INSERT INTO accounts(company_id,code,label,type) VALUES(?,?,?,?)', [req.companyId, code, label, t]); added++; }));
      audit(req.user.id, req.companyId, 'IMPORT', 'chart', 'csv', `${added} ajoutés`); res.json({ added, skipped, errors: errors.slice(0, 20) });
    } catch (e) { fail(res, e); }
  });

  /* ---------- États structurés CGNC (présentation indicative) ---------- */
  const lines = (b, pre, sgn) => b.filter(o => o.code.startsWith(pre)).map(o => ({ code: o.code, label: o.label, amount: sgn > 0 ? o.c.minus(o.d) : o.d.minus(o.c) })).filter(l => !l.amount.isZero());
  const tot = ls => ls.reduce((a, l) => a.plus(l.amount), D0()), out = ls => ls.map(l => ({ ...l, amount: fmt(l.amount) }));
  app.get('/api/reports/cgnc-cpc', company, (req, res) => {
    const [f, t] = range(req), b = balances(req.companyId, f, t); const blocks = []; let cum = D0();
    const sec = (label, pre, sgn) => { const ls = lines(b, pre, sgn), s = tot(ls); blocks.push({ kind: 'section', label, total: fmt(s), lines: out(ls) }); return s; };
    const res_ = (label, v) => { blocks.push({ kind: 'result', label, total: fmt(v) }); };
    const pe = sec('Produits d\'exploitation', '71', 1), ce = sec('Charges d\'exploitation', '61', -1); const re = pe.minus(ce); res_('Résultat d\'exploitation', re);
    const pf = sec('Produits financiers', '73', 1), cf = sec('Charges financières', '63', -1); const rf = pf.minus(cf); res_('Résultat financier', rf); const rc = re.plus(rf); res_('Résultat courant', rc);
    const pn = sec('Produits non courants', '75', 1), cn = sec('Charges non courantes', '65', -1); const rn = pn.minus(cn); res_('Résultat non courant', rn); const rai = rc.plus(rn); res_('Résultat avant impôts', rai);
    const is = sec('Impôts sur les résultats', '67', -1); const net = rai.minus(is); res_('Résultat net', net);
    const known = ['71', '61', '73', '63', '75', '65', '67'], other = b.filter(o => /^[67]/.test(o.code) && !known.some(k => o.code.startsWith(k))), warnings = other.length ? [`Comptes de classe 6/7 non rattachés à une rubrique : ${other.map(o => o.code).join(', ')}.`] : [];
    res.json({ blocks, resultat: fmt(net), warnings });
  });
  const LAB = { 11: 'Capitaux propres', 14: 'Dettes de financement', 15: 'Provisions durables pour risques et charges', 21: 'Immobilisations en non-valeurs', 22: 'Immobilisations incorporelles', 23: 'Immobilisations corporelles', 24: 'Immobilisations financières', 28: 'Amortissements des immobilisations', 29: 'Provisions pour dépréciation des immobilisations', 31: 'Stocks', 34: 'Créances de l\'actif circulant', 35: 'Titres et valeurs de placement', 51: 'Trésorerie - actif', 55: 'Trésorerie - passif' };
  app.get('/api/reports/cgnc-bilan', company, (req, res) => {
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : '9999-12-31', b = balances(req.companyId, '0000-01-01', to);
    const mass = (label, test, sgn) => { const g = new Map(); for (const o of b.filter(o => test(o.code))) { const p = o.code.slice(0, 2), amt = sgn > 0 ? o.c.minus(o.d) : o.d.minus(o.c); if (amt.isZero()) continue; const x = g.get(p) || { prefix: p, label: LAB[p] || `Comptes ${p}xx`, total: D0(), accounts: [] }; x.total = x.total.plus(amt); x.accounts.push({ code: o.code, label: o.label, amount: fmt(amt) }); g.set(p, x); }
      const groups = [...g.values()].sort((a, c) => a.prefix.localeCompare(c.prefix)); return { label, total: tot(groups.map(x => ({ amount: x.total }))), groups: groups.map(x => ({ ...x, total: fmt(x.total) })) }; };
    const A = [mass('Actif immobilisé', c => c[0] === '2', -1), mass('Actif circulant', c => c[0] === '3', -1), mass('Trésorerie - actif', c => /^51/.test(c), -1)];
    const P = [mass('Financement permanent', c => c[0] === '1', 1), mass('Passif circulant', c => c[0] === '4', 1), mass('Trésorerie - passif', c => c[0] === '5' && !/^51/.test(c), 1)];
    const rs = b.filter(o => o.code[0] === '7').reduce((a, o) => a.plus(o.c.minus(o.d)), D0()).minus(b.filter(o => o.code[0] === '6').reduce((a, o) => a.plus(o.d.minus(o.c)), D0()));
    const ta = A.reduce((a, m) => a.plus(m.total), D0()), tp = P.reduce((a, m) => a.plus(m.total), D0()).plus(rs);
    res.json({ actif: A.map(m => ({ ...m, total: fmt(m.total) })), passif: P.map(m => ({ ...m, total: fmt(m.total) })), resultat: fmt(rs), totalActif: fmt(ta), totalPassif: fmt(tp), balanced: ta.eq(tp) });
  });

  /* ---------- Import de relevé bancaire + propositions de rapprochement ---------- */
  const splitCsv = (l, sep) => { const o = []; let cur = '', qt = false; for (const ch of l) { if (ch === '"') qt = !qt; else if (ch === sep && !qt) { o.push(cur); cur = ''; } else cur += ch; } o.push(cur); return o.map(x => x.trim()); };
  app.post('/api/bank-statement-items/import', company, (req, res) => {
    try {
      const label = String(req.body?.bankAccountLabel || '').trim(); if (label.length < 2) throw Error('Indiquez le compte bancaire.');
      const rows = String(req.body?.csv || '').split(/\r?\n/).filter(l => l.trim()); if (rows.length < 2) throw Error('Fichier vide.'); if (rows.length > 5000) throw Error('Maximum 5000 lignes par import.');
      const sep = [';', '\t', ','].sort((a, b) => rows[0].split(b).length - rows[0].split(a).length)[0], head = splitCsv(rows[0], sep).map(h => h.toLowerCase()), hasHead = !iso(head[0]);
      const ix = re => head.findIndex(h => re.test(h)), C = hasHead ? { date: ix(/date/), label: ix(/libell|desc|op[ée]ration|intitul|d[ée]tail/), debit: ix(/d[ée]bit|sortie|retrait/), credit: ix(/cr[ée]dit|entr[ée]e|versement/), amount: ix(/montant|amount/), ref: ix(/r[ée]f/) } : { date: 0, label: 1, debit: 2, credit: 3, amount: -1, ref: -1 };
      if (C.date < 0 || C.label < 0 || (C.amount < 0 && C.debit < 0 && C.credit < 0)) throw Error('Colonnes non reconnues : attendu Date, Libellé, Débit, Crédit (ou Montant).');
      let added = 0, skipped = 0; const errors = [];
      tx(() => rows.slice(hasHead ? 1 : 0).forEach((l, i) => { const c = splitCsv(l, sep), d = iso(c[C.date]); let amt = null, dir;
        if (C.debit >= 0 || C.credit >= 0) { const dv = C.debit >= 0 ? num(c[C.debit]) : null, cv = C.credit >= 0 ? num(c[C.credit]) : null; if (dv) { amt = dv; dir = 'DEBIT'; } else if (cv) { amt = cv; dir = 'CREDIT'; } }
        else { const raw = c[C.amount] || ''; amt = num(raw); dir = /^\s*[-(]/.test(raw) ? 'DEBIT' : 'CREDIT'; }
        const desc = (c[C.label] || '').slice(0, 200); if (!d || !amt || !desc) { errors.push(`Ligne ${i + 2} ignorée (date, libellé ou montant illisible)`); return; }
        if (one('SELECT id FROM bank_statement_items WHERE company_id=? AND bank_account_label=? AND statement_date=? AND amount=? AND description=? AND direction=?', [req.companyId, label, d, fmt(amt), desc, dir])) { skipped++; return; }
        db.run("INSERT INTO bank_statement_items(company_id,bank_account_label,statement_date,reference,description,amount,direction,created_at) VALUES(?,?,?,?,?,?,?,datetime('now'))", [req.companyId, label, d, C.ref >= 0 ? (c[C.ref] || '').slice(0, 60) : '', desc, fmt(amt), dir]); added++; }));
      audit(req.user.id, req.companyId, 'IMPORT', 'bank_statement', label, `${added} lignes`); res.json({ added, skipped, errors: errors.slice(0, 15) });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/bank-statement-items/suggestions', company, (req, res) => {
    const c = req.companyId, items = q('SELECT * FROM bank_statement_items WHERE company_id=? AND reconciled=0', [c]), used = new Set(q('SELECT matched_payment_id id FROM bank_statement_items WHERE company_id=? AND matched_payment_id IS NOT NULL', [c]).map(r => r.id));
    const pays = q('SELECT p.*,t.name party_name,i.number invoice_number FROM payments p LEFT JOIN third_parties t ON t.id=p.party_id LEFT JOIN invoices i ON i.id=p.invoice_id WHERE p.company_id=?', [c]).filter(p => !used.has(p.id));
    const invs = q("SELECT i.*,t.name party_name FROM invoices i JOIN third_parties t ON t.id=i.party_id WHERE i.company_id=? AND i.status NOT IN ('ANNULEE','BROUILLON')", [c]).map(i => ({ ...i, rem: money(i.total).minus(money(i.paid_total)) })).filter(i => i.rem.gt(0));
    const days = (a, b) => Math.abs((new Date(a) - new Date(b)) / 864e5), out = {};
    for (const it of items) { const dirP = it.direction === 'CREDIT' ? 'ENCAISSEMENT' : 'DECAISSEMENT', kinds = it.direction === 'CREDIT' ? ['VENTE', 'AVOIR_FOURNISSEUR'] : ['ACHAT', 'AVOIR_CLIENT'], amt = money(it.amount), txt = (it.description + ' ' + it.reference).toLowerCase(), cands = [];
      for (const p of pays) if (p.direction === dirP && money(p.amount).eq(amt) && days(p.payment_date, it.statement_date) <= 10) cands.push({ type: 'payment', id: p.id, score: 90 - days(p.payment_date, it.statement_date), label: `Règlement du ${p.payment_date} · ${p.party_name || '—'}${p.invoice_number ? ' · ' + p.invoice_number : ''}` });
      for (const i of invs) if (kinds.includes(i.kind)) { const mention = txt.includes(i.number.toLowerCase()); if (i.rem.eq(amt) || mention) cands.push({ type: 'invoice', id: i.id, direction: dirP, amount: it.amount, score: (i.rem.eq(amt) ? 60 : 30) + (mention ? 30 : 0), label: `Facture ${i.number} · ${i.party_name} · reste ${fmt(i.rem)}` }); }
      if (cands.length) out[it.id] = cands.sort((a, b) => b.score - a.score).slice(0, 3); }
    res.json(out);
  });
  app.post('/api/bank-statement-items/:id/match', company, (req, res) => {
    const it = one('SELECT * FROM bank_statement_items WHERE id=? AND company_id=?', [Number(req.params.id), req.companyId]), pid = Number(req.body?.paymentId);
    if (!it) return fail(res, Error('Ligne introuvable.'), 404); if (!one('SELECT id FROM payments WHERE id=? AND company_id=?', [pid, req.companyId])) return fail(res, Error('Règlement introuvable.'));
    if (one('SELECT id FROM bank_statement_items WHERE matched_payment_id=? AND company_id=?', [pid, req.companyId])) return fail(res, Error('Ce règlement est déjà pointé avec une autre ligne.'));
    db.run('UPDATE bank_statement_items SET reconciled=1,matched_payment_id=? WHERE id=?', [pid, it.id]); audit(req.user.id, req.companyId, 'RECONCILE', 'bank_statement_item', it.id, 'paiement ' + pid); persist(); res.json({ ok: true });
  });
  app.post('/api/bank-statement-items/:id/unmatch', company, (req, res) => { db.run('UPDATE bank_statement_items SET reconciled=0,matched_payment_id=NULL WHERE id=? AND company_id=?', [Number(req.params.id), req.companyId]); persist(); res.json({ ok: true }); });

  /* ---------- Immobilisations & dotations aux amortissements ---------- */
  const schedule = a => { const base = money(a.acquisition_cost).minus(money(a.residual_value)), life = Number(a.useful_life_years), annual = base.div(life), y0 = Number(a.commissioning_date.slice(0, 4)), m0 = Number(a.commissioning_date.slice(5, 7)), plan = []; let acc = D0();
    for (let k = 0; acc.lt(base) && k <= life + 1; k++) { let v = k === 0 ? annual.times(13 - m0).div(12) : annual; v = Decimal.min(v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP), base.minus(acc)); if (v.lte(0)) break; acc = acc.plus(v); plan.push({ year: y0 + k, amount: v }); }
    if (acc.lt(base) && plan.length) plan[plan.length - 1].amount = plan[plan.length - 1].amount.plus(base.minus(acc)); return plan; };
  app.get('/api/fixed-assets', company, (req, res) => {
    const posted = q('SELECT * FROM asset_depreciations WHERE company_id=?', [req.companyId]);
    res.json(q('SELECT * FROM fixed_assets WHERE company_id=? ORDER BY commissioning_date DESC,id DESC', [req.companyId]).map(a => { const pl = schedule(a), done = posted.filter(p => p.asset_id === a.id), cum = done.reduce((s, p) => s.plus(money(p.amount)), D0()), c = CAT[a.category];
      return { ...a, category_label: c?.label || '—', asset_account: c?.asset || '', amort_account: c?.amort || '', annual_depreciation: fmt(money(a.acquisition_cost).minus(money(a.residual_value)).div(a.useful_life_years)), accumulated_depreciation: fmt(cum), net_value: fmt(money(a.acquisition_cost).minus(cum)), schedule: pl.map(p => ({ year: p.year, amount: fmt(p.amount), posted: done.some(d => d.year === p.year) })) }; }));
  });
  app.post('/api/fixed-assets', company, (req, res) => {
    const p = z.object({ assetName: z.string().min(2), assetCode: z.string().optional(), category: z.enum(Object.keys(CAT)), acquisitionDate: DATE, commissioningDate: DATE, cost: z.string(), usefulLifeYears: z.number().int().positive().max(100), residualValue: z.string().default('0'), notes: z.string().optional() }).safeParse(req.body);
    if (!p.success || money(p.data.cost).lte(0) || money(p.data.residualValue).lt(0) || money(p.data.residualValue).gte(money(p.data.cost))) return fail(res, Error('Fiche immobilisation invalide (catégorie, coût, valeur résiduelle < coût).'));
    const d = p.data; db.run("INSERT INTO fixed_assets(company_id,asset_name,asset_code,acquisition_date,commissioning_date,acquisition_cost,useful_life_years,residual_value,depreciation_method,notes,created_at,category) VALUES(?,?,?,?,?,?,?,?,'LINEAIRE',?,datetime('now'),?)", [req.companyId, d.assetName, d.assetCode || '', d.acquisitionDate, d.commissioningDate, fmt(d.cost), d.usefulLifeYears, fmt(d.residualValue), d.notes || '', d.category]);
    const id = one('SELECT last_insert_rowid() id').id; audit(req.user.id, req.companyId, 'CREATE', 'fixed_asset', id, d.assetName); persist(); res.status(201).json({ ok: true, id });
  });
  app.get('/api/fixed-assets/categories', company, (req, res) => res.json({ categories: CAT, dotation: DOTATION }));
  app.post('/api/fixed-assets/depreciate', company, (req, res) => {
    try {
      const year = Number(req.body?.year); if (!Number.isInteger(year) || year < 2000 || year > 2100) throw Error('Année invalide.');
      const r = tx(() => { const c = req.companyId, jr = one("SELECT id FROM journals WHERE company_id=? AND type='OD' ORDER BY id LIMIT 1", [c]); if (!jr) throw Error('Aucun journal d\'opérations diverses (OD).'); let n = 0, total = D0();
        for (const a of q("SELECT * FROM fixed_assets WHERE company_id=? AND status='ACTIF'", [c])) { const cat = CAT[a.category], p = schedule(a).find(x => x.year === year); if (!p || !cat || one('SELECT id FROM asset_depreciations WHERE asset_id=? AND year=?', [a.id, year])) continue;
          const e = insertEntry(c, req.user.id, { journalId: jr.id, date: `${year}-12-31`, reference: `AMORT-${year}`, description: `Dotation aux amortissements ${year} · ${a.asset_name}`, source: 'AMORTISSEMENT', sourceId: a.id, lines: [{ accountId: acct(c, DOTATION), label: a.asset_name, debit: fmt(p.amount), credit: '0' }, { accountId: acct(c, cat.amort), label: a.asset_name, debit: '0', credit: fmt(p.amount) }] });
          db.run('INSERT INTO asset_depreciations(company_id,asset_id,year,amount,entry_id) VALUES(?,?,?,?,?)', [c, a.id, year, fmt(p.amount), e.id]); n++; total = total.plus(p.amount); }
        if (!n) throw Error(`Aucune dotation à comptabiliser pour ${year} (déjà passée, ou aucun actif concerné).`); audit(req.user.id, c, 'DEPRECIATE', 'fixed_assets', year, `${n} actifs · ${fmt(total)}`); return { year, assets: n, total: fmt(total) }; });
      res.status(201).json(r);
    } catch (e) { fail(res, e); }
  });
};
module.exports.parseInvoice = parseInvoice;
module.exports.typeFor = typeFor;
