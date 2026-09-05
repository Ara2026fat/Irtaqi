/* ═══════════════════════════════════════════════════════════════════════════
   ملفّ المحاكاة — ارتقِ
   Demo seeder and guided tour.

   الغرض: أن ترى المنصّة وهي تعمل ببيانات تُشبه حلقةً حقيقيّة، لا بشاشاتٍ
   فارغة. يزرع حلقتين وأربعة عشر طالبًا موزّعين على المستويات، ولكلٍّ
   تاريخُ حضورٍ وتسميعٍ وإتقانٍ يمتدّ أربعة أسابيع، وأهدافٌ تجعل بعضهم
   متقدّمًا وبعضهم على الخطّة وبعضهم متأخّرًا — عن قصدٍ لا مصادفة.

   التركيب:
     ١) ارفعوا هذا الملفّ بجانب index.html باسم demo.js
     ٢) افتحوا:  ara2026fat.github.io/Irtaqi/?demo=1
        أو من وحدة التحكّم:  IrtaqiDemo.seed()

   الأمان: البيانات القائمة تُنسَخ قبل الزرع، وIrtaqiDemo.restore() تُعيدها.
   ولا يعمل الزرع إلّا بطلبٍ صريح — لا يُشغَّل من تلقاء نفسه أبدًا.
   ═══════════════════════════════════════════════════════════════════════════ */

