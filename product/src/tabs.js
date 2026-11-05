/* Shared tab strip for the Local Assistant pages.
 *
 * The same file ships in the static folder and inside the WordPress plugin, so
 * both present one page with the same tabs. The page is complete without it:
 * every panel is already in the document and each tab is a real anchor, so a
 * browser that never runs this file still shows all sections and can jump to
 * each one. With it, only the selected panel shows and the hash is kept in step.
 */
(function () {
  'use strict';

  var groups = document.querySelectorAll('[data-tabs]');
  if (!groups.length) return;

  Array.prototype.forEach.call(groups, function (group) {
    var tabs = Array.prototype.slice.call(group.querySelectorAll('[data-tab]'));
    if (!tabs.length) return;

    var ids = tabs.map(function (tab) { return tab.getAttribute('data-tab'); });
    var panels = ids.map(function (id) { return document.getElementById(id); });

    group.classList.add('is-tabbed');

    function indexOf(id) { return ids.indexOf(id); }

    function show(id, options) {
      var wanted = indexOf(id);
      if (wanted < 0) wanted = 0;

      tabs.forEach(function (tab, i) {
        var on = i === wanted;
        tab.classList.toggle('is-on', on);
        tab.setAttribute('aria-selected', on ? 'true' : 'false');
        tab.setAttribute('tabindex', on ? '0' : '-1');
        if (panels[i]) panels[i].hidden = !on;
      });

      if (!options || options.updateHash !== false) {
        var hash = '#' + ids[wanted];
        if (window.location.hash !== hash) {
          window.history.replaceState(null, '', hash);
        }
      }
    }

    tabs.forEach(function (tab, i) {
      tab.addEventListener('click', function (event) {
        event.preventDefault();
        show(ids[i]);
        if (panels[i]) panels[i].focus({ preventScroll: true });
      });

      tab.addEventListener('keydown', function (event) {
        var next = null;
        if (event.key === 'ArrowRight') next = (i + 1) % tabs.length;
        else if (event.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = tabs.length - 1;
        if (next === null) return;
        event.preventDefault();
        show(ids[next]);
        tabs[next].focus();
      });
    });

    window.addEventListener('hashchange', function () {
      var id = window.location.hash.replace('#', '');
      if (indexOf(id) >= 0) show(id, { updateHash: false });
    });

    // A hash in the address wins, so a link to #install opens Install. When
    // there is none, the page can name its opening tab: a settings save on
    // WordPress redirects back without a fragment.
    var hash = window.location.hash.replace('#', '');
    var fallback = group.getAttribute('data-tab-start') || ids[0];
    var start = indexOf(hash) >= 0 ? hash : (indexOf(fallback) >= 0 ? fallback : ids[0]);
    show(start, { updateHash: false });

    panels.forEach(function (panel) {
      if (panel) panel.setAttribute('tabindex', '-1');
    });
  });
})();
