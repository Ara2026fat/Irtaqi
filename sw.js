// ============================================================================
// ارتقِ — عامل الخدمة (Service Worker)
//
// قاعدة معمارية مهمة: لا نستخدم cache.addAll() أبدًا.
// addAll() ذرّية بالكامل — فشل ملف واحد يُفشل تنصيب العامل كله بصمت، وهو ما
// يمنع ظهور زر "تثبيت التطبيق" على الجوال بلا أي رسالة خطأ مفهومة.
// البديل: تخزين كل ملف على حدة، وتجاهل الفاشل بدل إسقاط الجميع.
// ============================================================================
const CACHE_NAME = 'irtaqi-cache-v3';

// نقطة الدخول صارت index.html ليعمل الرابط المختصر على GitHub Pages
// (‎ara2026fat.github.io/Irtaqi/‎). كان الاسم Irtaqi.html فيظهر 404 لمن
// يفتح المجلد، لأن الخادم يبحث عن index.html ولا يجده.
const CORE = ['./', './index.html'];

// ملفات مساعدة — مرغوبة لكن غيابها لا يمنع عمل التطبيق.
const OPTIONAL = ['./manifest.json', './icon-192.png', './icon-512.png', './Irtaqi.html'];

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
  self.skipWaiting();
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

  // نتعامل مع طلبات GET فقط. أي طلب آخر يمر مباشرة للشبكة.
  if (req.method !== 'GET') return;

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
      }).catch(function () { return cached; });
      return cached || network;
    })
  );
});
