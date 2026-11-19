/* ارتقِ — الخدمةُ الخلفيّة (Cloudflare Workers + D1)
   ════════════════════════════════════════════════════
   عقدُ الواجهةِ ثابتٌ لا يُغيَّر:
   ١) POST /api/ping        {id, v}                      → {ok:true}
   ٢) POST /api/push/sub    {id, sub, wird:{h,m}, tz}    → {ok:true}
   ٣) POST /api/push/unsub  {id}                         → {ok:true}
   ٤) GET  /api/sync?id=…&rev=…                          → {ok:true, rev, blob}
   ٥) POST /api/sync        {id, rev, blob}              → {ok:true, rev} أو 409
   ٦) GET  /api/stats       (ترويسة x-stats-key)          → أرقامٌ لصاحبِ العملِ وحدَه
   ٧) GET  /api/push/key                                 → مفتاحُ VAPID العامّ (زيادةٌ لا تَنقض العقد)
   ٨) scheduled (كلَّ دقيقة)                              → يوقظ مَن حان وِردُه في منطقتِه

   مبدأٌ أوّل: الخادمُ لا يَعرف القارئَ. لا اسمَ ولا بريدَ ولا محتوى.
   و`blob` نصٌّ مُعمًّى من طرفٍ إلى طرف: يُخزَّن كما هو، ولا يُحلَّل، ولا يُفترض فيه JSON.

   الأسرارُ (STATS_KEY ، VAPID_*) في جدولِ `cfg` في D1، ويَسبقها متغيّرُ بيئةٍ بالاسمِ نفسِه إن وُجد. */

/* ── ثوابتُ الحدود ──
   حدُّ D1 لحجمِ السلسلةِ أو الصفِّ ٢٬٠٠٠٬٠٠٠ بايت، والصفُّ يَحمل معَ الـblob معرّفًا وعدّادًا
   وبصمةَ مفتاح؛ فلو قبلنا ٢ م.ب كاملةً لَرَفضها D1 نفسُه. فالسقفُ ١٬٥٠٠٬٠٠٠ بايتًا: دونَه بمسافةٍ آمنة. */
const MAX_BLOB = 1_500_000;          // بايتًا (UTF-8) — ما جاوزَه يُرَدُّ بـ413
const MAX_BODY = 2_200_000;          // حدُّ الجسمِ كلِّه قبل قراءتِه (ترويسةُ content-length)
const PUSH_PER_TICK = 40;            // الطبقةُ المجّانيّةُ: ٥٠ طلبًا خارجيًّا لكلِّ استدعاء — نُبقي فضلة
const LATE_MS = 45 * 60e3;           // وِردٌ تأخّر أكثرَ من ٤٥ دقيقة: لا نُوقظ، بل نُؤجّل ليومِه
const NEW_IDS_PER_DAY = 3000;        // سدٌّ في وجهِ مَن يَملأ القاعدةَ بمعرّفاتٍ مُختلَقة
const RL = {                         // حدُّ المعدّل: نافذةٌ دقيقةٌ واحدة
  sync: 30,                          // لكلِّ معرّفٍ على /api/sync
  sub: 10,                           // لكلِّ معرّفٍ على /api/push/sub
  note: 3,                           // اقتراحاتٌ من عنوانٍ واحدٍ في الدقيقة
  ip: 150                            // لكلِّ عنوانٍ شبكيٍّ على كلِّ المسارات
};
const MAX_NOTE = 1200;               // حدُّ نصِّ الاقتراحِ بالمحارف
const MAX_CONTACT = 120;

/* ── أدواتٌ صغيرةٌ على نسقِ زاحِم ── */
const cors = () => ({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type,x-stats-key,x-irtaqi-key',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Max-Age': '86400'
});
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...cors() } });
const okId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(s);
const day = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);   // يومٌ بتوقيتِ UTC: حدُّ الطبقةِ المجّانيّةِ يُصفَّر عليه
const bytes = (s) => new TextEncoder().encode(s).length;

/* حدُّ المعدّل: عدّادٌ في ذاكرةِ العزلةِ لا في القاعدة.
   ليس حاجزًا تامًّا — لكلِّ مركزِ بياناتٍ عزلتُه — لكنّه يَكسر الموجةَ بلا كتابةٍ واحدةٍ في D1،
   والسدُّ الحقيقيُّ أمامَ التضخّمِ هو حدُّ المعرّفاتِ الجديدةِ في اليوم (ctr). */
