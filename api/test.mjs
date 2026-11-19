/* ارتقِ — اختبارٌ محلّيٌّ للخدمةِ الخلفيّة، بلا حسابٍ ولا شبكةٍ ولا wrangler.
   ══════════════════════════════════════════════════════════════════
   يُشغّل fetch و scheduled المُصدَّرَتَين من worker.js مباشرةً، على قاعدةِ node:sqlite
   خلفَ طبقةٍ تُحاكي واجهةَ D1 (prepare/bind/run/first/all/batch + meta.changes).
   التشغيل:  node api/test.mjs
   ولأنَّ الزمنَ جزءٌ من المنطق (الوِردُ بتوقيتِ الجهاز) فالاختبارُ يُثبّت Date.now ويُحرّكه بيدِه. */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const worker = await import(join(HERE, 'worker.js'));

/* ── طبقةٌ تُحاكي D1 ── */
let WRITES = 0, READS = 0;       // عدّادانِ لنَرى تكلفةَ كلِّ مسارٍ بالصفوف
class D1 {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(readFileSync(join(HERE, 'schema.sql'), 'utf8'));
  }
  prepare(sql) { return new St(this.db, sql); }
  async batch(list) { return list.map(s => s.runSync()); }
  q(sql) { return this.db.prepare(sql).all(); }
}
class St {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...a) { this.args = a; return this; }
  runSync() {
    const r = this.db.prepare(this.sql).run(...this.args);
    WRITES += r.changes;
    return { success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
  }
  async run() { return this.runSync(); }
  async first() {
    const r = this.db.prepare(this.sql).get(...this.args);
    READS++;
    return r === undefined ? null : r;
  }
  async all() {
    const r = this.db.prepare(this.sql).all(...this.args);
    READS += r.length;
    return { results: r, success: true };
  }
}

/* ── زمنٌ مُثبَّت ── */
const REAL_NOW = Date.now;
let NOW = Date.UTC(2026, 10, 18, 9, 0, 0);
Date.now = () => NOW;
const setNow = (ms) => { NOW = ms; };

/* ── طلبٌ واستجابةٌ ── */
const REQ = (method, path, { body, headers = {}, country = 'SA' } = {}) => ({
  method, url: 'https://irtaqi.app' + path,
  headers: new Headers(headers),
  cf: { country },
  json: async () => { if (body === undefined) throw new Error('no body'); return body; }
});
const call = async (env, method, path, opts) => {
  const res = await worker.default.fetch(REQ(method, path, opts), env);
  let data = null;
  try { data = JSON.parse(await res.text()); } catch { /* لا جسمَ */ }
  return { status: res.status, data };
};

/* ── خدمةُ الدفعِ المُزيَّفة ── */
let PUSHES = [], PUSH_STATUS = () => 201;
globalThis.fetch = async (url, opts) => {
  PUSHES.push({ url, headers: opts?.headers || {} });
  const st = PUSH_STATUS(url);
  return { ok: st >= 200 && st < 300, status: st };
};

