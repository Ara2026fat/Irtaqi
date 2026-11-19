#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
‫نشرُ ارتقِ على GitHub Pages.

‫الملفُّ المبنيُّ IRTAQI.html قائمٌ بنفسه: يعمل من file:// بلا خادمٍ ولا شبكة،
‫ولذلك يحمل بيانَ التطبيق (manifest) مضمَّنًا كـ data: ولا يسجّل عاملَ خدمة.
‫أمّا على Pages فنريد ثلاثةَ أشياءَ زائدة:

  ١) بيانًا خارجيًّا فيه أيقونات، إذ لا يَعرض أندرويد «تثبيتَ التطبيق» لبيانٍ
     ‫بلا أيقونة، وبيانُ data: لا يَقبل أيقوناتٍ نسبيّة.
  ٢) أيقونةَ شاشةِ البداية في iOS (apple-touch-icon).
  ٣) تسجيلَ عاملِ الخدمة ليعمل التطبيق دون اتصال ويقبل التثبيت.

‫فهذا السِّكريبت يأخذ الملفَّ القائمَ بنفسه ويُخرج index.html الخاصَّ بالنشر.
‫لا يُعدَّل index.html باليد — يُعاد توليدُه:

    python3 deploy.py ../irtaqi/IRTAQI.html
"""

import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

# ‫يُستبدَل بيانُ data: ببيانٍ خارجيٍّ ذي أيقونات.
MANIFEST_RE = re.compile(
    r'<link rel="manifest" href=\'data:application/manifest\+json,[^\']*\'>'
)
MANIFEST_NEW = (
    '<link rel="manifest" href="./manifest.json">\n'
    '<link rel="apple-touch-icon" href="./icon-192.png">'
)

# ‫يُسجَّل عاملُ الخدمة بعد الإقلاع، لا قبله: الإقلاعُ لا يَنتظر الشبكة.
SW_ANCHOR = '</body>\n</html>'
SW_SNIPPET = """<script>
/* عاملُ الخدمة — للعملِ دون اتصالٍ وقَبولِ التثبيت. يُضيفه deploy.py، وليس
   في الملفِّ القائمِ بنفسه لأنّ file:// لا يَسمح بعاملِ خدمةٍ أصلًا. */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('./sw.js').catch(function () {});
  });
}
</script>
</body>
</html>"""


def main() -> int:
    src = Path(sys.argv[1] if len(sys.argv) > 1 else HERE.parent / 'irtaqi' / 'IRTAQI.html')
    if not src.is_file():
        print('لم أجد الملفَّ المبنيّ: %s' % src)
        return 1

    html = src.read_text(encoding='utf-8')

    html, n = MANIFEST_RE.subn(MANIFEST_NEW, html, count=1)
    if n != 1:
        print('لم أجد بيانَ data: في الملفّ — تغيّرت بنيةُ الرأس، فأوقفتُ النشر.')
        return 1

    if SW_ANCHOR not in html:
        print('لم أجد خاتمةَ الملفّ — أوقفتُ النشر.')
        return 1
    html = html.replace(SW_ANCHOR, SW_SNIPPET, 1)

    # ‫اسمُ المُخرَجِ وسيطٌ ثانٍ اختياريّ: كان مثبَّتًا على index.html وحدَه،
    # ‫فكان ملفُّ التجربة skin.html يُنسَخ باليدِ مرّةً ثمّ يُنسى — فيَفحصه
    # ‫صاحبُه وهو بناءٌ قديمٌ لا تَبلغه الإصلاحات. والنسيانُ لا يُعالَج
    # ‫بالتذكّرِ بل بإزالةِ الخطوةِ التي تُنسى.
    out = HERE / (sys.argv[2] if len(sys.argv) > 2 else 'index.html')
    out.write_text(html, encoding='utf-8')
    print('كُتب %s — %.1f م.ب' % (out.name, out.stat().st_size / 1048576))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