const buckets = new Map();
function rateOk(key, limit) {
  const now = Date.now(), win = Math.floor(now / 60e3);
  const b = buckets.get(key);
  if (!b || b.win !== win) {
    if (buckets.size > 20000) buckets.clear();     // لا تُنمِ الذاكرةَ بلا سقف
    buckets.set(key, { win, n: 1 });
    return true;
  }
  b.n += 1;
  return b.n <= limit;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });

    try {
      const ip = req.headers.get('cf-connecting-ip') || '0';   // في الذاكرةِ فقط، لا يُكتب في القاعدةِ أبدًا
      if (url.pathname.startsWith('/api/') && !rateOk('ip:' + ip, RL.ip))
        return json({ ok: false, error: 'rate' }, 429);

      /* ١) عدٌّ مجهولٌ للأجهزة. كتابةٌ واحدةٌ في اليومِ للجهازِ الواحد:
            نقرأ أوّلًا (القراءاتُ أرخصُ من الكتاباتِ بخمسينَ ضعفًا في الطبقةِ المجّانيّة). */
      if (url.pathname === '/api/ping' && req.method === 'POST') {
        const b = await body(req);
        if (!okId(b.id)) return json({ ok: false, error: 'id' }, 400);
        const d = day(), ver = String(b.v || '').slice(0, 40), country = req.cf?.country || null;
        const cur = await env.DB.prepare('SELECT last_day,ver FROM devices WHERE id=?1').bind(b.id).first();
        if (!cur) {
          if (!(await admitNewId(env, d))) return json({ ok: false, error: 'busy' }, 429);
          await env.DB.prepare(
            'INSERT INTO devices(id,first_day,last_day,ver,country) VALUES(?1,?2,?2,?3,?4) ON CONFLICT(id) DO NOTHING'
          ).bind(b.id, d, ver, country).run();
        } else if (cur.last_day !== d || cur.ver !== ver) {
          await env.DB.prepare('UPDATE devices SET last_day=?2, ver=?3, country=COALESCE(?4,country) WHERE id=?1')
            .bind(b.id, d, ver, country).run();
        }
        return json({ ok: true });
      }

      /* ٤) سحبُ النسخةِ المُعمّاة.
            `rev` الذي يُرسله العميلُ هو ما عندَه؛ فإن طابَقَ ما عندَنا أعدنا blob=null
            (فلا نَنقل مليونَ بايتٍ بلا سبب)، وإلّا أعدنا النصَّ كما هو. */
      if (url.pathname === '/api/sync' && req.method === 'GET') {
        const id = url.searchParams.get('id');
        if (!okId(id)) return json({ ok: false, error: 'id' }, 400);
        if (!rateOk('sync:' + id, RL.sync)) return json({ ok: false, error: 'rate' }, 429);
        const row = await env.DB.prepare('SELECT rev,blob,kh FROM blobs WHERE id=?1').bind(id).first();
        if (!row) return json({ ok: true, rev: 0, blob: null });
        if (!(await keyOk(req, row.kh))) return json({ ok: false, error: 'auth' }, 401);
        const have = Number(url.searchParams.get('rev'));
        const same = Number.isFinite(have) && have === row.rev;
        return json({ ok: true, rev: row.rev, blob: same ? null : row.blob });
      }

      /* ٥) دفعُ النسخةِ المُعمّاة — تزامنٌ متفائلٌ بعدّادٍ متزايد.
            الشرطُ `rev=?3` في جملةِ التحديثِ هو الذي يَمنع التسابقَ: صفٌّ واحدٌ يَفوز،
            والآخرُ يَخرج بـ409 ومعه النسخةُ الأحدثُ ليَدمج العميلُ ثمَّ يُعيد. */
      if (url.pathname === '/api/sync' && req.method === 'POST') {
        const len = Number(req.headers.get('content-length') || 0);
        if (len > MAX_BODY) return json({ ok: false, error: 'too_large' }, 413);
        const b = await body(req);
        if (!okId(b.id)) return json({ ok: false, error: 'id' }, 400);
        if (!rateOk('sync:' + b.id, RL.sync)) return json({ ok: false, error: 'rate' }, 429);
        if (typeof b.blob !== 'string') return json({ ok: false, error: 'blob' }, 400);
        if (bytes(b.blob) > MAX_BLOB) return json({ ok: false, error: 'too_large', max: MAX_BLOB }, 413);
        const rev = Number.isInteger(b.rev) && b.rev >= 0 ? b.rev : 0;
        const now = Date.now();
        const kh = await keyHash(req);

        const cur = await env.DB.prepare('SELECT rev,kh FROM blobs WHERE id=?1').bind(b.id).first();
        if (cur && !(await keyOk(req, cur.kh))) return json({ ok: false, error: 'auth' }, 401);

        if (!cur) {
          // لا صفَّ بعد: لا شيءَ يُفقَد، فنَقبل ونَبدأ العدَّ من واحد
          if (!(await admitNewId(env, day()))) return json({ ok: false, error: 'busy' }, 429);
          const ins = await env.DB.prepare(
            'INSERT INTO blobs(id,rev,blob,updated,kh) VALUES(?1,1,?2,?3,?4) ON CONFLICT(id) DO NOTHING'
          ).bind(b.id, b.blob, now, kh).run();
          if (ins.meta?.changes) return json({ ok: true, rev: 1 });
        } else {
          const up = await env.DB.prepare(
            'UPDATE blobs SET rev=rev+1, blob=?2, updated=?3, kh=COALESCE(kh,?4) WHERE id=?1 AND rev=?5'
          ).bind(b.id, b.blob, now, kh, rev).run();
          if (up.meta?.changes) return json({ ok: true, rev: rev + 1 });
        }
        // تضاربٌ: نُعيد ما عندَنا كاملًا ليَدمجَه العميل
        const fresh = await env.DB.prepare('SELECT rev,blob FROM blobs WHERE id=?1').bind(b.id).first();
        return json({ ok: false, rev: fresh?.rev ?? 0, blob: fresh?.blob ?? null }, 409);
      }

      /* ٢) اشتراكُ التذكير. نَحفظ العنوانَ (endpoint) وساعةَ الوِردِ ومنطقتَه — لا مفاتيحَ ولا حمولة.
            ونَحسب موعدَ الإيقاظِ القادمَ هنا مرّةً واحدة، فتُصبح المهمّةُ المجدوَلةُ استعلامًا مُفهرسًا
            لا مسحًا للجدولِ كلِّه في كلِّ دقيقة. */
      if (url.pathname === '/api/push/sub' && req.method === 'POST') {
        const b = await body(req);
        if (!okId(b.id)) return json({ ok: false, error: 'id' }, 400);
        if (!rateOk('sub:' + b.id, RL.sub)) return json({ ok: false, error: 'rate' }, 429);
        const ep = b.sub?.endpoint;
        if (typeof ep !== 'string' || !/^https:\/\/[^\s]{10,900}$/.test(ep)) return json({ ok: false, error: 'sub' }, 400);
        const h = b.wird?.h, m = b.wird?.m;
        if (!Number.isInteger(h) || h < 0 || h > 23 || !Number.isInteger(m) || m < 0 || m > 59)
          return json({ ok: false, error: 'wird' }, 400);
        const tz = okTz(b.tz) ? b.tz : 'UTC';
        const next = nextWirdAt(tz, h, m, Date.now());
        const kh = await keyHash(req);

        const cur = await env.DB.prepare('SELECT kh FROM subs WHERE id=?1').bind(b.id).first();
        if (cur && !(await keyOk(req, cur.kh))) return json({ ok: false, error: 'auth' }, 401);
        if (!cur && !(await admitNewId(env, day()))) return json({ ok: false, error: 'busy' }, 429);

        await env.DB.prepare(
          `INSERT INTO subs(id,endpoint,tz,h,m,next_at,last_sent,kh) VALUES(?1,?2,?3,?4,?5,?6,0,?7)
           ON CONFLICT(id) DO UPDATE SET endpoint=?2, tz=?3, h=?4, m=?5, next_at=?6, kh=COALESCE(kh,?7)`
        ).bind(b.id, ep, tz, h, m, next, kh).run();
        return json({ ok: true });
      }

      /* ٣) إلغاءُ الاشتراك: حذفٌ تامٌّ للصفّ. لا أثرَ يَبقى. */
      if (url.pathname === '/api/push/unsub' && req.method === 'POST') {
        const b = await body(req);
        if (!okId(b.id)) return json({ ok: false, error: 'id' }, 400);
        const cur = await env.DB.prepare('SELECT kh FROM subs WHERE id=?1').bind(b.id).first();
        if (cur && !(await keyOk(req, cur.kh))) return json({ ok: false, error: 'auth' }, 401);
        await env.DB.prepare('DELETE FROM subs WHERE id=?1').bind(b.id).run();
        return json({ ok: true });
      }

      /* ٧) المفتاحُ العامُّ وحدَه — يَحتاجه المتصفّحُ في pushManager.subscribe.
            الخاصُّ لا يَخرج من القاعدةِ في أيِّ استجابة. */
      if (url.pathname === '/api/push/key' && req.method === 'GET') {
        const { pub } = await ensureVapid(env);
        return json({ ok: true, key: pub });
      }

      /* ٦) الأرقامُ لصاحبِ العملِ وحدَه: مجاميعُ لا صفوفٌ، ولا شيءَ عن قارئٍ بعينِه.
            والدولُ التي فيها أقلُّ من خمسةِ أجهزةٍ تُجمع في «أخرى» كي لا يَدلَّ رقمٌ على شخص. */
      /* ٧) الاقتراحات — صوتُهم يَصل ولا تَصل أسماؤهم.
            **لا يُقرَأ من هذا الطلبِ معرِّفُ جهازٍ ولا ترويسةُ هويّة،
            ولا يُكتَب عنوانٌ شبكيٌّ في القاعدة.** العنوانُ يُستعمَل في
            الذاكرةِ لحدِّ المعدّلِ ثمّ يُنسى — وهو معالجةٌ لا حفظ.
            وبهذا لا يُجمَع اقتراحٌ إلى أخيه ولا يُعرَف صاحبُه. */
      if (url.pathname === '/api/note' && req.method === 'POST') {
        if (!rateOk('note:' + ip, RL.note)) return json({ ok: false, error: 'rate' }, 429);
        const b = await body(req);
        const text = String(b.text || '').trim().slice(0, MAX_NOTE);
        if (text.length < 10) return json({ ok: false, error: 'short' }, 400);
        const contact = String(b.contact || '').trim().slice(0, MAX_CONTACT);
        const ver = String(b.v || '').slice(0, 40);
        const dar = /^[a-z0-9][a-z0-9-]{1,30}$/.test(String(b.d || '')) ? String(b.d) : null;
        await env.DB.prepare(
          'INSERT INTO notes(at,ver,dar,text,contact) VALUES(?1,?2,?3,?4,?5)'
        ).bind(Date.now(), ver, dar, text, contact || null).run();
        return json({ ok: true });
      }

      /* ٨) قراءةُ الاقتراحاتِ — لصاحبِ العملِ وحدَه بمفتاحِ الأرقام */
      if (url.pathname === '/api/notes' && req.method === 'GET') {
        const nk = await cfgGet(env, 'STATS_KEY');
        if (!nk || req.headers.get('x-stats-key') !== nk) return json({ ok: false }, 401);
        const rs = await env.DB.prepare(
          'SELECT rid,at,ver,dar,text,contact,seen FROM notes ORDER BY at DESC LIMIT 200'
        ).all();
        return json({ ok: true, notes: rs.results || [] });
      }

      /* ٩) إعداداتُ الدار — رمزٌ في رابطٍ لا حسابٌ ولا تسجيل.
            لا يُرسَل في هذا الطلبِ شيءٌ عن الجهاز. */
      if (url.pathname.startsWith('/api/dar/') && req.method === 'GET') {
        const code = decodeURIComponent(url.pathname.slice(9)).toLowerCase();
        if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(code)) return json({ ok: false }, 400);
        const r = await env.DB.prepare(
          'SELECT code,name,goal,exam_at FROM dars WHERE code=?1'
        ).bind(code).first();
        if (!r) return json({ ok: false }, 404);
        let goal = null;
        try { goal = r.goal ? JSON.parse(r.goal) : null; } catch { goal = null; }
        return json({ ok: true, name: r.name || '', goal, examAt: r.exam_at || '' });
      }

      if (url.pathname === '/api/stats' && req.method === 'GET') {
        const sk = await cfgGet(env, 'STATS_KEY');
        if (!sk || req.headers.get('x-stats-key') !== sk) return json({ ok: false }, 401);
        const d = day(), d7 = day(Date.now() - 6 * 864e5), d30 = day(Date.now() - 29 * 864e5);
        const q = (sql, ...a) => env.DB.prepare(sql).bind(...a).first();
        const [total, today, w, mo, subs, blobs] = await Promise.all([
          q('SELECT COUNT(*) n FROM devices'),
          q('SELECT COUNT(*) n FROM devices WHERE last_day=?1', d),
          q('SELECT COUNT(*) n FROM devices WHERE last_day>=?1', d7),
          q('SELECT COUNT(*) n FROM devices WHERE last_day>=?1', d30),
          q('SELECT COUNT(*) n FROM subs'),
          q('SELECT COUNT(*) n, COALESCE(SUM(LENGTH(blob)),0) b FROM blobs')
        ]);
        const rawC = (await env.DB.prepare(
          'SELECT country c, COUNT(*) n FROM devices WHERE last_day>=?1 GROUP BY country ORDER BY n DESC LIMIT 40'
        ).bind(d30).all()).results;
        const byCountry = [];
        let other = 0;
        for (const r of rawC) {
          if (r.n >= 5) byCountry.push(r); else other += r.n;
        }
        if (other) byCountry.push({ c: 'أخرى', n: other });
        const byVer = (await env.DB.prepare(
          'SELECT ver v, COUNT(*) n FROM devices WHERE last_day>=?1 GROUP BY ver ORDER BY n DESC LIMIT 6'
        ).bind(d30).all()).results;
        return json({
          ok: true,
          everInstalled: total.n, activeToday: today.n, active7d: w.n, active30d: mo.n,
          wirdReminders: subs.n, syncedDevices: blobs.n, syncedBytes: blobs.b,
          byCountry, byVersion: byVer
        });
      }

      return json({ ok: false, error: 'not_found' }, 404);
    } catch (e) {
      // لا نُفشي نصَّ الخطأ: قد يَحمل جزءًا من استعلامٍ أو بيانًا
      return json({ ok: false, error: 'server' }, 500);
    }
  },

  async scheduled(_evt, env, ctx) { ctx.waitUntil(wakeDue(env)); }
};

