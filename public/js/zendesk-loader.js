/**
 * Zendesk Widget Loader — Dynamic & Ephemeral
 *
 * Reads the widget key from sessionStorage (set by /setup.html)
 * or falls back to the server env config. Never persists to disk.
 */
(function () {
  var STORAGE_KEY = 'zendesk_config';

  function getConfig() {
    try {
      var stored = sessionStorage.getItem(STORAGE_KEY);
      if (stored) return JSON.parse(stored);
    } catch (e) { /* ignore */ }
    return null;
  }

  function notifyReady() {
    if (typeof window._zendeskReadyCallbacks === 'undefined') {
      window._zendeskReadyCallbacks = [];
    }
    window._zendeskReady = true;
    window._zendeskReadyCallbacks.forEach(function (fn) { fn(); });
    window._zendeskReadyCallbacks = [];
  }

  window.onZendeskWidgetReady = function (fn) {
    if (window._zendeskReady) {
      fn();
    } else {
      if (typeof window._zendeskReadyCallbacks === 'undefined') {
        window._zendeskReadyCallbacks = [];
      }
      window._zendeskReadyCallbacks.push(fn);
    }
  };

  // Try sessionStorage first, then server
  var localConfig = getConfig();
  var widgetKey = localConfig ? localConfig.widgetKey : null;

  if (widgetKey) {
    injectWidget(widgetKey);
  } else {
    // Fall back to server env config
    fetch(window.location.origin + '/api/config/widget-key')
      .then(function (res) {
        if (!res.ok) throw new Error('Not configured');
        return res.json();
      })
      .then(function (data) {
        if (data.widgetKey) {
          injectWidget(data.widgetKey);
        }
      })
      .catch(function () {
        console.warn('[zendesk-loader] No widget key found — visit /setup.html to configure.');
        var notice = document.getElementById('widget-notice');
        if (notice) {
          notice.textContent = '⚠️ Zendesk widget not configured. Visit /setup.html to enter your credentials.';
          notice.style.display = 'block';
        }
      });
  }

  function injectWidget(key) {
    console.log('[zendesk-loader] Loading widget for key: ' + key.slice(0, 8) + '...');
    var script = document.createElement('script');
    script.id = 'ze-snippet';
    script.src = 'https://static.zdassets.com/ekr/snippet.js?key=' + key;
    script.async = true;
    script.onload = function () {
      var attempts = 0;
      var check = setInterval(function () {
        attempts++;
        if (typeof zE === 'function') {
          clearInterval(check);
          console.log('[zendesk-loader] Widget ready');
          notifyReady();
        } else if (attempts > 60) {
          clearInterval(check);
          console.warn('[zendesk-loader] Widget load timeout');
        }
      }, 250);
    };
    script.onerror = function () {
      console.error('[zendesk-loader] Failed to load Zendesk script');
    };
    document.head.appendChild(script);
  }
})();