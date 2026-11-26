/* Kleiner Speicher-Baustein: dieselben Funktionen für Firestore (echt) und im Arbeitsspeicher (Tests).
 * Pfade wie Firestore: 'sammlung/dokument' bzw. 'trips/<id>/planitems'. */
'use strict';

function firestoreStore(db, admin) {
  const ref = p => db.doc(p);
  return {
    async get(p) { const s = await ref(p).get(); return s.exists ? s.data() : null; },
    async set(p, data, merge) { await ref(p).set(data, merge ? { merge: true } : {}); },
    async del(p) { await ref(p).delete(); },
    async list(col) { const s = await db.collection(col).get(); return s.docs.map(d => ({ id: d.id, data: d.data() })); },
    async where(col, field, value) { const s = await db.collection(col).where(field, '==', value).get(); return s.docs.map(d => ({ id: d.id, data: d.data() })); },
    async incr(p, field, by) { await ref(p).set({ [field]: admin.firestore.FieldValue.increment(by), exp: new Date(Date.now() + 2 * 864e5) }, { merge: true }); },
    // Transaktion: fn bekommt {get(p), set(p,data,merge)}; alles oder nichts
    async txn(fn) {
      return db.runTransaction(async t => fn({
        async get(p) { const s = await t.get(ref(p)); return s.exists ? s.data() : null; },
        set(p, data, merge) { t.set(ref(p), data, merge ? { merge: true } : {}); },
      }));
    },
  };
}

function memoryStore(seed = {}) {
  const D = new Map(Object.entries(JSON.parse(JSON.stringify(seed))));
  const clone = x => x == null ? null : JSON.parse(JSON.stringify(x));
  const put = (p, data, merge) => D.set(p, merge ? { ...(D.get(p) || {}), ...clone(data) } : clone(data));
  const children = col => [...D.keys()].filter(k => k.startsWith(col + '/') && !k.slice(col.length + 1).includes('/'));
  let lock = Promise.resolve();
  return {
    D,
    async get(p) { return clone(D.get(p)); },
    async set(p, data, merge) { put(p, data, merge); },
    async del(p) { D.delete(p); },
    async list(col) { return children(col).map(k => ({ id: k.slice(col.length + 1), data: clone(D.get(k)) })); },
    async where(col, f, v) { return (await this.list(col)).filter(x => x.data && x.data[f] === v); },
    async incr(p, f, by) { const o = D.get(p) || {}; o[f] = (o[f] || 0) + by; D.set(p, o); },
    async txn(fn) {
      const run = lock.then(() => fn({ async get(p) { return clone(D.get(p)); }, set(p, d, m) { put(p, d, m); } }));
      lock = run.catch(() => {}); return run;
    },
  };
}
module.exports = { firestoreStore, memoryStore };