/* ── جسمُ الطلبِ ── */
const body = (req) => req.json().catch(() => ({}));

/* ── مفتاحُ الجهازِ (اختياريٌّ، يَسُدُّ ثغرةَ «المعرّفُ وحدَه كلمةُ السرّ») ──
   إن أرسلَ العميلُ ترويسةَ x-irtaqi-key (سرٌّ عشوائيٌّ يولَد على الجهازِ ولا يُشتقُّ من مفتاحِ التعمية)
   حَفِظنا بصمتَها (SHA-256) مع الصفِّ في أوّلِ كتابة، وطالبنا بها فيما بعد. ومَن لم يُرسلها
   يَعمل كما كان — فلا ينكسرُ عميلٌ قديم. */
async function sha256(s) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function keyHash(req) {
  const k = req.headers.get('x-irtaqi-key');
  return (typeof k === 'string' && k.length >= 16 && k.length <= 200) ? await sha256(k) : null;
}
async function keyOk(req, stored) {
  if (!stored) return true;                 // صفٌّ لم يُختَم بمفتاحٍ بعد
  return (await keyHash(req)) === stored;
}

/* ── سدُّ المعرّفاتِ المُختلَقة: عدّادٌ واحدٌ لليوم، كتابةٌ واحدةٌ لكلِّ معرّفٍ جديدٍ لا لكلِّ طلب ── */
async function admitNewId(env, d) {
  const r = await env.DB.prepare('SELECT n FROM ctr WHERE d=?1').bind(d).first();
  if (r && r.n >= NEW_IDS_PER_DAY) return false;
  await env.DB.prepare('INSERT INTO ctr(d,n) VALUES(?1,1) ON CONFLICT(d) DO UPDATE SET n=n+1').bind(d).run();
  return true;
}

