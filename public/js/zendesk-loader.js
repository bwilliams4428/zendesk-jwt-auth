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

    // Auto-apply saved locale before firing page callbacks
    var LOCALE_KEY = 'zendeskLocale';
    var savedLocale = localStorage.getItem(LOCALE_KEY) || navigator.language;
    if (savedLocale) {
      document.documentElement.lang = savedLocale;
      if (typeof zE === 'function') {
        try {
          zE('messenger:set', 'locale', savedLocale);
          zE('messenger:set', 'conversationMetadata', { locale: savedLocale });
          console.log('[zendesk-loader] Auto-applied locale: ' + savedLocale);
          // Sync locale to Sunshine user profile (AI Agent reads profile.locale)
          if (typeof window.syncLocaleToSunshine === 'function') {
            // syncLocaleToSunshine is defined below — call after IIFE completes
            setTimeout(function() { window.syncLocaleToSunshine(savedLocale); }, 500);
          }
        } catch (e) {
          console.warn('[zendesk-loader] Locale auto-apply failed: ' + e.message);
        }
      }
    }

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

  // ─── Widget Teardown ──────────────────────────────────────

  /**
   * destroyZendeskWidget() — Fully remove the messaging widget.
   * 1. Calls resetWidget to clear all user data, conversations, and connections
   * 2. Hides the widget
   * 3. Removes the Zendesk script tag and all Zendesk iframes/elements
   * 4. Deletes the global zE function
   * 5. Resets the ready state so the widget can be re-injected later
   */
  window.destroyZendeskWidget = function (callback) {
    console.log('[zendesk-loader] Destroying widget...');

    var cleanup = function () {
      // Hide widget UI
      try { zE('messenger', 'hide'); } catch (e) { /* ignore */ }

      // Remove Zendesk script tag
      var script = document.getElementById('ze-snippet');
      if (script) script.remove();

      // Remove all Zendesk iframes and injected DOM elements
      var zendeskElements = document.querySelectorAll(
        '[id^="zendesk-"], [class*="zendesk-"], [id*="WebWidget"], [class*="zE-"], ' +
        'iframe[src*="zendesk"], iframe[src*="zdassets"], iframe[src*="static.zdassets"]'
      );
      zendeskElements.forEach(function (el) { el.remove(); });

      // Remove stylesheet links injected by Zendesk
      var zendeskStyles = document.querySelectorAll('link[href*="zdassets"], link[href*="zendesk"]');
      zendeskStyles.forEach(function (el) { el.remove(); });

      // Delete global zE so the widget is fully gone
      delete window.zE;

      // Reset ready state so widget can be re-initialized later
      window._zendeskReady = false;
      window._zendeskReadyCallbacks = [];

      console.log('[zendesk-loader] Widget destroyed and removed from DOM');
      if (typeof callback === 'function') callback();
    };

    // Step 1: Reset widget state (clears conversations, user data, connections)
    if (typeof zE === 'function') {
      try {
        zE('messenger', 'resetWidget', function () {
          console.log('[zendesk-loader] resetWidget completed');
          cleanup();
        });
      } catch (e) {
        console.warn('[zendesk-loader] resetWidget failed, falling back to cleanup:', e.message);
        cleanup();
      }
    } else {
      console.log('[zendesk-loader] zE not available, skipping resetWidget');
      cleanup();
    }
  };

  function injectWidget(key) {
    console.log('[zendesk-loader] Loading widget for key: ' + key.slice(0, 8) + '...');

    // ── Set locale BEFORE widget loads ──────────────────────────
    // Zendesk docs: "This code should be placed immediately after
    // the messaging Web Widget code snippet." The widget reads
    // zESettings.webWidget.locale at init time, which is BEFORE
    // any zE() calls can be made. This is the only reliable way
    // to control the AI Agent's response language.
    var savedLocale = localStorage.getItem('zendeskLocale') || navigator.language || 'en-US';
    window.zESettings = window.zESettings || {};
    window.zESettings.webWidget = window.zESettings.webWidget || {};
    window.zESettings.webWidget.locale = savedLocale;
    console.log('[zendesk-loader] Set zESettings.webWidget.locale = ' + savedLocale);

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

  // ─── Sunshine Conversations Locale Sync ──────────────────────

  /**
   * syncLocaleToSunshine — Update the Sunshine Conversations user profile locale.
   *
   * The Zendesk AI Agent reads locale from the Sunshine user profile object.
   * This calls PATCH /api/user/locale to update profile.locale, which the
   * AI Agent then uses for its response language.
   *
   * Uses the same Key ID (kid) and Secret (jwtSecret) from the setup page
   * config, plus the Zendesk subdomain (account).
   */
  window.syncLocaleToSunshine = function (locale) {
    var userData = localStorage.getItem('userData');
    if (!userData) {
      console.log('[zendesk-loader] Cannot sync locale to Sunshine: no user logged in');
      return;
    }
    var user = JSON.parse(userData);
    if (!user || !user.id) {
      console.log('[zendesk-loader] Cannot sync locale to Sunshine: no user ID');
      return;
    }

    var config = getConfig();
    if (!config || !config.kid || !config.jwtSecret) {
      console.warn('[zendesk-loader] Cannot sync locale to Sunshine: missing Key ID or Secret in config');
      return;
    }
    if (!config.account) {
      console.warn('[zendesk-loader] Cannot sync locale to Sunshine: missing Zendesk subdomain in config');
      return;
    }

    var body = {
      userId: user.id,
      locale: locale,
      kid: config.kid,
      jwtSecret: config.jwtSecret,
      account: config.account,
    };

    console.log('[zendesk-loader] Syncing locale to Sunshine profile for user ' + user.id + '...');

    fetch(window.location.origin + '/api/user/locale', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    .then(function (resp) { return resp.json(); })
    .then(function (data) {
      if (data.status === 'success') {
        console.log('[zendesk-loader] ✓ Sunshine user locale updated: ' + data.locale);
      } else {
        console.warn('[zendesk-loader] ✗ Sunshine locale sync failed: ' + (data.message || JSON.stringify(data)));
      }
    })
    .catch(function (err) {
      console.warn('[zendesk-loader] ✗ Sunshine locale sync error: ' + err.message);
    });
  };
})();