/* ── مُشغّلُ الاختبار ── */
let pass = 0, fail = 0;
const T = async (name, fn) => {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + (e && e.message)); fail++; }
};
function eq(a, b, msg = '') {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${msg} توقّعتُ ${B} فجاء ${A}`);
}
const ok = (c, msg) => { if (!c) throw new Error(msg || 'شرطٌ لم يَتحقّق'); };

const ID = (s) => (s + 'x'.repeat(20)).slice(0, 22);
// ملاحظةٌ تعلّمناها من الاختبارِ نفسِه: قيمُ الترويساتِ في HTTP لاتينيّةٌ (ISO-8859-1)،
// فمفتاحُ الأرقامِ ومفتاحُ الجهازِ لا يَصلحان بالعربيّة. انظر api/README.md.
const STATS_KEY = 'irtaqi-stats-9f3c1a77';
const envOf = () => ({ DB: new D1(), STATS_KEY, VAPID_SUBJECT: 'mailto:x@y.z' });

console.log('\n══ ارتقِ — اختبارُ الخدمةِ الخلفيّة ══\n');

/* ١) المسارُ السعيدُ لكلِّ نقطة */
console.log('المسارُ السعيد:');
{
  const env = envOf();
  await T('POST /api/ping يُنشئ صفًّا مجهولًا', async () => {
    const r = await call(env, 'POST', '/api/ping', { body: { id: ID('dev1'), v: '1.4.0' } });
    eq([r.status, r.data], [200, { ok: true }]);
    const rows = env.DB.q('SELECT id,ver,country FROM devices');
    eq(rows.length, 1); eq(rows[0].ver, '1.4.0'); eq(rows[0].country, 'SA');
  });

  await T('ping ثانٍ في اليومِ نفسِه لا يَكتب شيئًا', async () => {
    const before = WRITES;
    await call(env, 'POST', '/api/ping', { body: { id: ID('dev1'), v: '1.4.0' } });
    eq(WRITES - before, 0, 'كتابةٌ زائدة:');
  });

  await T('POST /api/sync أوّلُ دفعةٍ تُعيد rev=1', async () => {
    const r = await call(env, 'POST', '/api/sync', { body: { id: ID('dev1'), rev: 0, blob: 'ENC::aaa' } });
    eq([r.status, r.data], [200, { ok: true, rev: 1 }]);
  });

  await T('GET /api/sync بـrev قديمٍ يُعيد النصَّ كما هو', async () => {
    const r = await call(env, 'GET', `/api/sync?id=${ID('dev1')}&rev=0`);
    eq([r.status, r.data], [200, { ok: true, rev: 1, blob: 'ENC::aaa' }]);
  });

  await T('GET /api/sync بـrev مطابقٍ يُعيد blob=null (لا نَقل بلا سبب)', async () => {
    const r = await call(env, 'GET', `/api/sync?id=${ID('dev1')}&rev=1`);
    eq([r.status, r.data], [200, { ok: true, rev: 1, blob: null }]);
  });

  await T('دفعةٌ تالية برقمٍ صحيحٍ تُزيد العدّاد', async () => {
    const r = await call(env, 'POST', '/api/sync', { body: { id: ID('dev1'), rev: 1, blob: 'ENC::bbb' } });
    eq([r.status, r.data], [200, { ok: true, rev: 2 }]);
  });

  await T('POST /api/push/sub يَحفظ العنوانَ والوِردَ والمنطقة', async () => {
    const r = await call(env, 'POST', '/api/push/sub', {
      body: { id: ID('dev1'), sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/AAA', keys: { p256dh: 'ض', auth: 'ض' } }, wird: { h: 20, m: 30 }, tz: 'Asia/Riyadh' }
    });
    eq([r.status, r.data], [200, { ok: true }]);
    const s = env.DB.q('SELECT * FROM subs')[0];
    eq([s.h, s.m, s.tz], [20, 30, 'Asia/Riyadh']);
    ok(s.next_at > Date.now(), 'موعدُ الإيقاظِ لم يُحسب في المستقبل');
    ok(!('p256dh' in s) && !JSON.stringify(s).includes('ض'), 'مفاتيحُ الاشتراكِ حُفظت — ولا حاجةَ لها');
  });

  await T('GET /api/push/key يُعيد العامَّ ولا يُعيد الخاصَّ', async () => {
    const r = await call(env, 'GET', '/api/push/key');
    ok(r.data.ok && typeof r.data.key === 'string' && r.data.key.length > 80, 'لا مفتاحَ عامًّا');
    ok(!JSON.stringify(r.data).includes('"d"'), 'المفتاحُ الخاصُّ خرجَ في الاستجابة!');
  });

  await T('POST /api/push/unsub يَحذف الصفَّ كلَّه', async () => {
    const r = await call(env, 'POST', '/api/push/unsub', { body: { id: ID('dev1') } });
    eq([r.status, r.data], [200, { ok: true }]);
    eq(env.DB.q('SELECT * FROM subs').length, 0);
  });

  await T('GET /api/stats بالمفتاحِ يُعيد مجاميعَ لا صفوفًا', async () => {
    const r = await call(env, 'GET', '/api/stats', { headers: { 'x-stats-key': STATS_KEY } });
    eq(r.status, 200);
    eq([r.data.everInstalled, r.data.activeToday, r.data.syncedDevices], [1, 1, 1]);
    ok(!JSON.stringify(r.data).includes('ENC::'), 'الأرقامُ حمَلت محتوى blob!');
    ok(!JSON.stringify(r.data).includes(ID('dev1')), 'الأرقامُ حمَلت معرّفَ جهاز!');
  });
}

/* ٢) معرّفٌ فاسدٌ وجسمٌ فاسد */
console.log('\nالمعرّفُ الفاسدُ والمدخلُ الفاسد:');
{
  const env = envOf();
  const bad = ['', 'قصير', 'a'.repeat(15), 'a'.repeat(65), 'ok_id_but_has space!!', '../../etc/passwd', null, 12345,
    "' OR 1=1 --xxxxxxxxxxxxx"];
  await T('ping يَرفض كلَّ معرّفٍ خارجَ النمطِ بـ400', async () => {
    for (const id of bad) {
      const r = await call(env, 'POST', '/api/ping', { body: { id, v: '1' } });
      eq([id, r.status], [id, 400]);
    }
    eq(env.DB.q('SELECT * FROM devices').length, 0, 'صفٌّ كُتب لمعرّفٍ فاسد:');
  });

  await T('sync (GET وPOST) يَرفض المعرّفَ الفاسدَ بـ400', async () => {
    for (const id of bad) {
      eq((await call(env, 'GET', `/api/sync?id=${encodeURIComponent(String(id))}`)).status, 400);
      eq((await call(env, 'POST', '/api/sync', { body: { id, rev: 0, blob: 'x' } })).status, 400);
    }
  });

  await T('اقتباسٌ في المعرّفِ لا يَصل SQL أصلًا (والربطُ يَحمي ما وصل)', async () => {
    await call(env, 'POST', '/api/sync', { body: { id: ID('inj1'), rev: 0, blob: "'); DROP TABLE blobs; --" } });
    const rows = env.DB.q('SELECT blob FROM blobs');
    eq(rows.length, 1); eq(rows[0].blob, "'); DROP TABLE blobs; --");
    eq(env.DB.q("SELECT name FROM sqlite_master WHERE name='blobs'").length, 1, 'الجدولُ سقط!');
  });

  await T('blob غيرُ نصٍّ يُرَدُّ بـ400', async () => {
    for (const blob of [undefined, null, 12, { a: 1 }, ['x']])
      eq((await call(env, 'POST', '/api/sync', { body: { id: ID('b1'), rev: 0, blob } })).status, 400);
  });

  await T('وِردٌ خارجَ المدى أو منطقةٌ مجهولةٌ: الأوّلُ ٤٠٠ والثانيةُ تَسقط إلى UTC', async () => {
    let seq = 0;
    const sub = (wird, tz) => call(env, 'POST', '/api/push/sub', {
      body: { id: ID('w' + (seq++) + '_'), sub: { endpoint: 'https://a.example/b' }, wird, tz }
    });
    for (const w of [{ h: 24, m: 0 }, { h: -1, m: 0 }, { h: 5, m: 60 }, { h: 5.5, m: 0 }, {}, null])
      eq((await sub(w, 'Asia/Riyadh')).status, 400);
    eq((await sub({ h: 5, m: 0 }, 'Mars/Olympus')).status, 200);
    eq(env.DB.q("SELECT tz FROM subs WHERE tz='UTC'").length, 1);
  });

  await T('اشتراكٌ بعنوانٍ غيرِ https يُرَدُّ بـ400', async () => {
    const r = await call(env, 'POST', '/api/push/sub', {
      body: { id: ID('ep1'), sub: { endpoint: 'http://a.example/b' }, wird: { h: 5, m: 0 }, tz: 'UTC' }
    });
    eq(r.status, 400);
  });

  await T('مسارٌ مجهولٌ يُعيد 404 وOPTIONS يُعيد 204', async () => {
    eq((await call(env, 'GET', '/api/nope')).status, 404);
    const res = await worker.default.fetch(REQ('OPTIONS', '/api/sync'), env);
    eq(res.status, 204);
    eq(res.headers.get('access-control-allow-origin'), '*');
  });
}

/* ٣) blob مجاوزٌ للحدّ */
console.log('\nحجمُ الـblob:');
{
  const env = envOf();
  await T('١٬٥٠٠٬٠٠٠ بايتًا بالضبط: مقبول', async () => {
    const r = await call(env, 'POST', '/api/sync', { body: { id: ID('big1'), rev: 0, blob: 'A'.repeat(1_500_000) } });
    eq([r.status, r.data], [200, { ok: true, rev: 1 }]);
  });
  await T('بايتٌ واحدٌ فوقَه: 413 ولا يُكتب', async () => {
    const r = await call(env, 'POST', '/api/sync', { body: { id: ID('big2'), rev: 0, blob: 'A'.repeat(1_500_001) } });
    eq([r.status, r.data.error], [413, 'too_large']);
    eq(env.DB.q("SELECT * FROM blobs WHERE id='" + ID('big2') + "'").length, 0);
  });
  await T('الحدُّ بالبايتِ لا بالمحارف: نصٌّ عربيٌّ قصيرُ الطولِ ثقيلُ البايتات', async () => {
    const arab = 'ن'.repeat(800_000);            // ٨٠٠ ألف محرفٍ = ١٬٦٠٠٬٠٠٠ بايت
    eq((await call(env, 'POST', '/api/sync', { body: { id: ID('big3'), rev: 0, blob: arab } })).status, 413);
  });
  await T('ترويسةُ content-length الضخمةُ تُرَدُّ قبل قراءةِ الجسم', async () => {
    const r = await call(env, 'POST', '/api/sync', {
      headers: { 'content-length': '99000000' }, body: { id: ID('big4'), rev: 0, blob: 'x' }
    });
    eq(r.status, 413);
  });
}

/* ٤) التضاربُ على rev */
console.log('\nالتزامنُ المتفائل (409):');
{
  const env = envOf();
  const id = ID('conf1');
  await T('جهازانِ من rev=1: الأوّلُ يَفوز والثاني يُرَدُّ بـ409 ومعه الأحدث', async () => {
    await call(env, 'POST', '/api/sync', { body: { id, rev: 0, blob: 'v1' } });               // rev=1
    const a = await call(env, 'POST', '/api/sync', { body: { id, rev: 1, blob: 'v2-من-الجوّال' } });
    eq([a.status, a.data], [200, { ok: true, rev: 2 }]);
    const b = await call(env, 'POST', '/api/sync', { body: { id, rev: 1, blob: 'v2-من-الحاسب' } });
    eq([b.status, b.data], [409, { ok: false, rev: 2, blob: 'v2-من-الجوّال' }]);
  });
  await T('بعدَ الدمجِ يَنجح الدفعُ بـrev الأحدث', async () => {
    const c = await call(env, 'POST', '/api/sync', { body: { id, rev: 2, blob: 'v3-مدموج' } });
    eq([c.status, c.data], [200, { ok: true, rev: 3 }]);
    eq(env.DB.q(`SELECT rev,blob FROM blobs WHERE id='${id}'`)[0], { rev: 3, blob: 'v3-مدموج' });
  });
  await T('rev أعلى من عندِ الخادمِ (قاعدةٌ استُعيدت) يُرَدُّ بـ409 لا يُقبَل', async () => {
    const d = await call(env, 'POST', '/api/sync', { body: { id, rev: 99, blob: 'v99' } });
    eq([d.status, d.data.rev], [409, 3]);
  });
  await T('rev سالبٌ أو غيرُ عددٍ يُعالَج كصفرٍ فيُرَدُّ بـ409 لا بخطأِ خادم', async () => {
    for (const rev of [-5, 1.5, 'x', null, undefined])
      eq((await call(env, 'POST', '/api/sync', { body: { id, rev, blob: 'z' } })).status, 409);
  });
  await T('GET لمعرّفٍ لا صفَّ له: rev=0 و blob=null بلا خطأ', async () => {
    eq((await call(env, 'GET', `/api/sync?id=${ID('none1')}`)).data, { ok: true, rev: 0, blob: null });
  });
}

/* ٥) مَن يُوقَظ؟ مناطقُ زمنيّةٌ مختلفة */
console.log('\nالإيقاظُ في المناطقِ الزمنيّة:');
{
  const env = envOf();
  const mk = (id, tz, h, m) => call(env, 'POST', '/api/push/sub', {
    body: { id: ID(id), sub: { endpoint: `https://push.example/${id}` }, wird: { h, m }, tz }
  });
  // كلُّهم يُريدون التذكيرَ الساعةَ ٢٠:٠٠ بتوقيتِ جهازِهم هو
  setNow(Date.UTC(2026, 10, 18, 9, 0, 0));           // ١٨ نوفمبر ٢٠٢٦، ٩ صباحًا UTC
  await mk('riyadh', 'Asia/Riyadh', 20, 0);          // = ١٧:٠٠Z
  await mk('newyork', 'America/New_York', 20, 0);     // = ٠١:٠٠Z من اليومِ التالي
  await mk('sydney', 'Australia/Sydney', 20, 0);      // = ٠٩:٠٠Z (مضى الآن) → الغدُ ٠٩:٠٠Z
  await mk('london', 'Europe/London', 20, 0);         // = ٢٠:٠٠Z

  await T('موعدُ الإيقاظِ يُحسب لكلِّ منطقةٍ على حدةٍ لا بتوقيتٍ واحدٍ للعالَم', async () => {
    const got = {};
    for (const r of env.DB.q('SELECT id,tz,next_at FROM subs')) got[r.tz] = new Date(r.next_at).toISOString();
    eq(got['Asia/Riyadh'], '2026-11-18T17:00:00.000Z');
    eq(got['America/New_York'], '2026-11-19T01:00:00.000Z');
    eq(got['Australia/Sydney'], '2026-11-19T09:00:00.000Z');
    eq(got['Europe/London'], '2026-11-18T20:00:00.000Z');
  });

  await T('الساعةُ ١٧:٠٠Z: الرياضُ وحدَها تُوقَظ', async () => {
    PUSHES = []; setNow(Date.UTC(2026, 10, 18, 17, 0, 10));
    const res = await worker.wakeDue(env);
    eq([res.sent, PUSHES.length], [1, 1]);
    ok(PUSHES[0].url.endsWith('/riyadh'), 'أُوقظ غيرُ صاحبِه: ' + PUSHES[0].url);
  });

  await T('ولا حمولةَ في الإشعار: ترويساتٌ فقط (النصُّ العربيُّ عند عاملِ الخدمة)', async () => {
    eq(PUSHES[0].headers['Content-Length'], '0');
    eq(PUSHES[0].headers.Topic, 'irtaqi-wird');
    ok(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/.test(PUSHES[0].headers.Authorization), 'ترويسةُ VAPID غيرُ سليمة');
  });

  await T('وموعدُها القادمُ انتقلَ إلى الغدِ في منطقتِها', async () => {
    const r = env.DB.q(`SELECT next_at FROM subs WHERE tz='Asia/Riyadh'`)[0];
    eq(new Date(r.next_at).toISOString(), '2026-11-19T17:00:00.000Z');
  });

  await T('الساعةُ ٢٠:٠٠Z: لندنُ وحدَها (ولا يُعاد إيقاظُ الرياض)', async () => {
    PUSHES = []; setNow(Date.UTC(2026, 10, 18, 20, 0, 5));
    const res = await worker.wakeDue(env);
    eq([res.sent, PUSHES.length], [1, 1]);
    ok(PUSHES[0].url.endsWith('/london'), PUSHES[0].url);
  });

  await T('دقيقةٌ لا وِردَ فيها: صفرُ إرسالٍ وصفرُ كتابة', async () => {
    PUSHES = []; setNow(Date.UTC(2026, 10, 18, 21, 30, 0));
    const w0 = WRITES;
    eq(await worker.wakeDue(env), { sent: 0, gone: 0, late: 0, bad: 0 });
    eq([PUSHES.length, WRITES - w0], [0, 0]);
  });

  await T('نيويورك تُوقَظ في ٠١:٠٠Z من الغدِ لا قبلَه', async () => {
    PUSHES = []; setNow(Date.UTC(2026, 10, 19, 1, 0, 2));
    await worker.wakeDue(env);
    eq(PUSHES.map(p => p.url.split('/').pop()), ['newyork']);
  });

  await T('٤١٠ من خدمةِ الدفعِ يَحذف الاشتراك', async () => {
    PUSH_STATUS = (u) => (String(u).endsWith('/sydney') ? 410 : 201);
    PUSHES = []; setNow(Date.UTC(2026, 10, 19, 9, 0, 1));
    const res = await worker.wakeDue(env);
    eq([res.sent, res.gone], [0, 1]);
    eq(env.DB.q(`SELECT * FROM subs WHERE tz='Australia/Sydney'`).length, 0);
    PUSH_STATUS = () => 201;
  });

  await T('وِردٌ تأخّر أكثرَ من ٤٥ دقيقة: يُؤجَّل ولا يُوقِظ في غيرِ حينِه', async () => {
    const envL = envOf();
    setNow(Date.UTC(2026, 10, 18, 9, 0, 0));
    await call(envL, 'POST', '/api/push/sub', {
      body: { id: ID('late1'), sub: { endpoint: 'https://push.example/late1' }, wird: { h: 20, m: 0 }, tz: 'Asia/Riyadh' }
    });                                                            // next_at = ١٨ نوفمبر ١٧:٠٠Z
    PUSHES = [];
    setNow(Date.UTC(2026, 10, 18, 19, 30, 0));                     // بعدَه بساعتَين ونصف
    const res = await worker.wakeDue(envL);
    eq([res.sent, res.late, PUSHES.length], [0, 1, 0]);
    const r = envL.DB.q(`SELECT next_at FROM subs WHERE id='${ID('late1')}'`)[0];
    eq(new Date(r.next_at).toISOString(), '2026-11-19T17:00:00.000Z');
  });

  await T('وتأخُّرٌ دونَ ٤٥ دقيقةً يُرسَل (الموجةُ المتراكمةُ لا تُهدَر)', async () => {
    const envS = envOf();
    setNow(Date.UTC(2026, 10, 18, 9, 0, 0));
    await call(envS, 'POST', '/api/push/sub', {
      body: { id: ID('slow1'), sub: { endpoint: 'https://push.example/slow1' }, wird: { h: 20, m: 0 }, tz: 'Asia/Riyadh' }
    });
    PUSHES = [];
    setNow(Date.UTC(2026, 10, 18, 17, 40, 0));                     // تأخّرَ ٤٠ دقيقة
    eq((await worker.wakeDue(envS)).sent, 1);
    eq(PUSHES.length, 1);
  });

  await T('صفٌّ فاسدٌ في الجدولِ لا يُسقِط الدقيقةَ كلَّها عن الباقين', async () => {
    const envB = envOf();
    setNow(Date.UTC(2026, 10, 18, 9, 0, 0));
    await call(envB, 'POST', '/api/push/sub', {
      body: { id: ID('healthy1'), sub: { endpoint: 'https://push.example/healthy1' }, wird: { h: 20, m: 0 }, tz: 'Asia/Riyadh' }
    });
    // عنوانٌ مُعطَّلٌ ومنطقةٌ مجهولةٌ دخلا القاعدةَ من غيرِ الواجهة (استعادةُ نسخةٍ مثلًا)
    envB.DB.db.exec(`INSERT INTO subs(id,endpoint,tz,h,m,next_at,last_sent)
      VALUES('rottenRowABCDEF123456','not a url at all','Mars/Olympus',20,0,1,0)`);
    PUSHES = []; setNow(Date.UTC(2026, 10, 18, 17, 0, 1));
    const res = await worker.wakeDue(envB);
    eq([res.sent, res.bad], [1, 1]);
    eq(PUSHES.map(p => p.url.split('/').pop()), ['healthy1']);
    // ولا يَبقى الفاسدُ مستحقًّا فيُقرأ في كلِّ دقيقةٍ بلا فائدة
    const rotten = envB.DB.q(`SELECT next_at FROM subs WHERE id='rottenRowABCDEF123456'`)[0];
    eq(rotten.next_at, Date.now() + 864e5);
  });

  await T('٤٠ إشعارًا في الدقيقةِ سقفًا (حدُّ الطلباتِ الخارجيّةِ ٥٠) والبقيّةُ تَنتظر الدقيقةَ التالية', async () => {
    const env2 = envOf();
    setNow(Date.UTC(2026, 10, 18, 9, 0, 0));
    for (let i = 0; i < 45; i++)
      await call(env2, 'POST', '/api/push/sub', {
        body: { id: ID('m' + i + '_'), sub: { endpoint: `https://push.example/m${i}` }, wird: { h: 20, m: 0 }, tz: 'Asia/Riyadh' }
      });
    PUSHES = []; setNow(Date.UTC(2026, 10, 18, 17, 0, 1));
    eq((await worker.wakeDue(env2)).sent, 40);
    PUSHES = [];
    eq((await worker.wakeDue(env2)).sent, 5);
  });
}