/* ── المناطقُ الزمنيّة ──
   «ساعةُ الوِردِ بتوقيتِ الجهاز» تعني أنَّ الخادمَ يَحسب لكلِّ جهازٍ لحظتَه هو.
   نأخذ أجزاءَ الوقتِ في المنطقةِ المطلوبة، ثمَّ نُحوّل الهدفَ المحلّيَّ إلى UTC بفارقِ المنطقةِ
   عندَ الهدفِ نفسِه (لا عندَ الآن) — فمرحلتان تَكفيان لتَصحيحِ التوقيتِ الصيفيّ. */
function okTz(tz) {
  if (typeof tz !== 'string' || tz.length > 64 || !/^[A-Za-z0-9_+\-\/]+$/.test(tz)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
const TZF = new Map();
function tzParts(tz, ms) {
  let f = TZF.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    TZF.set(tz, f);
  }
  const p = {};
  for (const x of f.formatToParts(new Date(ms))) if (x.type !== 'literal') p[x.type] = Number(x.value);
  if (p.hour === 24) p.hour = 0;                       // بعضُ البيئاتِ تُعطي ٢٤ مكانَ صفر
  return p;
}
const asUTC = (p) => Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
const tzOffset = (tz, ms) => asUTC(tzParts(tz, ms)) - ms;     // فارقُ المنطقةِ عندَ تلك اللحظة

export function nextWirdAt(tz, h, m, from) {
  const SIX = 6 * 3600e3;
  for (let add = 0; add <= 2; add++) {
    const p = tzParts(tz, from + add * 864e5);
    const wall = Date.UTC(p.year, p.month - 1, p.day, h, m, 0);   // الوقتُ المحلّيُّ مقروءًا كأنّه UTC
    // تخمينٌ أوّلُ ثمَّ نَجُسُّ الفارقَ قبلَه وبعدَه بستِّ ساعات، فنُحيط بأيِّ قفزةٍ قريبة
    const guess = wall - tzOffset(tz, from + add * 864e5);
    const cands = [...new Set([wall - tzOffset(tz, guess - SIX), wall - tzOffset(tz, guess + SIX)])]
      .sort((a, b) => a - b);
    // لحظةٌ «قائمة» = ساعتُها المحلّيّةُ هي المطلوبةُ فعلًا
    const real = cands.filter(t => { const q = tzParts(tz, t); return q.hour === h && q.minute === m; });
    // ساعةٌ تُعاد مرّتَين (عودةُ الخريف): نأخذ أولاها.
    // ساعةٌ مُمحوّةٌ لا وجودَ لها (قفزةُ الربيع): نأخذ أوّلَ لحظةٍ بعدَ القفظةِ — فيُوقَظ متأخّرًا
    // ساعةً في ذلك اليومِ وحدَه، ولا يُسقَط وِردُه ولا يُكرَّر. والقرارُ ثابتٌ لا يَتبدّل بوقتِ السؤال.
    const pick = real.length ? real.find(t => t > from) : cands.filter(t => t > from).pop();
    if (pick !== undefined) return pick;
  }
  return from + 864e5;                                          // مخرجٌ لا يُتوقَّع الوصولُ إليه
}

/* ── الأسرارُ في D1 (جدولُ cfg) — كما في زاحِم ── */
async function cfgGet(env, k) {
  if (env[k]) return env[k];
  const r = await env.DB.prepare('SELECT v FROM cfg WHERE k=?1').bind(k).first();
  return r ? r.v : null;
}
async function ensureVapid(env) {
  let pub = await cfgGet(env, 'VAPID_PUBLIC'), priv = await cfgGet(env, 'VAPID_PRIVATE_JWK');
  if (pub && priv) return { pub, priv };
  const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  priv = JSON.stringify(await crypto.subtle.exportKey('jwk', k.privateKey));
  pub = b64u(await crypto.subtle.exportKey('raw', k.publicKey));
  // INSERT OR IGNORE: إن سبقَه طلبٌ آخرُ قرأنا ما كُتب أوّلًا فلا يختلفُ المفتاحان
  await env.DB.prepare('INSERT OR IGNORE INTO cfg(k,v) VALUES(?1,?2),(?3,?4)')
    .bind('VAPID_PUBLIC', pub, 'VAPID_PRIVATE_JWK', priv).run();
  return { pub: await cfgGet(env, 'VAPID_PUBLIC'), priv: await cfgGet(env, 'VAPID_PRIVATE_JWK') };
}

/* ── الإيقاظ ──
   استعلامٌ مُفهرسٌ على next_at: في الدقيقةِ التي لا وِردَ فيها يُقرأ صفرُ صفوف.
   ولا حمولةَ في الإشعار: الخادمُ يَقرع البابَ وعاملُ الخدمةِ يَكتب النصَّ العربيَّ عندَه،
   فلا يَمرُّ شيءٌ من حالِ القارئِ على خادمِ الدفعِ ولا على خادمِنا. */
export async function wakeDue(env) {
  const now = Date.now();
  const due = (await env.DB.prepare(
    'SELECT id,endpoint,tz,h,m,next_at FROM subs WHERE next_at<=?1 ORDER BY next_at LIMIT ?2'
  ).bind(now, PUSH_PER_TICK).all()).results;
  if (!due.length) return { sent: 0, gone: 0, late: 0, bad: 0 };

  const { pub, priv } = await ensureVapid(env);
  const key = await crypto.subtle.importKey('jwk', JSON.parse(priv),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const subject = env.VAPID_SUBJECT || 'mailto:ara1979fat@gmail.com';
  const jwtCache = new Map();
  const ops = [];
  let sent = 0, gone = 0, late = 0, bad = 0;

  for (const r of due) {
    // صفٌّ واحدٌ فاسدٌ (عنوانٌ مُعطَّلٌ أو منطقةٌ لم تَعُد معروفةً في بيئةِ التشغيل) لا يَجوز
    // أن يُسقط الدقيقةَ كلَّها فيَحرم الباقين وِردَهم. فكلُّ صفٍّ في حِرزِه.
    try {
      const next = nextWirdAt(r.tz, r.h, r.m, now);
      if (now - r.next_at > LATE_MS) {               // فاتَ وقتُه بكثير: نُؤجّل ولا نُوقظ في غيرِ حينِه
        late++;
        ops.push(env.DB.prepare('UPDATE subs SET next_at=?2 WHERE id=?1').bind(r.id, next));
        continue;
      }
      const aud = new URL(r.endpoint).origin;
      let jwt = jwtCache.get(aud);
      if (!jwt) { jwt = await vapidJwt(key, aud, subject); jwtCache.set(aud, jwt); }
      const res = await fetch(r.endpoint, {
        method: 'POST',
        headers: {
          TTL: '900', Urgency: 'normal', Topic: 'irtaqi-wird',
          Authorization: `vapid t=${jwt}, k=${pub}`, 'Content-Length': '0'
        }
      }).catch(() => null);

      if (res && (res.status === 404 || res.status === 410)) {     // انتهى الاشتراك
        gone++;
        ops.push(env.DB.prepare('DELETE FROM subs WHERE id=?1').bind(r.id));
      } else if (res && res.ok) {
        sent++;
        ops.push(env.DB.prepare('UPDATE subs SET next_at=?2, last_sent=?3 WHERE id=?1').bind(r.id, next, now));
      }
      // غيرُ ذلك: لا نَكتب شيئًا، فيَبقى مستحقًّا وتُعيد الدقيقةُ القادمةُ المحاولة
    } catch {
      // ولا نَدَعه مستحقًّا إلى الأبدِ فيُقرأ في كلِّ دقيقةٍ بلا فائدة: نُؤجّله يومًا
      bad++;
      try { ops.push(env.DB.prepare('UPDATE subs SET next_at=?2 WHERE id=?1').bind(r.id, now + 864e5)); } catch { /**/ }
    }
  }
  // دفعةٌ واحدةٌ: استعلامٌ واحدٌ في حدِّ «الاستعلاماتُ لكلِّ استدعاء» (٥٠ في المجّانيّة)
  if (ops.length) await env.DB.batch(ops);
  return { sent, gone, late, bad };
}

/* ── VAPID ── */
function b64u(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const enc = (o) => b64u(new TextEncoder().encode(JSON.stringify(o)));
async function vapidJwt(key, aud, sub) {
  const head = enc({ typ: 'JWT', alg: 'ES256' });
  const bodyPart = enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub });
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key,
    new TextEncoder().encode(`${head}.${bodyPart}`));
  return `${head}.${bodyPart}.${b64u(sig)}`;
}
