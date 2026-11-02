/* ============================================================
   寻迹 · 帮助中心站内搜索
   ------------------------------------------------------------
   首次搜索时抓取各文章页正文，内存里建索引；不做构建期索引，
   避免文章改完后索引忘了更新。抓取失败时退化为标题搜索。
   ============================================================ */
(function () {
  'use strict';

  var input = document.getElementById('helpSearch');
  var results = document.getElementById('helpResults');
  if (!input || !results) return;

  var cards = Array.prototype.slice.call(document.querySelectorAll('.help-card'));
  var urls = cards.map(function (c) {
    return c.getAttribute('data-url');
  });
  var titleOnly = cards.map(function (c) {
    return {
      url: c.getAttribute('data-url') || '#',
      title: c.getAttribute('data-title') || '',
      category: c.getAttribute('data-category') || '',
      text: '',
      snippet: '',
    };
  });

  var fullIndex = null;
  var loading = null;

  function loadIndex() {
    if (fullIndex) return Promise.resolve(fullIndex);
    if (loading) return loading;

    loading = Promise.all(
      urls.map(function (url) {
        return fetch(url)
          .then(function (res) {
            if (!res.ok) throw new Error(String(res.status));
            return res.text();
          })
          .then(function (html) {
            var doc = new DOMParser().parseFromString(html, 'text/html');
            var art = doc.querySelector('.help-article');
            if (!art) return null;
            var pager = art.querySelector('.help-pager');
            if (pager) pager.remove();
            var h1 = art.querySelector('h1');
            var kicker = art.querySelector('.help-kicker');
            return {
              url: url,
              title: h1 ? h1.textContent.trim() : '',
              category: kicker ? kicker.textContent.trim() : '',
              text: art.textContent.replace(/\s+/g, ' ').trim(),
              snippet: '',
            };
          })
          .catch(function () {
            return null;
          });
      })
    ).then(function (items) {
      fullIndex = items.filter(Boolean);
      return fullIndex;
    });

    return loading;
  }

  function escapeHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function makeSnippet(text, q) {
    var at = text.toLowerCase().indexOf(q);
    if (at < 0) return escapeHtml(text.slice(0, 72));
    var start = Math.max(0, at - 28);
    var end = Math.min(text.length, at + q.length + 44);
    var piece = text.slice(start, end);
    var marked =
      escapeHtml(piece.slice(0, at - start)) +
      '<mark>' +
      escapeHtml(piece.slice(at - start, at - start + q.length)) +
      '</mark>' +
      escapeHtml(piece.slice(at - start + q.length));
    return (start > 0 ? '…' : '') + marked + (end < text.length ? '…' : '');
  }

  function render(q) {
    q = q.trim();
    if (!q) {
      results.hidden = true;
      results.innerHTML = '';
      return;
    }

    var needle = q.toLowerCase();
    var source = fullIndex && fullIndex.length ? fullIndex : titleOnly;
    var hits = source.filter(function (item) {
      return (
        (item.title + ' ' + item.category + ' ' + item.text)
          .toLowerCase()
          .indexOf(needle) >= 0
      );
    });

    results.hidden = false;

    if (!fullIndex && !hits.length) {
      results.innerHTML = '<p class="help-search-empty">正在搜索全文…</p>';
      return;
    }
    if (!hits.length) {
      results.innerHTML =
        '<p class="help-search-empty">没有找到相关条目，换个关键词试试，或从下面的分类进入。</p>';
      return;
    }

    results.innerHTML = hits
      .slice(0, 8)
      .map(function (item) {
        var snip = item.text ? makeSnippet(item.text, needle) : escapeHtml(item.title);
        return (
          '<a class="help-result" href="' +
          item.url +
          '">' +
          '<span class="help-result-cat">' +
          escapeHtml(item.category) +
          '</span>' +
          '<strong>' +
          escapeHtml(item.title) +
          '</strong>' +
          '<span class="help-result-snip">' +
          snip +
          '</span>' +
          '</a>'
        );
      })
      .join('');
  }

  var timer = null;
  input.addEventListener('input', function () {
    var q = input.value;
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      render(q);
    }, 120);
    loadIndex().then(function () {
      if (input.value === q) render(q);
    });
  });

  input.addEventListener('focus', function () {
    loadIndex();
  });
})();
