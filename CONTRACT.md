# عقدُ البناء — IRTAQI

تطبيقٌ واحدٌ من ملفّ HTML واحد، يُجمَع من وحداتٍ مستقلّة. **كلُّ وكيلٍ يملك
وحدةً واحدةً ولا يفتح وحدةَ غيره.** هذا هو ما يسمح بعشرة وكلاء على التوازي.

---

## ١ · البناء

```
irtaqi/
  src/00-core.js      النواة         (مملوكةٌ للمنسّق — لا تُعدَّل)
  src/05-plans.js     منطقُ الخطط     (مملوكٌ للمنسّق — لا يُعدَّل)
  src/10-icons.js     المعجم          ← وكيل ٢
  src/15-theme.css    الهويّتان       ← وكيل ١
  src/20-shell.css    الهيكل العامّ    ← وكيل ١
  src/30-onboard.js   الدخول          ← وكيل ٣
  src/40-builder.js   بانِي المنهج     ← وكيل ٤
  src/50-today.js     ورد اليوم        ← وكيل ٥
  src/60-mushaf.js    خريطة المصحف     ← وكيل ٦
  src/70-share.js     بطاقات واتساب    ← وكيل ٧
  src/80-circles.js   الحلقات          ← وكيل ٨
  src/90-stats.js     الإحصاء          ← وكيل ٩
  src/95-settings.js  الإعدادات        ← وكيل ١٠
  build.py            يجمع الكلّ في IRTAQI.html
```

`python3 build.py` يُنتج `IRTAQI.html`. تُجمَع الملفّاتُ بترتيب أسمائها.
ملفّات `.css` تدخل في `<style>`، وملفّات `.js` في `<script>`.

**لا شبكةَ ولا مكتبةَ خارجيّة.** لا `fetch`، لا CDN، لا خطوطٌ من الإنترنت.
الملفُّ يعمل كاملًا بلا اتّصال.

---

## ٢ · واجهةُ النواة `App`

```js
App.state                 // الحالةُ كاملة (اقرأ وعدّل ثمّ App.save())
App.save()                // يحفظ ويُطلق حدث 'save'
App.uid()                 // معرّفٌ فريد

App.ar(n)                 // ١٢٣ → ١٢٣ بالأرقام العربيّة الهنديّة
App.el(tag, cls, html)    // عنصرٌ جديد
App.$(sel, root) / App.$$(sel, root)

App.Quran.PAGES           // ٦٠٤
App.Quran.juzStart(j) / juzEnd(j) / juzOf(page)
App.Quran.surahStart(s) / surahEnd(s) / surahName(s) / surahOf(page)
App.Quran.surahCount      // ١١٤

App.hijri(date) / App.greg(date) / App.dateKey(date)   // 'YYYY-MM-DD'
App.DAY_NAME[0..6] / App.DAY_SHORT[0..6]               // الأحد أوّلًا

App.screen(name, renderFn, opts)  // renderFn(params) تُعيد عنصرًا
                                  // opts.full:true يُخفي الشريطَ السفليّ
App.tab(name, label, iconKey)     // يُضيف تبويبًا في الشريط السفليّ
App.go(name, params)              // انتقال
App.route()                       // {name, params}
App.redraw()                      // إعادةُ رسم الشاشة الحاليّة

App.defIcons({key: '<path .../>'})   // يُسجّل أيقونات
App.icon(key, size, cls)             // يُعيد وسمَ svg
App.toast('نصّ')
App.on_('save'|'route'|'drawn', fn)
App.applyIdentity()
```

### الحالة

```js
{
  v: 1,
  profile: { name, gender:'m'|'f', createdAt } | null,
  plans: [ Plan ],
  circles: [ Circle ],
  settings: {}
}
```

```js
Plan = {
  id, kind:'hifz'|'review'|'tilawa'|'tathbit',
  scope:'juz'|'surah'|'page',
  from, to,            // أرقامُ صفحاتٍ دائمًا (١..٦٠٤)
  rate,                // صفحاتٌ في الجلسة
  days:[0..6],         // ٠ = الأحد
  startedAt,           // 'YYYY-MM-DD'
  done,                // عددُ الصفحات المنجزة
  log:{ 'YYYY-MM-DD': pages },
  title
}
Circle = {
  id, name, gender:'m'|'f', code, role:'owner'|'member',
  members:[{ id, name, pages, updatedAt }],
  createdAt
}
```

---

## ٣ · واجهةُ الخطط `App.Plans`