/* ٦) التوقيتُ الصيفيُّ — سلوكٌ مُثبَّتٌ لا مُتمنًّى */
console.log('\nالتوقيتُ الصيفيُّ (ما يَحدث فعلًا):');
{
  const n = worker.nextWirdAt;
  // قفزةُ الربيعِ تَمحو ساعةً محلّيّةً كاملة: مَن وِردُه ٠٢:٣٠ في نيويورك لا تَأتي ساعتُه ذلك اليومَ.
  // السلوكُ المُثبَّت: يُوقَظ ٠٣:٣٠ (أوّلَ لحظةٍ بعدَ القفزة) في ذلك اليومِ وحدَه. والقرارُ ثابتٌ
  // لا يَتبدّل بوقتِ السؤال — وهذا ما كان مُتذبذبًا قبل التصحيح.
  await T('قفزةُ الربيعِ: الساعةُ الممحوّةُ لا تُسقِط الوِردَ، ولا تَتبدّل بوقتِ السؤال', async () => {
    for (const askAt of [Date.UTC(2026, 2, 8, 0, 0), Date.UTC(2026, 2, 8, 6, 0), Date.UTC(2026, 2, 8, 7, 0)])
      eq(new Date(n('America/New_York', 2, 30, askAt)).toISOString(), '2026-03-08T07:30:00.000Z', `سُئل عند ${new Date(askAt).toISOString()}:`);
  });
  await T('ولا يُوقَظ مرّتَين: ما بعدَ الإرسالِ ينتقل إلى الغد', async () => {
    const t = n('America/New_York', 2, 30, Date.UTC(2026, 2, 8, 7, 30));
    eq(new Date(t).toISOString(), '2026-03-09T06:30:00.000Z');   // = ٠٢:٣٠ بالتوقيتِ الصيفيّ
  });
  await T('عودةُ الخريفِ: ساعةٌ تُعاد مرّتَين (٠١:٣٠) → تُؤخذ الأولى لا الثانية', async () => {
    const t = n('America/New_York', 1, 30, Date.UTC(2026, 10, 1, 4, 0, 0));
    eq(new Date(t).toISOString(), '2026-11-01T05:30:00.000Z');   // = ٠١:٣٠ بالتوقيتِ الصيفيّ
  });
  await T('الرياض (لا توقيتَ صيفيًّا): ٠٥:٠٠ دائمًا ٠٢:٠٠Z', async () => {
    eq(new Date(n('Asia/Riyadh', 5, 0, Date.UTC(2026, 6, 1, 0, 0, 0))).toISOString(), '2026-07-01T02:00:00.000Z');
    eq(new Date(n('Asia/Riyadh', 5, 0, Date.UTC(2026, 0, 1, 0, 0, 0))).toISOString(), '2026-01-01T02:00:00.000Z');
  });
  await T('منطقةٌ بنصفِ ساعة (كاتماندو +٥:٤٥) تُحسب صحيحةً', async () => {
    eq(new Date(n('Asia/Kathmandu', 6, 0, Date.UTC(2026, 5, 1, 0, 0, 0))).toISOString(), '2026-06-01T00:15:00.000Z');
  });
  await T('منتصفُ الليلِ (٠٠:٠٠) ينتقل إلى الغدِ لا إلى الماضي', async () => {
    const t = n('Asia/Riyadh', 0, 0, Date.UTC(2026, 10, 18, 9, 0, 0));
    eq(new Date(t).toISOString(), '2026-11-18T21:00:00.000Z');
  });
}

