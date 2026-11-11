/* DiskLens 关于对话框 —— 版本号（动态读取自 Tauri）、项目主页、开源仓库、
   问题反馈、更新日志、检查更新入口。双入口：顶栏品牌点击 + 页脚「关于」。
   链接用 opener 打开系统浏览器；浏览器模式回退 window.open。 */

(function () {
  var TAURI = !!window.__TAURI__;
  var URLS = {
    home:   'https://ikanp.top/disklens/',
    github: 'https://github.com/AriesYB/disklens',
    issues: 'https://github.com/AriesYB/disklens/issues',
    rel:    'https://github.com/AriesYB/disklens/releases',
    site:   'https://ikanp.top'
  };

  function $(id) { return document.getElementById(id); }
  function openUrl(url) {
    try {
      if (TAURI && window.__TAURI__.opener && window.__TAURI__.opener.openUrl) {
        window.__TAURI__.opener.openUrl(url);
        return;
      }
    } catch (e) {}
    window.open(url, '_blank', 'noopener');
  }
  function openAbout() {
    $('about-mask').style.display = 'flex';
    loadVersion();
  }
  function closeAbout() { $('about-mask').style.display = 'none'; }

  function loadVersion() {
    var el = $('about-ver');
    el.textContent = 'v1.1.0';   // 兜底
    if (TAURI && window.__TAURI__.app && window.__TAURI__.app.getVersion) {
      window.__TAURI__.app.getVersion().then(function (v) {
        if (v) el.textContent = 'v' + v;
      }).catch(function () {});
    }
  }

  window.addEventListener('DOMContentLoaded', function () {
    $('brand').addEventListener('click', openAbout);
    $('foot-about').addEventListener('click', openAbout);
    $('about-close').addEventListener('click', closeAbout);
    $('about-mask').addEventListener('mousedown', function (ev) {
      if (ev.target === $('about-mask')) closeAbout();
    });
    $('about-home').addEventListener('click', function () { openUrl(URLS.home); });
    $('about-github').addEventListener('click', function () { openUrl(URLS.github); });
    $('about-issues').addEventListener('click', function () { openUrl(URLS.issues); });
    $('about-rel').addEventListener('click', function () { openUrl(URLS.rel); });
    $('about-site').addEventListener('click', function () { openUrl(URLS.site); });
    // 检查更新：复用顶栏按钮（浏览器模式无此按钮，隐藏入口）
    var checkBtn = $('about-check');
    if (document.getElementById('upd-btn')) {
      checkBtn.addEventListener('click', function () {
        closeAbout();
        document.getElementById('upd-btn').click();
      });
    } else {
      checkBtn.style.display = 'none';
    }
    // Esc 关闭（capture 拦截，避免同时触发 treemap 的"收起展开"）
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && $('about-mask').style.display === 'flex') {
        e.stopImmediatePropagation();
        closeAbout();
      }
    }, true);
  });
})();
