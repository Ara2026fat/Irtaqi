// ============================================================================
// ارتقِ — عامل الخدمة (Service Worker)
//
// قاعدة معمارية مهمة: لا نستخدم cache.addAll() أبدًا.
// addAll() ذرّية بالكامل — فشل ملف واحد يُفشل تنصيب العامل كله بصمت، وهو ما
// يمنع ظهور زر "تثبيت التطبيق" على الجوال بلا أي رسالة خطأ مفهومة.
// البديل: تخزين كل ملف على حدة، وتجاهل الفاشل بدل إسقاط الجميع.
// ============================================================================
const CACHE_NAME = 'irtaqi-cache-v1.46';

// نقطة الدخول صارت index.html ليعمل الرابط المختصر على GitHub Pages
// (الجذرُ أيًّا كان: github.io/Irtaqi/ أو دومينٌ خاصّ). كان الاسم
// يفتح المجلد، لأن الخادم يبحث عن index.html ولا يجده.
const CORE = ['./', './index.html'];

// ملفات مساعدة — مرغوبة لكن غيابها لا يمنع عمل التطبيق.
const OPTIONAL = ['./manifest.json', './icon-192.png', './icon-512.png'];

/** يخزّن قائمة ملفات واحدًا واحدًا. يرجع دائمًا وعدًا ناجحًا. */
function cacheEach(cache, urls) {
  return Promise.all(urls.map(function (url) {
    return fetch(url, { cache: 'reload' })
      .then(function (res) {
        if (res && res.ok) return cache.put(url, res);
      })
      .catch(function () { /* ملف واحد فشل — نتجاهله ولا نُسقط التنصيب */ });
  }));
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cacheEach(cache, CORE).then(function () {
        return cacheEach(cache, OPTIONAL);
      });
    })
  );
  // ‫لا skipWaiting() ههنا: كان العامل الجديد يَحلّ محلّ القديم وقارئٌ
  // ‫يقرأ، فتَبقى صفحتُه القديمةُ وتُجلَب ملفّاتُها من نسخةٍ أخرى.
  // ‫فالانتظارُ هو الأصل، ولا يُتخطّى إلّا بإذنٍ من صاحب الجهاز أدناه.
});

// ‫التطبيقُ يَطلب التخطّي حين يَضغط القارئُ «حدِّثْ الآن».
self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names.filter(function (n) { return n !== CACHE_NAME; })
             .map(function (n) { return caches.delete(n); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function (event) {
  var req = event.request;

  /* ═══ عطل حقيقي أُصلح هنا ═══
     كان العامل يعترض كل الطلبات، ومنها بيانات المصحف وخطّه من
     raw.githubusercontent وjsDelivr. وحين تفشل الشبكة كانت catch تُرجع
     `cached` وهي undefined لطلبٍ خارجيّ لم يُخزَّن قطّ، فيُمرَّر undefined
     إلى respondWith فيقع خطأ شبكة مصطنع — والنتيجة أن المصحف لا يفتح
     أبدًا حتى مع اتصال سليم.

     القاعدة: العامل لا يعترض إلا ملفات التطبيق نفسه. أمّا المصادر
     الخارجية فتُترك للمتصفّح يديرها بنفسه ويطبّق CORS كما ينبغي. */
  var sameOrigin = false;
  try { sameOrigin = new URL(req.url).origin === self.location.origin; } catch(e){}
  if (!sameOrigin) return;

  // نتعامل مع طلبات GET فقط. أي طلب آخر يمر مباشرة للشبكة.
  if (req.method !== 'GET') return;

  /* خطوطُ مصحفِ المدينة: يُديرها التطبيقُ نفسه في مخزنٍ مستقلّ، صفحةً صفحة،
     ولا يُحمَّل منها إلا ما تَحتاجه الصفحةُ المفتوحة. فلو خزّنها العاملُ هنا
     أيضًا لتضاعف ٣٦ م.ب على جهاز القارئ بلا فائدة. فنتركها تمرّ. */
  if (req.url.indexOf('/fonts/') !== -1) return;

  // طلبات التنقّل (فتح التطبيق): الشبكة أولًا حتى يحصل المستخدم على أحدث
  // إصدار، مع الرجوع للنسخة المخزّنة عند انقطاع الاتصال.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(function (res) {
        var clone = res.clone();
        caches.open(CACHE_NAME).then(function (c) { c.put(req, clone); });
        return res;
      }).catch(function () {
        return caches.match(req).then(function (hit) {
          return hit || caches.match('./index.html') || caches.match('./Irtaqi.html');
        });
      })
    );
    return;
  }

  // باقي الأصول: المخزَّن أولًا للسرعة، مع تحديث في الخلفية.
  event.respondWith(
    caches.match(req).then(function (cached) {
      var network = fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          var clone = res.clone();
          caches.open(CACHE_NAME).then(function (c) { c.put(req, clone); });
        }
        return res;
      }).catch(function () {
        // إن لم يوجد مخزَّن، نُرجع ردًّا صريحًا بدل undefined.
        return cached || new Response('', { status: 504, statusText: 'offline' });
      });
      return cached || network;
    })
  );
});

// ============================================================================
// التذكيرُ بالوِرد — ساكنٌ حتّى يَشترك صاحبُ الجهازِ بنفسه.
// لا يَعمل شيءٌ ممّا دونه ما لم يُرسل الخادمُ إشعارًا، ولا يُرسل الخادمُ
// شيئًا لمن لم يَشترك. فوجودُ هذه المعالِجاتِ اليومَ لا يُحدث أثرًا،
// ويُغني غدًا عن تحديثِ عاملِ الخدمةِ وقتَ تفعيلِ التنبيه.
// ============================================================================

self.addEventListener('push', function (event) {
  // جسمُ الإشعارِ يأتي من الخادم، وقد يأتي فارغًا أو تالفًا — فله بديلٌ
  // لا يَلوم المتأخّر: التذكيرُ دعوةٌ لا محاسبة.
  var d = {};
  try { d = (event.data && event.data.json()) || {}; } catch (e) {}

  var title = d.title || 'ارتقِ';
  var body = d.body || 'وِردُك في انتظارك.';

  event.waitUntil(
    self.registration.showNotification(title, {
      body: body,
      dir: 'rtl',
      lang: 'ar',
      tag: d.tag || 'wird',          // واحدٌ يَحلّ محلَّ واحد، فلا تتراكم
      renotify: false,
      badge: './icon-192.png',
      icon: './icon-192.png',
      data: { url: d.url || './' }
    })
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var target = (event.notification.data && event.notification.data.url) || './';

  // نافذةٌ مفتوحةٌ تُرفَع ولا تُفتح ثانية: مَن عنده التطبيقُ مفتوحٌ
  // على صفحةٍ من المصحف لا يُقذَف منها لأنّه لمس تذكيرًا.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(function (list) {
        for (var i = 0; i < list.length; i++) {
          if (list[i].url.indexOf(self.registration.scope) === 0 && 'focus' in list[i]) {
            return list[i].focus();
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(target);
      })
  );
});