/* ٧) الخصوصيّةُ والمصادقةُ وحدُّ المعدّل */
console.log('\nالخصوصيّةُ وحدُّ المعدّل:');
{
  const env = envOf();
  await T('/api/stats بلا مفتاحٍ أو بمفتاحٍ خاطئٍ: 401', async () => {
    eq((await call(env, 'GET', '/api/stats')).status, 401);
    eq((await call(env, 'GET', '/api/stats', { headers: { 'x-stats-key': 'wrong-key-0000' } })).status, 401);
  });

  await T('مفتاحُ الجهازِ (x-irtaqi-key): مَن لا يَملكه لا يَقرأ ولا يَكتب', async () => {
    const id = ID('key1'), K = { 'x-irtaqi-key': 'Dk9tQ2pVbXExc1p4YmVIMw' };
    eq((await call(env, 'POST', '/api/sync', { body: { id, rev: 0, blob: 'سرّي' }, headers: K })).status, 200);
    eq((await call(env, 'GET', `/api/sync?id=${id}`)).status, 401, 'قُرئ بلا مفتاح!');
    eq((await call(env, 'GET', `/api/sync?id=${id}`, { headers: { 'x-irtaqi-key': 'ZZZZwrongZZZZwrongZZ' } })).status, 401);
    eq((await call(env, 'POST', '/api/sync', { body: { id, rev: 1, blob: 'تخريب' } })).status, 401, 'كُتب بلا مفتاح!');
    const r = await call(env, 'GET', `/api/sync?id=${id}`, { headers: K });
    eq([r.status, r.data.blob], [200, 'سرّي']);
  });

  await T('بصمةُ المفتاحِ تُخزَّن لا المفتاحُ نفسُه', async () => {
    const row = env.DB.q(`SELECT kh FROM blobs WHERE id='${ID('key1')}'`)[0];
    ok(/^[0-9a-f]{64}$/.test(row.kh), 'ليست بصمةَ SHA-256');
    ok(!row.kh.includes('Dk9tQ2pV'), 'المفتاحُ نفسُه في القاعدة!');
  });

  await T('عميلٌ لا يُرسل المفتاحَ يَعمل كما كان (لا ينكسرُ عقدٌ قديم)', async () => {
    const id = ID('nokey1');
    eq((await call(env, 'POST', '/api/sync', { body: { id, rev: 0, blob: 'ع' } })).status, 200);
    eq((await call(env, 'GET', `/api/sync?id=${id}`)).status, 200);
  });

  await T('لا عنوانَ شبكيًّا ولا منطقةً زمنيّةً في جدولِ الأجهزةِ أصلًا', async () => {
    const cols = env.DB.q('PRAGMA table_info(devices)').map(c => c.name);
    eq(cols, ['id', 'first_day', 'last_day', 'ver', 'country']);
    const all = JSON.stringify(env.DB.q('SELECT * FROM devices'));
    ok(!all.includes('203.0.113'), 'عنوانٌ شبكيٌّ كُتب');
  });

  await T('حدُّ المعدّل على /api/sync: ٣٠ في الدقيقةِ ثمَّ 429', async () => {
    const id = ID('rl1');
    let codes = [];
    for (let i = 0; i < 33; i++) codes.push((await call(env, 'GET', `/api/sync?id=${id}`)).status);
    eq(codes.slice(0, 30).every(c => c === 200), true, 'رُفض ما دونَ الحدّ');
    eq(codes.slice(30), [429, 429, 429]);
  });

  await T('حدُّ المعدّل على /api/push/sub: ١٠ في الدقيقة', async () => {
    const id = ID('rl2'), b = { id, sub: { endpoint: 'https://push.example/rl2' }, wird: { h: 6, m: 0 }, tz: 'UTC' };
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await call(env, 'POST', '/api/push/sub', { body: b })).status;
    eq(last, 429);
  });

  await T('سدُّ المعرّفاتِ المُختلَقة: العدّادُ يَرتفع مرّةً لكلِّ معرّفٍ جديدٍ لا لكلِّ طلب', async () => {
    const env3 = envOf();
    const id = ID('ctr1');
    for (let i = 0; i < 3; i++) await call(env3, 'POST', '/api/ping', { body: { id, v: '1' } });
    eq(env3.DB.q('SELECT n FROM ctr')[0].n, 1);
  });
}

