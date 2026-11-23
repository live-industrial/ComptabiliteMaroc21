'use strict';
// Comptabilité Maroc PRO — module métier (moteur comptable, rapports, utilisateurs, sauvegardes)
const fs = require('fs'), path = require('path');

module.exports = function pro(ctx) {
  const { app, db, q, one, persist, audit, company, adminOnly, money, fmt, Decimal, z, bcrypt, ROOT, DB_FILE } = ctx;
  const D0 = () => new Decimal(0);
  const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

  // ---------- Migrations légères ----------
  const cols = t => q(`PRAGMA table_info(${t})`).map(c => c.name);
  const addCol = (t, c, def) => { if (!cols(t).includes(c)) db.run(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
  addCol('entries', 'entry_no', "TEXT DEFAULT ''");
  addCol('entries', 'reversal_of', 'INTEGER');
  addCol('entries', 'source', "TEXT DEFAULT 'MANUEL'");
  addCol('entries', 'source_id', 'INTEGER');
  addCol('invoices', 'entry_id', 'INTEGER');
  addCol('payments', 'entry_id', 'INTEGER');
  db.run('CREATE TABLE IF NOT EXISTS company_settings(company_id INTEGER NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(company_id,key))');
  db.run('CREATE INDEX IF NOT EXISTS idx_lines_entry ON entry_lines(entry_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_lines_account ON entry_lines(account_id)');
  persist();

  // ---------- Paramétrage comptable (modifiable par dossier) ----------
  const DEF = { client: '3421', supplier: '4411', vat_collected: '4455', vat_deductible: '3455', sales: '7111', purchases: '6111', bank: '5141', cash: '5161', journal_sales: 'VEN', journal_purchases: 'ACH', journal_bank: 'BQ', journal_cash: 'CA' };
  const mappings = c => { const o = { ...DEF }; for (const r of q('SELECT key,value FROM company_settings WHERE company_id=?', [c])) if (r.key in DEF) o[r.key] = r.value; return o; };
  const acct = (c, code) => { const a = one('SELECT id FROM accounts WHERE company_id=? AND code=?', [c, code]); if (!a) throw Error(`Compte ${code} introuvable : vérifiez le paramétrage comptable du dossier.`); return a.id; };
  const jrn = (c, code) => { const j = one('SELECT id FROM journals WHERE company_id=? AND code=?', [c, code]); if (!j) throw Error(`Journal ${code} introuvable : vérifiez le paramétrage comptable du dossier.`); return j.id; };

  const tx = fn => { db.run('BEGIN IMMEDIATE'); try { const r = fn(); db.run('COMMIT'); persist(); return r; } catch (e) { try { db.run('ROLLBACK'); } catch {} throw e; } };
  const fail = (res, e, code = 400) => res.status(code).json({ error: e.message || String(e) });

  // ---------- Exercices ----------
  const openYear = (c, date) => {
    const y = one('SELECT * FROM fiscal_years WHERE company_id=? AND start_date<=? AND end_date>=?', [c, date, date]);
    if (!y) throw Error(`Aucun exercice comptable ne couvre la date ${date}. Créez l'exercice dans « Exercices ».`);
    if (y.status !== 'OPEN') throw Error(`L'exercice ${y.label} est clôturé : aucune écriture n'est possible à cette date.`);
    return y;
  };

  // ---------- Moteur d'écritures (partie double, numérotation continue) ----------
  function insertEntry(c, userId, e) {
    const lines = e.lines.map(l => ({ accountId: l.accountId, label: l.label || '', d: money(l.debit), c: money(l.credit) }));
    if (lines.length < 2) throw Error('Une écriture comporte au moins deux lignes.');
    if (lines.some(l => l.d.lt(0) || l.c.lt(0) || (l.d.gt(0) && l.c.gt(0)) || (l.d.isZero() && l.c.isZero()))) throw Error('Chaque ligne doit porter un débit OU un crédit strictement positif.');
    const td = lines.reduce((a, l) => a.plus(l.d), D0()), tc = lines.reduce((a, l) => a.plus(l.c), D0());
    if (!td.eq(tc) || td.isZero()) throw Error(`Écriture déséquilibrée : débit ${fmt(td)} ≠ crédit ${fmt(tc)}.`);
    const j = one('SELECT * FROM journals WHERE id=? AND company_id=?', [e.journalId, c]);
    if (!j) throw Error('Journal introuvable dans ce dossier.');
    for (const l of lines) if (!one('SELECT id FROM accounts WHERE id=? AND company_id=? AND active=1', [l.accountId, c])) throw Error('Compte introuvable ou inactif dans ce dossier.');
    const y = openYear(c, e.date);
    const seq = one('SELECT COUNT(*) n FROM entries WHERE company_id=? AND journal_id=? AND entry_date>=? AND entry_date<=?', [c, j.id, y.start_date, y.end_date]).n + 1;
    const no = `${j.code}/${y.label}/${String(seq).padStart(5, '0')}`;
    db.run("INSERT INTO entries(company_id,journal_id,entry_date,reference,description,status,total_debit,total_credit,created_by,created_at,validated_at,entry_no,reversal_of,source,source_id) VALUES(?,?,?,?,?,'VALIDEE',?,?,?,datetime('now'),datetime('now'),?,?,?,?)",
      [c, j.id, e.date, e.reference || '', e.description, fmt(td), fmt(tc), userId, no, e.reversalOf || null, e.source || 'MANUEL', e.sourceId || null]);
    const id = one('SELECT last_insert_rowid() id').id;
    for (const l of lines) db.run('INSERT INTO entry_lines(entry_id,account_id,label,debit,credit) VALUES(?,?,?,?,?)', [id, l.accountId, l.label, fmt(l.d), fmt(l.c)]);
    audit(userId, c, 'POST', 'entry', id, `${no} · ${e.description}`);
    return { id, entry_no: no, debit: fmt(td), credit: fmt(tc) };
  }
  const reverseEntry = (c, userId, id, date, reason) => {
    const o = one('SELECT * FROM entries WHERE id=? AND company_id=?', [id, c]);
    if (!o) throw Error('Écriture introuvable.');
    if (one('SELECT id FROM entries WHERE reversal_of=?', [id])) throw Error('Cette écriture a déjà été contre-passée.');
    if (o.reversal_of) throw Error('Une contre-passation ne peut pas être contre-passée : saisissez une nouvelle écriture.');
    const ls = q('SELECT * FROM entry_lines WHERE entry_id=?', [id]);
    const r = insertEntry(c, userId, { journalId: o.journal_id, date: date || o.entry_date, reference: o.reference, description: `Contre-passation ${o.entry_no || '#' + o.id}${reason ? ' — ' + reason : ''}`, reversalOf: id, source: 'CONTREPASSATION', sourceId: id,
      lines: ls.map(l => ({ accountId: l.account_id, label: l.label, debit: l.credit, credit: l.debit })) });
    return r;
  };

  // ---------- Écritures ----------
  app.post('/api/entries', company, (req, res) => {
    const p = z.object({ journalId: z.number().int().positive(), date: DATE, reference: z.string().optional(), description: z.string().min(2),
      lines: z.array(z.object({ accountId: z.number().int().positive(), label: z.string().optional(), debit: z.string().default('0'), credit: z.string().default('0') })).min(2) }).safeParse(req.body);
    if (!p.success) return fail(res, Error('Écriture invalide.'));
    try { res.status(201).json({ ...tx(() => insertEntry(req.companyId, req.user.id, p.data)), status: 'VALIDEE' }); } catch (e) { fail(res, e); }
  });
  app.get('/api/entries', company, (req, res) => {
    const w = ['e.company_id=?'], a = [req.companyId];
    if (req.query.from) { w.push('e.entry_date>=?'); a.push(String(req.query.from)); }
    if (req.query.to) { w.push('e.entry_date<=?'); a.push(String(req.query.to)); }
    if (req.query.journalId) { w.push('e.journal_id=?'); a.push(Number(req.query.journalId)); }
    res.json(q(`SELECT e.*,j.code journal_code,j.label journal_label,(SELECT COUNT(*) FROM entries r WHERE r.reversal_of=e.id) reversed FROM entries e JOIN journals j ON j.id=e.journal_id WHERE ${w.join(' AND ')} ORDER BY e.entry_date DESC,e.id DESC LIMIT 1000`, a));
  });
  app.get('/api/entries/:id', company, (req, res) => {
    const e = one('SELECT e.*,j.code journal_code,j.label journal_label FROM entries e JOIN journals j ON j.id=e.journal_id WHERE e.id=? AND e.company_id=?', [Number(req.params.id), req.companyId]);
    if (!e) return fail(res, Error('Écriture introuvable.'), 404);
    e.lines = q('SELECT l.*,a.code account_code,a.label account_label FROM entry_lines l JOIN accounts a ON a.id=l.account_id WHERE l.entry_id=? ORDER BY l.id', [e.id]);
    e.reversed_by = one('SELECT id,entry_no FROM entries WHERE reversal_of=?', [e.id]);
    e.attachments = q("SELECT id,filename,mime,size FROM attachments WHERE company_id=? AND entity='entry' AND entity_id=?", [req.companyId, e.id]);
    res.json(e);
  });
  app.post('/api/entries/:id/reverse', company, (req, res) => {
    try { res.status(201).json(tx(() => reverseEntry(req.companyId, req.user.id, Number(req.params.id), req.body?.date, String(req.body?.reason || '').slice(0, 120)))); } catch (e) { fail(res, e); }
  });

  // ---------- Factures (avec comptabilisation automatique) ----------
  const remaining = i => Decimal.max(D0(), money(i.total).minus(money(i.paid_total)));
  const nextNumber = (c, kind, date) => {
    const pre = { VENTE: 'FA', AVOIR_CLIENT: 'AV', ACHAT: 'AC', AVOIR_FOURNISSEUR: 'AF' }[kind], yr = (date || new Date().toISOString()).slice(0, 4);
    const n = one('SELECT COUNT(*) n FROM invoices WHERE company_id=? AND kind=? AND number LIKE ?', [c, kind, `${pre}-${yr}-%`]).n + 1;
    let num; let k = n; do { num = `${pre}-${yr}-${String(k++).padStart(4, '0')}`; } while (one('SELECT id FROM invoices WHERE company_id=? AND kind=? AND number=?', [c, kind, num]));
    return num;
  };
  app.get('/api/invoices/next-number', company, (req, res) => res.json({ number: nextNumber(req.companyId, String(req.query.kind || 'VENTE'), String(req.query.date || '')) }));
  app.get('/api/invoices', company, (req, res) => {
    const rows = q('SELECT i.*,t.name party_name FROM invoices i JOIN third_parties t ON t.id=i.party_id WHERE i.company_id=? ORDER BY i.invoice_date DESC,i.id DESC', [req.companyId]);
    res.json(rows.map(i => ({ ...i, remaining: fmt(i.status === 'ANNULEE' ? 0 : remaining(i)) })));
  });
  app.get('/api/invoices/:id', company, (req, res) => {
    const i = one('SELECT i.*,t.name party_name,t.ice party_ice,t.if_number party_if,t.address party_address FROM invoices i JOIN third_parties t ON t.id=i.party_id WHERE i.id=? AND i.company_id=?', [Number(req.params.id), req.companyId]);
    if (!i) return fail(res, Error('Facture introuvable.'), 404);
    i.lines = q('SELECT * FROM invoice_lines WHERE invoice_id=? ORDER BY id', [i.id]);
    i.company = one('SELECT * FROM companies WHERE id=?', [req.companyId]);
    i.payments = q('SELECT * FROM payments WHERE invoice_id=? ORDER BY payment_date', [i.id]);
    i.remaining = fmt(i.status === 'ANNULEE' ? 0 : remaining(i));
    i.attachments = q("SELECT id,filename,mime,size FROM attachments WHERE company_id=? AND entity='invoice' AND entity_id=?", [req.companyId, i.id]);
    res.json(i);
  });
  const invoiceEntry = (c, inv, partyName, m) => {
    const sales = ['VENTE', 'AVOIR_CLIENT'].includes(inv.kind), credit = inv.kind.startsWith('AVOIR');
    const third = acct(c, sales ? m.client : m.supplier), base = acct(c, sales ? m.sales : m.purchases), vat = acct(c, sales ? m.vat_collected : m.vat_deductible);
    const ht = money(inv.subtotal), tva = money(inv.tax_total), ttc = money(inv.total), L = [];
    // Vente: D client / C ventes + TVA. Achat: D achats + TVA / C fournisseur. Avoirs: sens inverse.
    const thirdDebit = sales !== credit;
    L.push(thirdDebit ? { accountId: third, label: partyName, debit: fmt(ttc), credit: '0' } : { accountId: third, label: partyName, debit: '0', credit: fmt(ttc) });
    L.push(thirdDebit ? { accountId: base, label: inv.number, debit: '0', credit: fmt(ht) } : { accountId: base, label: inv.number, debit: fmt(ht), credit: '0' });
    if (tva.gt(0)) L.push(thirdDebit ? { accountId: vat, label: 'TVA ' + inv.number, debit: '0', credit: fmt(tva) } : { accountId: vat, label: 'TVA ' + inv.number, debit: fmt(tva), credit: '0' });
    return { journalId: jrn(c, sales ? m.journal_sales : m.journal_purchases), date: inv.invoice_date, reference: inv.number, description: `${inv.kind.replace('_', ' ')} ${inv.number} · ${partyName}`, source: 'FACTURE', sourceId: inv.id, lines: L };
  };
  app.post('/api/invoices', company, (req, res) => {
    const p = z.object({ partyId: z.number().int().positive(), kind: z.enum(['VENTE', 'ACHAT', 'AVOIR_CLIENT', 'AVOIR_FOURNISSEUR']), number: z.string().optional(), date: DATE, dueDate: DATE.optional(), notes: z.string().optional(), attachmentId: z.number().int().positive().optional(),
      lines: z.array(z.object({ description: z.string().min(1), quantity: z.string(), unitPrice: z.string(), taxRate: z.string().default('20') })).min(1) }).safeParse(req.body);
    if (!p.success) return fail(res, Error('Vérifiez les champs et les lignes de la facture.'));
    const t = one('SELECT * FROM third_parties WHERE id=? AND company_id=?', [p.data.partyId, req.companyId]);
    if (!t) return fail(res, Error('Tiers introuvable dans ce dossier.'));
    if (['VENTE', 'AVOIR_CLIENT'].includes(p.data.kind) && t.kind !== 'CLIENT') return fail(res, Error('Une facture de vente doit être adressée à un client.'));
    if (['ACHAT', 'AVOIR_FOURNISSEUR'].includes(p.data.kind) && t.kind !== 'FOURNISSEUR') return fail(res, Error('Une facture d\'achat doit provenir d\'un fournisseur.'));
    try {
      const out = tx(() => {
        let sub = D0(), tax = D0(); const ls = [];
        for (const l of p.data.lines) {
          const qv = money(l.quantity), pr = money(l.unitPrice), rt = money(l.taxRate);
          if (qv.lte(0) || pr.lt(0) || rt.lt(0) || rt.gt(100)) throw Error('Quantité, prix ou taux de TVA invalide.');
          const base = qv.times(pr).toDecimalPlaces(2, Decimal.ROUND_HALF_UP), tv = base.times(rt).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
          sub = sub.plus(base); tax = tax.plus(tv); ls.push([l.description, qv.toString(), fmt(pr), rt.toString(), fmt(tv), fmt(base.plus(tv))]);
        }
        const total = sub.plus(tax), number = (p.data.number || '').trim() || nextNumber(req.companyId, p.data.kind, p.data.date);
        const due = p.data.dueDate || new Date(new Date(p.data.date).getTime() + t.payment_terms * 864e5).toISOString().slice(0, 10);
        if (due < p.data.date) throw Error('L\'échéance ne peut pas précéder la date de facture.');
        db.run("INSERT INTO invoices(company_id,party_id,kind,number,invoice_date,due_date,status,subtotal,tax_total,total,paid_total,notes,created_at) VALUES(?,?,?,?,?,?,'VALIDEE',?,?,?,'0.00',?,datetime('now'))", [req.companyId, p.data.partyId, p.data.kind, number, p.data.date, due, fmt(sub), fmt(tax), fmt(total), p.data.notes || '']);
        const id = one('SELECT last_insert_rowid() id').id;
        for (const l of ls) db.run('INSERT INTO invoice_lines(invoice_id,description,quantity,unit_price,tax_rate,tax_amount,line_total) VALUES(?,?,?,?,?,?,?)', [id, ...l]);
        const inv = one('SELECT * FROM invoices WHERE id=?', [id]);
        const e = insertEntry(req.companyId, req.user.id, invoiceEntry(req.companyId, inv, t.name, mappings(req.companyId)));
        db.run('UPDATE invoices SET entry_id=? WHERE id=?', [e.id, id]);
        if (p.data.attachmentId) db.run("UPDATE attachments SET entity='invoice',entity_id=? WHERE id=? AND company_id=? AND entity=''", [id, p.data.attachmentId, req.companyId]);
        audit(req.user.id, req.companyId, 'CREATE', 'invoice', id, number);
        return { ...one('SELECT * FROM invoices WHERE id=?', [id]), entry_no: e.entry_no };
      });
      res.status(201).json(out);
    } catch (e) { fail(res, /UNIQUE/.test(e.message) ? Error('Ce numéro de facture existe déjà.') : e); }
  });
  app.post('/api/invoices/:id/cancel', company, (req, res) => {
    try {
      tx(() => {
        const i = one('SELECT * FROM invoices WHERE id=? AND company_id=?', [Number(req.params.id), req.companyId]);
        if (!i) throw Error('Facture introuvable.');
        if (i.status === 'ANNULEE') throw Error('Facture déjà annulée.');
        if (money(i.paid_total).gt(0)) throw Error('Impossible d\'annuler une facture déjà réglée (même partiellement) : émettez un avoir.');
        if (i.entry_id) reverseEntry(req.companyId, req.user.id, i.entry_id, undefined, 'annulation ' + i.number);
        db.run("UPDATE invoices SET status='ANNULEE' WHERE id=?", [i.id]);
        audit(req.user.id, req.companyId, 'CANCEL', 'invoice', i.id, i.number);
      });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ---------- Règlements (écriture + mouvement de trésorerie automatiques) ----------
  app.post('/api/payments', company, (req, res) => {
    const p = z.object({ invoiceId: z.number().int().positive().optional(), partyId: z.number().int().positive().optional(), date: DATE, direction: z.enum(['ENCAISSEMENT', 'DECAISSEMENT']), method: z.enum(['ESPECES', 'VIREMENT', 'CHEQUE', 'CARTE', 'AUTRE']), reference: z.string().optional(), amount: z.string(), accountLabel: z.string().optional(), notes: z.string().optional() }).safeParse(req.body);
    if (!p.success) return fail(res, Error('Règlement invalide.'));
    try {
      const out = tx(() => {
        const amount = money(p.data.amount); if (amount.lte(0)) throw Error('Le montant doit être positif.');
        const c = req.companyId, m = mappings(c); let inv = null, party = null, counter;
        if (p.data.invoiceId) {
          inv = one('SELECT * FROM invoices WHERE id=? AND company_id=?', [p.data.invoiceId, c]);
          if (!inv) throw Error('Facture introuvable.');
          if (inv.status === 'ANNULEE') throw Error('Cette facture est annulée.');
          const expected = { VENTE: 'ENCAISSEMENT', AVOIR_FOURNISSEUR: 'ENCAISSEMENT', ACHAT: 'DECAISSEMENT', AVOIR_CLIENT: 'DECAISSEMENT' }[inv.kind];
          if (p.data.direction !== expected) throw Error(`Sens incorrect : cette facture se règle par ${expected === 'ENCAISSEMENT' ? 'un encaissement' : 'un décaissement'}.`);
          if (amount.gt(remaining(inv))) throw Error(`Le règlement dépasse le reste à payer (${fmt(remaining(inv))}).`);
          party = one('SELECT * FROM third_parties WHERE id=?', [inv.party_id]);
        } else if (p.data.partyId) {
          party = one('SELECT * FROM third_parties WHERE id=? AND company_id=?', [p.data.partyId, c]);
          if (!party) throw Error('Tiers introuvable.');
        } else throw Error('Choisissez une facture ou un tiers pour comptabiliser le règlement.');
        counter = acct(c, party.kind === 'CLIENT' ? m.client : m.supplier);
        const cashLike = p.data.method === 'ESPECES';
        const treas = acct(c, cashLike ? m.cash : m.bank), journalId = jrn(c, cashLike ? m.journal_cash : m.journal_bank);
        const inn = p.data.direction === 'ENCAISSEMENT', ref = p.data.reference || (inv ? inv.number : '');
        const e = insertEntry(c, req.user.id, { journalId, date: p.data.date, reference: ref, description: `${inn ? 'Encaissement' : 'Décaissement'} ${party.name}${inv ? ' · ' + inv.number : ''}`, source: 'REGLEMENT',
          lines: [{ accountId: inn ? treas : counter, label: party.name, debit: fmt(amount), credit: '0' }, { accountId: inn ? counter : treas, label: party.name, debit: '0', credit: fmt(amount) }] });
        db.run("INSERT INTO payments(company_id,invoice_id,party_id,payment_date,direction,method,reference,amount,account_label,notes,created_by,created_at,entry_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,datetime('now'),?)", [c, inv?.id || null, party.id, p.data.date, p.data.direction, p.data.method, p.data.reference || '', fmt(amount), p.data.accountLabel || '', p.data.notes || '', req.user.id, e.id]);
        const id = one('SELECT last_insert_rowid() id').id;
        const ca = one('SELECT id FROM cash_accounts WHERE company_id=? AND kind=? AND active=1 ORDER BY id LIMIT 1', [c, cashLike ? 'CAISSE' : 'BANQUE']);
        if (ca) db.run("INSERT INTO cash_movements(company_id,cash_account_id,movement_date,direction,category,label,reference,amount,created_by,created_at) VALUES(?,?,?,?,'REGLEMENT',?,?,?,?,datetime('now'))", [c, ca.id, p.data.date, inn ? 'ENTREE' : 'SORTIE', `${party.name}${inv ? ' · ' + inv.number : ''}`, ref, fmt(amount), req.user.id]);
        if (inv) { const paid = money(inv.paid_total).plus(amount); db.run('UPDATE invoices SET paid_total=?,status=? WHERE id=?', [fmt(paid), paid.eq(money(inv.total)) ? 'PAYEE' : 'PARTIELLEMENT_PAYEE', inv.id]); }
        audit(req.user.id, c, 'CREATE', 'payment', id, fmt(amount));
        return { ...one('SELECT * FROM payments WHERE id=?', [id]), entry_no: e.entry_no };
      });
      res.status(201).json(out);
    } catch (e) { fail(res, e); }
  });

  // ---------- Tableau de bord ----------
  app.get('/api/dashboard', company, (req, res) => {
    const c = req.companyId, today = new Date().toISOString().slice(0, 10);
    const inv = q("SELECT * FROM invoices WHERE company_id=? AND status NOT IN ('BROUILLON','ANNULEE')", [c]);
    const sgn = k => (k === 'AVOIR_CLIENT' || k === 'AVOIR_FOURNISSEUR' ? -1 : 1), isSale = k => k === 'VENTE' || k === 'AVOIR_CLIENT';
    let sales = D0(), purchases = D0(), rec = D0(), pay = D0(), overdueN = 0, overdueAmt = D0(); const months = {};
    for (let i = 11; i >= 0; i--) { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i); months[d.toISOString().slice(0, 7)] = { sales: D0(), purchases: D0() }; }
    for (const i of inv) {
      const s = sgn(i.kind), rem = money(i.total).minus(money(i.paid_total)), ht = money(i.subtotal).times(s), mo = months[i.invoice_date.slice(0, 7)];
      if (isSale(i.kind)) { sales = sales.plus(money(i.total).times(s)); rec = rec.plus(rem.times(s)); if (mo) mo.sales = mo.sales.plus(ht); }
      else { purchases = purchases.plus(money(i.total).times(s)); pay = pay.plus(rem.times(s)); if (mo) mo.purchases = mo.purchases.plus(ht); }
      if (i.kind === 'VENTE' && i.due_date < today && rem.gt(0)) { overdueN++; overdueAmt = overdueAmt.plus(rem); }
    }
    const en = one("SELECT COUNT(*) count FROM entries WHERE company_id=? AND status='VALIDEE'", [c]);
    const vol = q("SELECT total_debit FROM entries WHERE company_id=? AND status='VALIDEE'", [c]).reduce((a, r) => a.plus(money(r.total_debit)), D0());
    const cash = q('SELECT * FROM cash_accounts WHERE company_id=? AND active=1', [c]).map(a => {
      const b = q('SELECT direction,amount FROM cash_movements WHERE cash_account_id=?', [a.id]).reduce((s, m) => m.direction === 'ENTREE' ? s.plus(money(m.amount)) : s.minus(money(m.amount)), money(a.opening_balance));
      return { id: a.id, name: a.name, kind: a.kind, balance: fmt(b) };
    });
    const topReceivables = inv.filter(i => i.kind === 'VENTE' && money(i.total).gt(money(i.paid_total))).map(i => ({ id: i.id, number: i.number, due_date: i.due_date, remaining: fmt(remaining(i)), late: i.due_date < today, party_name: one('SELECT name FROM third_parties WHERE id=?', [i.party_id])?.name }))
      .sort((a, b) => a.due_date.localeCompare(b.due_date)).slice(0, 6);
    res.json({ invoices: { sales: fmt(sales), purchases: fmt(purchases), receivables: fmt(rec), payables: fmt(pay) }, entries: { count: en.count, volume: fmt(vol) }, overdue: { count: overdueN, amount: fmt(overdueAmt) }, cash,
      cashTotal: fmt(cash.reduce((a, x) => a.plus(money(x.balance)), D0())), monthly: Object.entries(months).map(([m, v]) => ({ month: m, sales: fmt(v.sales), purchases: fmt(v.purchases) })), topReceivables });
  });

  // ---------- Exercices ----------
  app.get('/api/fiscal-years', company, (req, res) => res.json(q('SELECT f.*,(SELECT COUNT(*) FROM entries e WHERE e.company_id=f.company_id AND e.entry_date>=f.start_date AND e.entry_date<=f.end_date) entries FROM fiscal_years f WHERE company_id=? ORDER BY start_date DESC', [req.companyId])));
  app.post('/api/fiscal-years', company, (req, res) => {
    const p = z.object({ label: z.string().min(4), start: DATE, end: DATE }).safeParse(req.body);
    if (!p.success || p.data.end <= p.data.start) return fail(res, Error('Exercice invalide : la fin doit suivre le début.'));
    if (one('SELECT id FROM fiscal_years WHERE company_id=? AND start_date<=? AND end_date>=?', [req.companyId, p.data.end, p.data.start])) return fail(res, Error('Cet exercice chevauche un exercice existant.'));
    try { db.run('INSERT INTO fiscal_years(company_id,label,start_date,end_date,status) VALUES(?,?,?,?,\'OPEN\')', [req.companyId, p.data.label, p.data.start, p.data.end]); audit(req.user.id, req.companyId, 'CREATE', 'fiscal_year', p.data.label); persist(); res.status(201).json({ ok: true }); } catch { fail(res, Error('Ce libellé d\'exercice existe déjà.')); }
  });
  const needRole = (...roles) => (req, res, next) => roles.includes(req.memberRole) ? next() : fail(res, Error('Droits insuffisants pour cette action.'), 403);
  app.post('/api/fiscal-years/:id/close', company, needRole('ADMIN_DOSSIER'), (req, res) => {
    const y = one('SELECT * FROM fiscal_years WHERE id=? AND company_id=?', [Number(req.params.id), req.companyId]);
    if (!y) return fail(res, Error('Exercice introuvable.'), 404);
    const unb = q('SELECT id FROM entries WHERE company_id=? AND entry_date>=? AND entry_date<=? AND total_debit<>total_credit', [req.companyId, y.start_date, y.end_date]);
    if (unb.length) return fail(res, Error('Des écritures déséquilibrées existent : clôture impossible.'));
    db.run("UPDATE fiscal_years SET status='CLOSED' WHERE id=?", [y.id]); audit(req.user.id, req.companyId, 'CLOSE', 'fiscal_year', y.id, y.label); persist(); res.json({ ok: true });
  });
  app.post('/api/fiscal-years/:id/reopen', company, needRole('ADMIN_DOSSIER'), (req, res) => {
    const y = one('SELECT * FROM fiscal_years WHERE id=? AND company_id=?', [Number(req.params.id), req.companyId]);
    if (!y) return fail(res, Error('Exercice introuvable.'), 404);
    db.run("UPDATE fiscal_years SET status='OPEN' WHERE id=?", [y.id]); audit(req.user.id, req.companyId, 'REOPEN', 'fiscal_year', y.id, y.label); persist(); res.json({ ok: true });
  });

  // ---------- Paramétrage comptable & dossier ----------
  app.get('/api/settings/mappings', company, (req, res) => res.json({ mappings: mappings(req.companyId), defaults: DEF }));
  app.put('/api/settings/mappings', company, needRole('ADMIN_DOSSIER'), (req, res) => {
    const p = z.record(z.string(), z.string().min(1).max(20)).safeParse(req.body.mappings);
    if (!p.success) return fail(res, Error('Paramétrage invalide.'));
    try {
      for (const [k, v] of Object.entries(p.data)) { if (!(k in DEF)) continue; if (k.startsWith('journal_')) jrn(req.companyId, v); else acct(req.companyId, v); }
      tx(() => { for (const [k, v] of Object.entries(p.data)) if (k in DEF) db.run('INSERT OR REPLACE INTO company_settings(company_id,key,value) VALUES(?,?,?)', [req.companyId, k, v]); audit(req.user.id, req.companyId, 'UPDATE', 'settings', 'mappings'); });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/company', company, needRole('ADMIN_DOSSIER'), (req, res) => {
    const p = z.object({ name: z.string().min(2), ice: z.string().optional(), if_number: z.string().optional(), rc: z.string().optional(), patente: z.string().optional(), address: z.string().optional(), phone: z.string().optional(), email: z.string().optional() }).safeParse(req.body);
    if (!p.success) return fail(res, Error('Données du dossier invalides.'));
    if (p.data.ice && !/^\d{15}$/.test(p.data.ice.trim())) return fail(res, Error('L\'ICE doit comporter exactement 15 chiffres.'));
    const d = p.data; db.run('UPDATE companies SET name=?,ice=?,if_number=?,rc=?,patente=?,address=?,phone=?,email=? WHERE id=?', [d.name, d.ice || '', d.if_number || '', d.rc || '', d.patente || '', d.address || '', d.phone || '', d.email || '', req.companyId]);
    audit(req.user.id, req.companyId, 'UPDATE', 'company', req.companyId, d.name); persist(); res.json(one('SELECT * FROM companies WHERE id=?', [req.companyId]));
  });

  // ---------- Rapports ----------
  const csvOut = (res, name, head, rows) => { const esc = v => '"' + String(v ?? '').replace(/"/g, '""') + '"'; res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`); res.send('\ufeff' + [head, ...rows].map(r => r.map(esc).join(';')).join('\n')); };
  const range = req => { const f = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : '0000-01-01', t = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : '9999-12-31'; return [f, t]; };
  const balances = (c, f, t) => {
    const rows = q("SELECT a.id,a.code,a.label,a.type,l.debit,l.credit FROM accounts a JOIN entry_lines l ON l.account_id=a.id JOIN entries e ON e.id=l.entry_id WHERE a.company_id=? AND e.status='VALIDEE' AND e.entry_date>=? AND e.entry_date<=?", [c, f, t]);
    const m = new Map(); for (const r of rows) { const o = m.get(r.id) || { id: r.id, code: r.code, label: r.label, type: r.type, d: D0(), c: D0() }; o.d = o.d.plus(money(r.debit)); o.c = o.c.plus(money(r.credit)); m.set(r.id, o); }
    return [...m.values()].sort((a, b) => a.code.localeCompare(b.code));
  };
  app.get('/api/reports/trial-balance', company, (req, res) => {
    const [f, t] = range(req), rows = balances(req.companyId, f, t).map(o => { const n = o.d.minus(o.c); return { code: o.code, label: o.label, type: o.type, debit: fmt(o.d), credit: fmt(o.c), balance_debit: fmt(n.gt(0) ? n : 0), balance_credit: fmt(n.lt(0) ? n.neg() : 0) }; });
    const tot = k => fmt(rows.reduce((a, r) => a.plus(money(r[k])), D0()));
    if (req.query.format === 'csv') return csvOut(res, 'balance', ['Compte', 'Intitule', 'Debit', 'Credit', 'Solde debiteur', 'Solde crediteur'], rows.map(r => [r.code, r.label, r.debit, r.credit, r.balance_debit, r.balance_credit]));
    res.json({ rows, totals: { debit: tot('debit'), credit: tot('credit'), balance_debit: tot('balance_debit'), balance_credit: tot('balance_credit') } });
  });
  app.get('/api/reports/ledger', company, (req, res) => {
    const [f, t] = range(req), a = one('SELECT * FROM accounts WHERE id=? AND company_id=?', [Number(req.query.accountId), req.companyId]);
    if (!a) return fail(res, Error('Choisissez un compte.'));
    let run = q("SELECT l.debit,l.credit FROM entry_lines l JOIN entries e ON e.id=l.entry_id WHERE l.account_id=? AND e.status='VALIDEE' AND e.entry_date<?", [a.id, f]).reduce((s, r) => s.plus(money(r.debit)).minus(money(r.credit)), D0());
    const opening = run;
    const rows = q("SELECT e.entry_date,e.entry_no,e.reference,e.description,j.code journal_code,l.label line_label,l.debit,l.credit FROM entry_lines l JOIN entries e ON e.id=l.entry_id JOIN journals j ON j.id=e.journal_id WHERE l.account_id=? AND e.status='VALIDEE' AND e.entry_date>=? AND e.entry_date<=? ORDER BY e.entry_date,e.id,l.id", [a.id, f, t]).map(r => { run = run.plus(money(r.debit)).minus(money(r.credit)); return { ...r, running: fmt(run) }; });
    if (req.query.format === 'csv') return csvOut(res, 'grand-livre-' + a.code, ['Date', 'Piece', 'Journal', 'Libelle', 'Debit', 'Credit', 'Solde'], rows.map(r => [r.entry_date, r.entry_no, r.journal_code, r.description, r.debit, r.credit, r.running]));
    res.json({ account: a, opening: fmt(opening), closing: fmt(run), rows });
  });
  app.get('/api/reports/journal', company, (req, res) => {
    const [f, t] = range(req), w = ["e.company_id=?", "e.status='VALIDEE'", 'e.entry_date>=?', 'e.entry_date<=?'], a = [req.companyId, f, t];
    if (req.query.journalId) { w.push('e.journal_id=?'); a.push(Number(req.query.journalId)); }
    const rows = q(`SELECT e.entry_date,e.entry_no,e.reference,e.description,j.code journal_code,ac.code account_code,ac.label account_label,l.label line_label,l.debit,l.credit FROM entry_lines l JOIN entries e ON e.id=l.entry_id JOIN journals j ON j.id=e.journal_id JOIN accounts ac ON ac.id=l.account_id WHERE ${w.join(' AND ')} ORDER BY e.entry_date,e.id,l.id LIMIT 5000`, a);
    if (req.query.format === 'csv') return csvOut(res, 'journal', ['Date', 'Piece', 'Journal', 'Compte', 'Intitule', 'Libelle', 'Debit', 'Credit'], rows.map(r => [r.entry_date, r.entry_no, r.journal_code, r.account_code, r.account_label, r.description, r.debit, r.credit]));
    res.json({ rows });
  });
  app.get('/api/reports/vat', company, (req, res) => {
    const [f, t] = range(req);
    const rows = q("SELECT i.kind,l.tax_rate,l.line_total,l.tax_amount FROM invoice_lines l JOIN invoices i ON i.id=l.invoice_id WHERE i.company_id=? AND i.status NOT IN ('BROUILLON','ANNULEE') AND i.invoice_date>=? AND i.invoice_date<=?", [req.companyId, f, t]);
    const agg = { collected: {}, deductible: {} };
    for (const r of rows) { const col = ['VENTE', 'AVOIR_CLIENT'].includes(r.kind) ? 'collected' : 'deductible', s = r.kind.startsWith('AVOIR') ? -1 : 1, o = agg[col][r.tax_rate] ||= { rate: r.tax_rate, base: D0(), tax: D0() };
      o.tax = o.tax.plus(money(r.tax_amount).times(s)); o.base = o.base.plus(money(r.line_total).minus(money(r.tax_amount)).times(s)); }
    const out = k => Object.values(agg[k]).sort((a, b) => Number(b.rate) - Number(a.rate)).map(o => ({ rate: o.rate, base: fmt(o.base), tax: fmt(o.tax) }));
    const sum = k => Object.values(agg[k]).reduce((a, o) => a.plus(o.tax), D0());
    res.json({ collected: out('collected'), deductible: out('deductible'), totalCollected: fmt(sum('collected')), totalDeductible: fmt(sum('deductible')), net: fmt(sum('collected').minus(sum('deductible'))) });
  });
  app.get('/api/reports/income-statement', company, (req, res) => {
    const [f, t] = range(req), b = balances(req.companyId, f, t);
    const prod = b.filter(o => o.type === 'PRODUIT').map(o => ({ code: o.code, label: o.label, amount: fmt(o.c.minus(o.d)) })), chg = b.filter(o => o.type === 'CHARGE').map(o => ({ code: o.code, label: o.label, amount: fmt(o.d.minus(o.c)) }));
    const tp = prod.reduce((a, r) => a.plus(money(r.amount)), D0()), tc = chg.reduce((a, r) => a.plus(money(r.amount)), D0());
    res.json({ produits: prod, charges: chg, totalProduits: fmt(tp), totalCharges: fmt(tc), resultat: fmt(tp.minus(tc)) });
  });
  app.get('/api/reports/balance-sheet', company, (req, res) => {
    const t = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : '9999-12-31', b = balances(req.companyId, '0000-01-01', t);
    const actif = b.filter(o => o.type === 'ACTIF').map(o => ({ code: o.code, label: o.label, amount: fmt(o.d.minus(o.c)) }));
    const passif = b.filter(o => ['PASSIF', 'CAPITAUX_PROPRES'].includes(o.type)).map(o => ({ code: o.code, label: o.label, amount: fmt(o.c.minus(o.d)) }));
    const res_ = b.filter(o => o.type === 'PRODUIT').reduce((a, o) => a.plus(o.c.minus(o.d)), D0()).minus(b.filter(o => o.type === 'CHARGE').reduce((a, o) => a.plus(o.d.minus(o.c)), D0()));
    const ta = actif.reduce((a, r) => a.plus(money(r.amount)), D0()), tp = passif.reduce((a, r) => a.plus(money(r.amount)), D0()).plus(res_);
    res.json({ actif, passif, resultat: fmt(res_), totalActif: fmt(ta), totalPassif: fmt(tp), balanced: ta.eq(tp) });
  });
  app.get('/api/reports/aging', company, (req, res) => {
    const kinds = String(req.query.kind) === 'FOURNISSEUR' ? ['ACHAT', 'AVOIR_FOURNISSEUR'] : ['VENTE', 'AVOIR_CLIENT'], today = new Date().toISOString().slice(0, 10), m = new Map();
    for (const i of q("SELECT i.*,t.name party_name FROM invoices i JOIN third_parties t ON t.id=i.party_id WHERE i.company_id=? AND i.status NOT IN ('BROUILLON','ANNULEE')", [req.companyId])) {
      if (!kinds.includes(i.kind)) continue; const rem = money(i.total).minus(money(i.paid_total)).times(i.kind.startsWith('AVOIR') ? -1 : 1); if (rem.isZero()) continue;
      const late = Math.floor((new Date(today) - new Date(i.due_date)) / 864e5), bucket = late <= 0 ? 'current' : late <= 30 ? 'd30' : late <= 60 ? 'd60' : late <= 90 ? 'd90' : 'd90p';
      const o = m.get(i.party_id) || { party: i.party_name, current: D0(), d30: D0(), d60: D0(), d90: D0(), d90p: D0(), total: D0() }; o[bucket] = o[bucket].plus(rem); o.total = o.total.plus(rem); m.set(i.party_id, o);
    }
    const rows = [...m.values()].map(o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, k === 'party' ? v : fmt(v)]))).sort((a, b) => Number(b.total) - Number(a.total));
    res.json({ rows, total: fmt(rows.reduce((a, r) => a.plus(money(r.total)), D0())) });
  });

  // ---------- Utilisateurs & accès ----------
  const ROLES = ['ADMIN_DOSSIER', 'COMPTABLE', 'LECTEUR'];
  app.get('/api/users', adminOnly, (req, res) => res.json(q('SELECT id,name,email,role,created_at,totp_enabled FROM users ORDER BY name').map(u => ({ ...u, access: q('SELECT m.company_id,m.role,c.name company_name FROM memberships m JOIN companies c ON c.id=m.company_id WHERE m.user_id=?', [u.id]) }))));
  app.post('/api/users', adminOnly, (req, res) => {
    const p = z.object({ name: z.string().min(2), email: z.string().email(), password: z.string().min(12), role: z.enum(['ADMIN', 'USER']).default('USER') }).safeParse(req.body);
    if (!p.success) return fail(res, Error('Nom, e-mail valide et mot de passe de 12 caractères minimum requis.'));
    try { db.run("INSERT INTO users(name,email,password_hash,role,created_at) VALUES(?,?,?,?,datetime('now'))", [p.data.name, p.data.email.toLowerCase(), bcrypt.hashSync(p.data.password, 12), p.data.role]); const id = one('SELECT last_insert_rowid() id').id; audit(req.user.id, null, 'CREATE', 'user', id, p.data.email); persist(); res.status(201).json({ id }); } catch { fail(res, Error('Cet e-mail est déjà utilisé.')); }
  });
  app.post('/api/users/:id/access', adminOnly, (req, res) => {
    const p = z.object({ companyId: z.number().int().positive(), role: z.enum(ROLES) }).safeParse(req.body);
    if (!p.success || !one('SELECT id FROM companies WHERE id=?', [p.data?.companyId]) || !one('SELECT id FROM users WHERE id=?', [Number(req.params.id)])) return fail(res, Error('Accès invalide.'));
    db.run('INSERT OR REPLACE INTO memberships(user_id,company_id,role) VALUES(?,?,?)', [Number(req.params.id), p.data.companyId, p.data.role]); audit(req.user.id, p.data.companyId, 'GRANT', 'membership', req.params.id, p.data.role); persist(); res.json({ ok: true });
  });
  app.delete('/api/users/:id/access/:companyId', adminOnly, (req, res) => { db.run('DELETE FROM memberships WHERE user_id=? AND company_id=?', [Number(req.params.id), Number(req.params.companyId)]); audit(req.user.id, Number(req.params.companyId), 'REVOKE', 'membership', req.params.id); persist(); res.json({ ok: true }); });
  app.post('/api/users/:id/password', adminOnly, (req, res) => {
    const p = z.object({ password: z.string().min(12) }).safeParse(req.body); if (!p.success) return fail(res, Error('Mot de passe de 12 caractères minimum requis.'));
    db.run('UPDATE users SET password_hash=? WHERE id=?', [bcrypt.hashSync(p.data.password, 12), Number(req.params.id)]); audit(req.user.id, null, 'RESET_PASSWORD', 'user', req.params.id); persist(); res.json({ ok: true });
  });
  app.post('/api/me/password', (req, res) => {
    const p = z.object({ current: z.string(), password: z.string().min(12) }).safeParse(req.body); const u = one('SELECT * FROM users WHERE id=?', [req.user.id]);
    if (!p.success || !u || !bcrypt.compareSync(p.data.current, u.password_hash)) return fail(res, Error('Mot de passe actuel incorrect ou nouveau mot de passe trop court (12 caractères).'));
    db.run('UPDATE users SET password_hash=? WHERE id=?', [bcrypt.hashSync(p.data.password, 12), u.id]); audit(req.user.id, null, 'CHANGE_PASSWORD', 'user', u.id); persist(); res.json({ ok: true });
  });

  // ---------- Sauvegardes (manuelles + automatiques quotidiennes) ----------
  const bdir = path.join(ROOT, 'backups');
  const autoBackup = () => {
    try {
      const day = new Date().toISOString().slice(0, 10);
      if (!fs.readdirSync(bdir).some(f => f.startsWith('auto-' + day))) { persist(); fs.copyFileSync(DB_FILE, path.join(bdir, `auto-${day}.sqlite`)); console.log('Sauvegarde automatique : auto-' + day + '.sqlite'); }
      const autos = fs.readdirSync(bdir).filter(f => f.startsWith('auto-')).sort(); while (autos.length > Number(process.env.BACKUP_KEEP || 30)) fs.unlinkSync(path.join(bdir, autos.shift()));
    } catch (e) { console.error('Sauvegarde auto impossible :', e.message); }
  };
  autoBackup(); setInterval(autoBackup, 6 * 3600e3).unref();
  app.get('/api/backups', adminOnly, (req, res) => res.json(fs.readdirSync(bdir).filter(f => f.endsWith('.sqlite')).sort().reverse().map(f => ({ file: f, size: fs.statSync(path.join(bdir, f)).size }))));

  require('./pro2')({ ...ctx, tx, fail, insertEntry, acct, balances, range, DATE });
  require('./twofa')(ctx);
};