```js
App.Plans.KINDS           // {hifz:{t,d,icon}, review:{...}, tilawa, tathbit}
App.Plans.total(plan)     // عددُ صفحات المنهج
App.Plans.pct(plan)       // ٠..١٠٠
App.Plans.project(plan)   // {total, left, days, weeks, months, rem, endDate, hij, greg, bad}
App.Plans.todayRange(plan)// {from, to, count} أو null إن تمّ
App.Plans.isDueToday(plan)
App.Plans.markDone(plan, pages)   // يسجّل ويحفظ
App.Plans.streak()        // عددُ الأيّام المتتالية التي أُنجز فيها شيء
App.Plans.coveredPages()  // Set بأرقام الصفحات المنجزة في كلّ المناهج
App.Plans.create(draft)   // يُضيف منهجًا ويحفظ ويُعيده
App.Plans.remove(id)
```

---

## ٤ · قواعدُ لا تُخالَف

1. **الأرقامُ كلُّها بالعربيّة الهنديّة** عبر `App.ar()`. لا رقمَ لاتينيٌّ في الواجهة.
2. **RTL**: الصفحةُ `dir="rtl"`. استعمل `margin-inline-start` و`padding-inline-end`
   ولا تستعمل `left/right` إلّا لما يجب ألّا ينعكس.
3. **الهويّتان**: لا تكتب لونًا حرفيًّا. استعمل رموزَ `15-theme.css` وحدَها
   (`var(--accent)`، `var(--ink)`، …). الهويّةُ تتبدّل بـ`html[data-id="m"|"f"]`.
4. **التباين**: كلُّ نصٍّ ≥ ٤٫٥:١ (أو ٣:١ للكبير ≥٢٤px أو ≥١٨٫٦٦px بوزن ٧٠٠).
   وكلُّ أيقونةٍ ≥ ٣:١.
5. **هدفُ اللمس** ≥ ٤٤×٤٤px.
6. **الحركة**: تُلغى كلُّها تحت `@media (prefers-reduced-motion:reduce)`.
7. **لا إيموجي.** الأيقوناتُ من `App.icon()` وحدَها.
8. **لا نصَّ قرآنيًّا** يُكتب في الشيفرة — التطبيق يدلّ على الصفحات ولا يعرض المصحف.
9. **لا معلّمَ ولا مؤسّسةَ ولا جمعيّة.** الطالبُ والطالبةُ وحدَهما، والحلقاتُ
   يُنشئها الطلّابُ أنفسُهم.
10. **بلا خادم.** كلُّ شيءٍ في `localStorage`، والمشاركةُ عبر واتساب أو رابطٍ مُرمَّز.
11. كلُّ تعليقٍ في الشيفرة **بالعربيّة**، ويقول *لماذا* لا *ماذا*.
12. لا تُسجّل اسمَ شاشةٍ أو تبويبٍ سجّله غيرُك. أسماءُ الشاشات محجوزةٌ أدناه.

### الأسماءُ المحجوزة

| الوحدة | الشاشات | التبويب |
|---|---|---|
| onboard | `onboard` | — |
| builder | `builder`, `plan` | — |
| today | `home` | `home` «اليوم» |
| mushaf | `mushaf` | `mushaf` «المصحف» |
| share | `share` | — |
| circles | `circles`, `circle` | `circles` «حلقتي» |
| stats | `stats` | — |
| settings | `settings` | `settings` «الإعدادات» |

---

## ٥ · التحقّق قبل التسليم

```bash
cd /home/claude/irtaqi && python3 build.py && python3 qa/check.py
```

`qa/check.py` يفحص: أخطاء وحدة التحكّم، الأرقام اللاتينيّة الظاهرة،
التباين، أهدافَ اللمس، الحركةَ تحت reduced-motion، والروابطَ المكسورة.
**لا تُسلّم ووحدتُك تُخفق فيه.**

## المصحفُ والخطوط

نصُّ المصحفِ ورسمُ صفحاتِه والمتشابهاتُ **مولَّدةٌ لا مكتوبة**:
`tools/make-quran.py` يَستخرجها من المستودعَين ويَرفض الكتابةَ إن لم
تَجتز فحوصَه. ولا يُحرَّر `src/12-quran.js` ولا `13-shabih.js` ولا
`14-layout.js` بيد — القوالبُ في `src/_*.tpl.js`، وهي وحدَها تُحرَّر،
ولا تُشحَن (البناءُ يُسقط ما بدأ بـ `_`).

الخطوطُ (QCF4) خارجَ الملفِّ عمدًا: ٤٨ خطًّا، ٣٦ ميغابايت. يُنزَّل خطُّ
الصفحةِ المفتوحةِ وحدَه ويُخزَّن في Cache Storage. ولرفعها إلى جانب
التطبيق: انسخ `fonts-woff2/*.woff2` من `MohamadHajjRabee/quran-qcf4`
إلى `fonts/` بجوار `IRTAQI.html` — فيُقدَّم مجلّدُك على الـCDN.

المصدر: `quran-qcf4` — رخصةُ MIT — © 2026 Mohamad Hajj Rabee.
الرخصةُ تَشترط إبقاءَ الإشعار، وهو مُثبَتٌ في «عن التطبيق».