/* ٨) تكلفةُ الصفوفِ — الرقمُ الذي يُحدّد سعةَ الطبقةِ المجّانيّة */
console.log('\nتكلفةُ الصفوفِ (كتابة/قراءة لكلِّ طلب):');
{
  const env = envOf();
  const id = ID('cost1');
  const cost = async (label, fn) => {
    const w = WRITES, r = READS;
    await fn();
    console.log(`      ${label}: كتابةٌ ${WRITES - w} ، قراءةٌ ${READS - r}`);
    return WRITES - w;
  };
  await T('قياسُ تكلفةِ المسارِ اليوميِّ الكامل', async () => {
    let total = 0;
    total += await cost('ping (أوّلُ مرّةٍ في اليوم) ', () => call(env, 'POST', '/api/ping', { body: { id, v: '1.4' } }));
    total += await cost('ping (مُعاد في اليومِ نفسِه)', () => call(env, 'POST', '/api/ping', { body: { id, v: '1.4' } }));
    total += await cost('GET  /api/sync             ', () => call(env, 'GET', `/api/sync?id=${id}&rev=0`));
    total += await cost('POST /api/sync (أوّلُ دفعة) ', () => call(env, 'POST', '/api/sync', { body: { id, rev: 0, blob: 'q' } }));
    total += await cost('POST /api/sync (دفعةٌ تالية)', () => call(env, 'POST', '/api/sync', { body: { id, rev: 1, blob: 'qq' } }));
    console.log(`      مجموعُ هذا التتابعِ لجهازٍ جديد: ${total} صفَّ جدولٍ مكتوبًا`);
    console.log('      (وفي اليومِ العاديِّ لجهازٍ قائم: ٦ صفوفٍ بالفهارسِ والإيقاظ — انظر api/README.md)');
    ok(total <= 6, 'التكلفةُ أعلى من المحسوبِ في README: ' + total);
  });
}

