/* ============================================================
   寻迹 · 官网
   ------------------------------------------------------------
   四件事：主题切换、滚动揭示、角色切换、行内工具条。
   没有依赖，纯原生。
   ============================================================ */
(function () {
  'use strict';

  var root = document.documentElement;

  /* ---------- 主题：跟随系统，用户选择后记住 ---------- */
  var THEME_KEY = 'ct.site.theme';

  function applyTheme(t) {
    root.setAttribute('data-theme', t);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#1e1c19' : '#f3efe4');
  }

  try {
    var saved = localStorage.getItem(THEME_KEY);
    applyTheme(
      saved ||
        (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    );
  } catch (e) {
    applyTheme('light');
  }

  var themeBtn = document.getElementById('themeBtn');
  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch (e) {
        /* 存不了就算了，本次会话内仍然生效 */
      }
    });
  }

  /* ---------- 移动端导航 ---------- */
  var menuBtn = document.getElementById('menuBtn');
  var topnav = document.getElementById('topnav');
  if (menuBtn && topnav) {
    menuBtn.addEventListener('click', function () {
      var open = topnav.classList.toggle('is-open');
      menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    // 点导航项后收起
    topnav.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') {
        topnav.classList.remove('is-open');
        menuBtn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  /* ---------- 顶栏：滚过顶部加一道线 ---------- */
  var topbar = document.getElementById('topbar');
  if (topbar) {
    var onScroll = function () {
      topbar.classList.toggle('is-stuck', window.scrollY > 8);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /* ---------- 滚动揭示 ---------- */
  var reveals = Array.prototype.slice.call(document.querySelectorAll('.reveal'));
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-in');
            io.unobserve(entry.target);
          }
        });
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.08 }
    );
    reveals.forEach(function (el) {
      io.observe(el);
    });
  } else {
    reveals.forEach(function (el) {
      el.classList.add('is-in');
    });
  }

  /* ---------- 五个角色 ----------
     每个角色有自己的脾气和分工。
     这里只说它「擅长什么、什么语气、什么时候找它」——
     参数是产品内部的事，客户不需要看见。 */
  var ROLES = {
    writer: {
      name: '作家',
      desc: '起稿、续写场景、扩写描写。文学性优先，重视画面与节奏。',
      good: '起稿 · 续写 · 扩写',
      voice: '画面优先，先给感觉',
      when: '卡住了，或者想一次写完一段',
      note: '发散最狠的那个。给它一句话，它能还你三种开头。',
    },
    editor: {
      name: '编辑',
      desc: '改写、润色、删冗余、调节奏。克制，会解释改了哪里、为什么这么改。',
      good: '改写 · 润色 · 精简',
      voice: '克制，改完会说明理由',
      when: '写完了，但读着还差点意思',
      note: '它不推翻你的句子，只让它站得更稳。改完会告诉你动过哪几处。',
    },
    critic: {
      name: '审稿人',
      desc: '找逻辑漏洞、找设定冲突、找重复表达。直率，列条目，不客气。',
      good: '找漏洞 · 找冲突 · 找重复',
      voice: '直率，一条条列，不绕弯',
      when: '准备发出去之前',
      note: '唯一会跟你唱反调的角色。列出来的问题，都指向具体的某一句。',
    },
    inspiler: {
      name: '灵感师',
      desc: '情节走向、人物动机、冲突设计、反转。发散，给多个方向而不是单一答案。',
      good: '情节走向 · 人物动机 · 反转',
      voice: '发散，一次给你几个方向',
      when: '不知道下一场该怎么写',
      note: '你给它半个想法，它还你三个故事。挑一个，或者都不要。',
    },
    researcher: {
      name: '资料员',
      desc: '搜站内素材、搜网络、汇总并标注来源。只讲有来源的，没来源就直说。',
      good: '搜素材 · 标来源',
      voice: '只讲有出处的',
      when: '需要一件真事来撑起细节',
      note: '它不创作，只核实。没有来源它会说没有，不拿编的充数。',
    },
  };

  var roleRow = document.getElementById('roleRow');
  var rdName = document.getElementById('rdName');
  var rdDesc = document.getElementById('rdDesc');
  var rdGood = document.getElementById('rdGood');
  var rdVoice = document.getElementById('rdVoice');
  var rdWhen = document.getElementById('rdWhen');
  var rdNote = document.getElementById('rdNote');

  if (roleRow) {
    roleRow.addEventListener('click', function (e) {
      var card = e.target.closest('.role-card');
      if (!card) return;
      var key = card.getAttribute('data-role');
      var r = ROLES[key];
      if (!r) return;

      Array.prototype.forEach.call(roleRow.querySelectorAll('.role-card'), function (c) {
        var on = c === card;
        c.classList.toggle('is-on', on);
        c.setAttribute('aria-selected', on ? 'true' : 'false');
      });

      // 换字时轻轻淡出一下，读起来有节奏
      var detail = document.getElementById('roleDetail');
      if (detail) {
        detail.style.transition = 'opacity .16s ease';
        detail.style.opacity = '0.35';
      }
      window.setTimeout(function () {
        rdName.textContent = r.name;
        rdDesc.textContent = r.desc;
        rdGood.textContent = r.good;
        rdVoice.textContent = r.voice;
        rdWhen.textContent = r.when;
        rdNote.textContent = r.note;
        if (detail) {
          detail.style.opacity = '1';
          window.setTimeout(function () {
            detail.style.transition = '';
          }, 220);
        }
      }, 160);
    });
  }

  /* ---------- 行内工具条 ----------
     真的能改：点了就把那句话换掉，不是假的按钮。 */
  var SEL_ORIGINAL =
    '她没有立刻往前走，只是站在原地，看着那盏灯，像在等什么人先开口。';

  var REWRITES = {
    rewrite:
      '她没有立刻往前走，只是站在原地，盯着那盏灯，像在等什么人先开口。',
    expand:
      '她没有立刻往前走，只是站在原地，盯着那盏灯——灯芯被雨压得忽明忽暗，' +
      '她把湿透的袖口攥紧了一点，像在等什么人先开口。',
    shrink: '她停下，盯着那盏灯，等谁先开口。',
    critic:
      '「看着那盏灯」与上一场「盯着巷口」重复；「等什么人先开口」信息量为零，' +
      '读者不知道她在等谁。',
  };

  var sel = document.getElementById('msSel');
  var toolbar = document.getElementById('msToolbar');
  var msgBody = document.getElementById('msMsgBody');
  var msgWho = document.querySelector('.ms-msg-who');

  if (toolbar && sel) {
    toolbar.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      var text = REWRITES[act];
      if (!text) return;

      // 保留末尾的朱笔圈点
      var mark = sel.querySelector('.ms-mark');
      sel.textContent = text;
      if (mark) sel.appendChild(mark);

      // 改写后不再高亮，像已经落笔
      sel.classList.add('is-done');
      sel.style.background = 'transparent';
      sel.style.boxShadow = 'none';
      sel.style.color = '';

      if (msgWho) {
        msgWho.textContent = act === 'critic' ? '审稿人' : '编辑';
      }
      if (msgBody) {
        var replies = {
          rewrite: '换掉了。「盯着」比「看着」更具体，也更冷——雨夜里本来就没人在看什么。',
          expand: '补了灯芯和袖口两个细节。节奏是慢的，你确认一下是不是想要的慢。',
          shrink: '压到最短。省掉了所有修饰，剩下的是动作。',
          critic: '两条问题都列在这儿了。第二条要改的话，得知道她在等谁。',
        };
        msgBody.textContent = replies[act] || '';
      }
    });
  }

  /* ---------- 引用角标：点一下标出「已定位」 ---------- */
  var cites = Array.prototype.slice.call(document.querySelectorAll('.cite'));
  cites.forEach(function (c) {
    c.addEventListener('click', function () {
      cites.forEach(function (x) {
        x.style.borderColor = '';
        x.style.color = '';
        x.style.background = '';
      });
      c.style.borderColor = 'var(--cinnabar)';
      c.style.color = 'var(--cinnabar)';
      c.style.background = 'var(--cinnabar-dim)';
    });
  });
})();