var IrtaqiDemo = (function(){
  "use strict";

  var BACKUP_KEY = 'irtaqi-demo-backup';
  var KEYS = ['irtaqi-teacher-circles','irtaqi-user-type','irtaqi-user-name',
              'irtaqi-individual-gender','irtaqi-teacher-gender','irtaqi-hifz',
              'irtaqi-tilawa','irtaqi-badge-log','irtaqi-rifqah','irtaqi-usra'];

  function iso(daysAgo){
    var d = new Date(); d.setDate(d.getDate() - daysAgo);
    return d.toISOString().slice(0,10);
  }
  function key(daysAgo){
    var d = new Date(); d.setDate(d.getDate() - daysAgo);
    return d.toDateString();
  }

  /* ── الطلاب ──
     الحقول: الاسم، المستوى بالأجزاء، هدفه، وسلوكه.
     «السلوك» يحدّد كثافة الحضور والتسميع، فينتج عنه تلقائيًّا تقييمُ أداءٍ
     مختلف لكلّ طالب — بدل أن نكتب التقييم بأيدينا فيبدو مصطنعًا. */
  var ROSTER = [
    /* الحفّاظ */
    { n:'عبدالرحمن السالم', juz:16, goal:[4,16], gained:3.2, behave:'excellent' },
    { n:'يوسف العمري',      juz:15, goal:[3,12], gained:1.2, behave:'weak'      },
    /* المتقدّمون */
    { n:'أحمد المطيري',     juz:11, goal:[5,20], gained:2.6, behave:'excellent' },
    { n:'خالد الشهري',      juz:9,  goal:[4,16], gained:1.9, behave:'good'      },
    { n:'سعد القحطاني',     juz:7,  goal:[6,24], gained:1.1, behave:'weak'      },
    { n:'بندر الدوسري',     juz:6,  goal:[4,20], gained:2.0, behave:'good'      },
    /* المتوسطون */
    { n:'محمد الغامدي',     juz:5,  goal:[3,12], gained:1.5, behave:'good'      },
    { n:'تركي الحربي',      juz:4,  goal:[4,16], gained:0.7, behave:'weak'      },
    { n:'ناصر الزهراني',    juz:3,  goal:[2,10], gained:1.4, behave:'excellent' },
    { n:'عمر البقمي',       juz:2,  goal:[3,14], gained:0.9, behave:'good'      },
    /* المبتدئون */
    { n:'فهد العتيبي',      juz:1,  goal:[2,12], gained:1.0, behave:'good'      },
    { n:'مشعل الرشيدي',     juz:1,  goal:[1,8],  gained:1.0, behave:'excellent' },
    { n:'سلطان المالكي',    juz:0,  goal:[2,12], gained:0.2, behave:'weak'      },
    { n:'راكان السبيعي',    juz:1,  goal:[1,10], gained:0.5, behave:'good'      }
  ];

  /* التكاليف: نوزّعها على السور القصيرة والطوال بحسب المستوى. */
  var ASSIGN = [
    { s:78,  f:1,  t:20 }, { s:67, f:1,  t:12 }, { s:2,  f:255, t:260 },
    { s:36,  f:1,  t:12 }, { s:18, f:1,  t:10 }, { s:55, f:1,  t:16 },
    { s:59,  f:18, t:24 }, { s:1,  f:1,  t:7  }, { s:112,f:1,  t:4  },
    { s:114, f:1,  t:6  }, { s:103,f:1,  t:3  }, { s:110,f:1,  t:3  },
    { s:108, f:1,  t:3  }, { s:113,f:1,  t:5  }
  ];

  /** كثافة السلوك: احتمال الحضور والتسميع والإتقان. */
  function profile(b){
    if(b === 'excellent') return { att:0.97, memo:0.92, mast:0.80, late:0.02 };
    if(b === 'good')      return { att:0.88, memo:0.72, mast:0.52, late:0.10 };
    return                       { att:0.62, memo:0.38, mast:0.22, late:0.18 };
  }

  /* مولّد شبه عشوائيّ بذرته ثابتة: المحاكاة تُعيد النتيجة نفسها كلّ مرّة،
     فما تراه اليوم تراه غدًا — وهذا يجعل النقاش حولها ممكنًا. */
  var _seed = 20260905;
  function rnd(){
    _seed = (_seed * 1103515245 + 12345) & 0x7fffffff;
    return _seed / 0x7fffffff;
  }

  function buildStudent(row, i){
    var p = profile(row.behave);
    var st = {
      id: 9000 + i,
      name: row.n,
      phone: '',
      guardianPhone: '9665' + String(10000000 + i * 37).slice(0,8),
      juzMemorized: row.juz,
      memoPlan: '', reviewPlan: '',
      mastery: {}, completion: {}, attendance: {},
      roomMemo: {}, roomRev: {}, assignLog: {}
    };

    var a = ASSIGN[i % ASSIGN.length];
    st.memoAssign = { surah:a.s, from:a.f, to:a.t, at: iso(3) };
    if(typeof assignmentLabel === 'function') st.memoPlan = assignmentLabel(st.memoAssign);

    /* الهدف: بدأ قبل أسابيع، وتقدّمه المسجَّل يجعله متقدّمًا أو متأخّرًا.
       startJuz = مستواه اليوم ناقصًا ما أنجزه منذ الهدف. */
    var weeksIn = Math.min(row.goal[1], 8);
    st.goal = {
      juz: row.goal[0],
      weeks: row.goal[1],
      startISO: iso(weeksIn * 7),
      startJuz: Math.max(0, Math.round((row.juz - row.gained) * 10) / 10)
    };

    /* أربعة أسابيع من السجلّ — الجمعة والسبت عطلة الحلقة. */
    for(var d = 0; d < 28; d++){
      var day = new Date(); day.setDate(day.getDate() - d);
      var wd = day.getDay();
      if(wd === 5 || wd === 6) continue;          // الجمعة والسبت
      var k = key(d), ki = iso(d);
      var r1 = rnd();
      if(r1 < p.att){
        st.attendance[k] = (rnd() < p.late) ? 'late' : 'present';
        if(rnd() < p.memo){
          st.completion[k] = true;
          st.roomMemo[k] = true;
          if(rnd() < 0.75) st.roomRev[k] = true;
          var m = rnd();
          st.mastery[k] = m < p.mast ? 'mastered' : (m < p.mast + 0.28 ? 'partial' : 'weak');
          if(rnd() < 0.35 && st.memoPlan) st.assignLog[k] = st.memoPlan;
        }
      } else {
        st.attendance[k] = 'absent';
      }
    }
    return st;
  }

  function seed(opts){
    opts = opts || {};
    try {
      if(!localStorage.getItem(BACKUP_KEY)){
        var bak = {};
        KEYS.forEach(function(k){ bak[k] = localStorage.getItem(k); });
        localStorage.setItem(BACKUP_KEY, JSON.stringify(bak));
      }
    } catch(e){}

    _seed = 20260905;                              // إعادة البذرة لثبات النتيجة

    var all = ROSTER.map(buildStudent);
    /* حلقتان: المسجد تأخذ عشرة، والأونلاين أربعة — كما هي الحال غالبًا. */
    var circles = [
      { id:1, name:'حلقة المسجد — بعد العصر', icon:'niche',  students: all.slice(0,10), groups:null },
      { id:2, name:'حلقة أونلاين — بعد المغرب', icon:'lantern', students: all.slice(10),  groups:null }
    ];

    try {
      localStorage.setItem('irtaqi-user-type','teacher');
      localStorage.setItem('irtaqi-teacher-gender', opts.female ? 'female' : 'male');
      localStorage.setItem('irtaqi-individual-gender', opts.female ? 'female' : 'male');
      localStorage.setItem('irtaqi-user-name', opts.female ? 'أمّ عبدالله' : 'الشيخ عبدالله');
      localStorage.setItem('irtaqi-teacher-circles', JSON.stringify(circles));
      localStorage.setItem('irtaqi-show-all','1');
    } catch(e){}

    if(typeof _teacherCircles !== 'undefined') _teacherCircles = circles;
    if(typeof _activeCircleId !== 'undefined') _activeCircleId = 1;

    try { applyPersonaVisualIdentity(); } catch(e){}
    try { openTeacherScreen(); selectCircle(1); } catch(e){}
    try {
      showToast('محاكاة: حلقتان و' + toAr(all.length) + ' طالبًا — اضغط «غرفة الحلقة»');
    } catch(e){}
    return summary();
  }

  /** ملخّص نصّيّ لما زُرع — يُطبع في وحدة التحكّم. */
  function summary(){
    if(typeof _teacherCircles === 'undefined') return null;
    var out = [];
    _teacherCircles.forEach(function(c){
      var line = { circle: c.name, students: c.students.length, levels: {} };
      try {
        groupedStudents(c).forEach(function(d){
          if(!d.students.length) return;
          line.levels[d.group.name] = d.students.map(function(st){
            var ps = (typeof planStatus === 'function') ? planStatus(st) : null;
            var pf = (typeof performanceScore === 'function') ? performanceScore(st) : null;
            return st.name + ' — ' + (ps ? ps.label : 'بلا هدف') +
                   (pf ? ' · أداؤه ' + pf.label : '');
          });
        });
      } catch(e){}
      out.push(line);
    });
    return out;
  }

  /** جولة مرشدة: تفتح الشاشات بالترتيب مع شرح قصير. */
  function tour(){
    var steps = [
      ['كشف الحلقة والمستويات', function(){ renderCircleTree(); }],
      ['غرفة الحلقة — الحضور والتسميع', function(){ closeShareSheet(); openAttendanceRoom(); }],
      ['ميزان المستويات والأهداف', function(){ closeShareSheet(); openLevelBenchmark(); }],
      ['بطاقة حصيلة الحلقة', function(){ closeShareSheet(); cardCircleSummary(1); }]
    ];
    var i = 0;
    function next(){
      if(i >= steps.length){ try{ showToast('انتهت الجولة'); }catch(e){} return; }
      var s = steps[i++];
      try { showToast('(' + toAr(i) + '/' + toAr(steps.length) + ') ' + s[0]); } catch(e){}
      try { s[1](); } catch(e){}
      setTimeout(next, 4200);
    }
    next();
  }

  function restore(){
    try {
      var bak = JSON.parse(localStorage.getItem(BACKUP_KEY) || 'null');
      if(!bak){ showToast('لا توجد نسخة سابقة'); return; }
      KEYS.forEach(function(k){
        if(bak[k] === null) localStorage.removeItem(k);
        else localStorage.setItem(k, bak[k]);
      });
      localStorage.removeItem(BACKUP_KEY);
      showToast('أُعيدت بياناتك — أعد فتح التطبيق');
      setTimeout(function(){ location.reload(); }, 900);
    } catch(e){ showToast('تعذّرت الاستعادة'); }
  }

  /* التشغيل بالرابط ‎?demo=1‎ — بطلبٍ صريح لا تلقائيًّا. */
  try {
    var q = new URLSearchParams(location.search);
    if(q.get('demo') === '1'){
      addEventListener('load', function(){
        setTimeout(function(){
          seed({ female: q.get('f') === '1' });
          if(q.get('tour') === '1') setTimeout(tour, 1200);
        }, 1400);
      });
    }
  } catch(e){}

  return { seed:seed, tour:tour, restore:restore, summary:summary, roster:ROSTER };
})();