/* ١٠) الاقتراحاتُ ورمزُ الدار */
console.log('الاقتراحاتُ ورمزُ الدار:');
{
  const env = envOf();
  await T('POST /api/note يَقبل نصًّا ولا يَحفظ معرِّفًا ولا عنوانًا', async () => {
    const r = await call(env, 'POST', '/api/note',
      { body: { text: 'أرجو إضافةَ تنبيهٍ قبلَ الفجرِ بنصفِ ساعة', v: '1.4.0' } });
    eq([r.status, r.data], [200, { ok: true }]);
    const rows = env.DB.q('SELECT * FROM notes');
    eq(rows.length, 1);
    const cols = Object.keys(rows[0]).join(',');
    ok(!/\bid\b|ip|device/i.test(cols), 'جدولُ الاقتراحاتِ فيه عمودٌ يَدلّ على الجهاز: ' + cols);
    ok(!JSON.stringify(rows[0]).includes('1.2.3.4'), 'عنوانُ الشبكةِ كُتب في القاعدة!');
  });

  await T('نصٌّ قصيرٌ يُرَدّ', async () => {
    const r = await call(env, 'POST', '/api/note', { body: { text: 'زين', v: '1' } });
    eq(r.status, 400);
  });

  await T('النصُّ يُقصّ عند الحدّ', async () => {
    const long = 'ا'.repeat(5000);
    await call(env, 'POST', '/api/note', { body: { text: long, v: '1' } });
    const rows = env.DB.q('SELECT text FROM notes ORDER BY rid DESC');
    ok(rows[0].text.length <= 1200, 'لم يُقَصّ: ' + rows[0].text.length);
  });

  await T('حدُّ المعدّلِ يَمنع السيل', async () => {
    let blocked = 0;
    for (let i = 0; i < 8; i++) {
      const r = await call(env, 'POST', '/api/note',
        { body: { text: 'اقتراحٌ رقم ' + i + ' فيه كلامٌ كافٍ', v: '1' } });
      if (r.status === 429) blocked++;
    }
    ok(blocked > 0, 'لم يُمنَع شيءٌ من ثمانيةِ طلباتٍ متتابعة');
  });

  await T('GET /api/notes يَلزمه المفتاح', async () => {
    const bad = await call(env, 'GET', '/api/notes');
    eq(bad.status, 401);
    const good = await call(env, 'GET', '/api/notes', { headers: { 'x-stats-key': STATS_KEY } });
    eq(good.status, 200);
    ok(Array.isArray(good.data.notes) && good.data.notes.length > 0, 'لم تَرجع اقتراحات');
  });

  await T('GET /api/dar/:code يَرُدّ إعدادَ الدار', async () => {
    env.DB.q("INSERT INTO dars(code,name,goal,exam_at) VALUES('alnoor','دارُ النور','{\"from\":1,\"to\":5}','1448-08-01')");
    const r = await call(env, 'GET', '/api/dar/alnoor');
    eq([r.status, r.data.ok, r.data.name], [200, true, 'دارُ النور']);
    eq(r.data.goal, { from: 1, to: 5 });
  });

  await T('رمزٌ فاسدٌ أو مجهولٌ يُرَدّ', async () => {
    eq((await call(env, 'GET', '/api/dar/!!')).status, 400);
    eq((await call(env, 'GET', '/api/dar/nosuch')).status, 404);
  });
}

Date.now = REAL_NOW;
console.log(`\n══ النتيجة: ${pass} نجحَ ، ${fail} فشلَ ══\n`);
process.exit(fail ? 1 : 0);
