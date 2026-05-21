/**
 * Zendesk JWT Authentication - Client-side JavaScript
 *
 * Credentials are stored in browser sessionStorage ONLY.
 * They are sent with each API request (never saved server-side)
 * and vanish when the tab is closed.
 */

var API_BASE_URL = window.location.origin;
var STORAGE_KEY = 'zendesk_config';

// Debug logging
var DEBUG = true;
function log(message, type) {
    type = type || 'info';
    var timestamp = new Date().toLocaleTimeString();

    if (DEBUG) {
        var emoji = type === 'error' ? '🔴' : type === 'success' ? '🟢' : '🔵';
        console.log(emoji + ' [' + timestamp + '] ' + message);
    }

    var debugLog = document.getElementById('debugLog');
    if (debugLog) {
        var color = type === 'error' ? '#ff6b6b' : type === 'success' ? '#51cf66' : '#d4d4d4';
        var line = document.createElement('div');
        line.style.color = color;
        line.style.marginBottom = '2px';
        line.style.fontSize = '11px';
        line.textContent = '[' + timestamp + '] ' + message;
        debugLog.appendChild(line);
        debugLog.scrollTop = debugLog.scrollHeight;

        while (debugLog.children.length > 100) {
            debugLog.removeChild(debugLog.firstChild);
        }
    }
}

// ─── Session Config (ephemeral — sessionStorage only) ────────

function getConfig() {
    try {
        var stored = sessionStorage.getItem(STORAGE_KEY);
        return stored ? JSON.parse(stored) : null;
    } catch (e) { return null; }
}

// ─── Session Storage ──────────────────────────────────────────

function isLoggedIn() {
    return localStorage.getItem('userData') !== null;
}

function getUserData() {
    var data = localStorage.getItem('userData');
    return data ? JSON.parse(data) : null;
}

function saveUserData(userData) {
    localStorage.setItem('userData', JSON.stringify(userData));
}

function clearUserData() {
    localStorage.removeItem('userData');
}

// ─── Status Updates ────────────────────────────────────────────

function showError(message) {
    var errorElement = document.getElementById('errorMessage');
    if (errorElement) {
        errorElement.textContent = message;
        errorElement.classList.add('show');
        setTimeout(function () { errorElement.classList.remove('show'); }, 5000);
    }
}

function updateAuthStatus(status, message) {
    var statusBadge = document.getElementById('authStatus');
    var statusText = document.getElementById('authStatusText');

    if (statusBadge && statusText) {
        statusBadge.className = 'status-badge ' + status;
        statusText.textContent = message;
        log('Status: ' + message, status === 'authenticated' ? 'success' : 'info');
    }
}

// ─── JWT Token ─────────────────────────────────────────────────

async function fetchFreshJwtToken(userData) {
    var config = getConfig();
    if (!config || !config.jwtSecret || !config.kid) {
        log('No credentials — visit /setup.html first', 'error');
        return null;
    }

    try {
        log('Requesting fresh JWT token from server...');

        var response = await fetch(API_BASE_URL + '/api/auth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: userData.id,
                email: userData.email,
                name: userData.name,
                jwtSecret: config.jwtSecret,
                kid: config.kid
            })
        });

        if (!response.ok) {
            var errorText = await response.text();
            throw new Error('Server error: ' + response.status + ' - ' + errorText);
        }

        var data = await response.json();

        if (data.status === 'success' && data.token) {
            log('Fresh JWT token received', 'success');
            return data.token;
        } else {
            throw new Error(data.message || 'Token generation failed');
        }
    } catch (error) {
        log('Token fetch error: ' + error.message, 'error');
        return null;
    }
}

// ─── Zendesk Authentication ────────────────────────────────────

async function setupZendeskAuthentication() {
    var userData = getUserData();

    if (!userData) {
        log('No user data - cannot authenticate', 'error');
        updateAuthStatus('unauthenticated', 'Not logged in');
        return;
    }

    if (typeof zE !== 'function') {
        log('zE not available - widget not loaded (check /setup.html)', 'error');
        updateAuthStatus('unauthenticated', 'Widget not loaded');
        return;
    }

    updateAuthStatus('pending', 'Setting up authentication...');

    try {
        log('Configuring Zendesk widget authentication...');

        zE('messenger', 'loginUser', async function requestToken(callback) {
            log('Zendesk requesting JWT token...');

            var token = await fetchFreshJwtToken(userData);

            if (token) {
                log('Providing fresh JWT token to Zendesk', 'success');
                callback(token);
                updateAuthStatus('authenticated', 'Authenticated with JWT');
            } else {
                log('Failed to get token - authentication will fail', 'error');
                callback(null);
                updateAuthStatus('error', 'Authentication failed');
            }
        });

        log('Widget authentication configured', 'success');

    } catch (error) {
        log('Authentication setup error: ' + error.message, 'error');
        updateAuthStatus('error', 'Setup failed: ' + error.message);
    }
}

// ─── Page Routing ─────────────────────────────────────────────

async function handleLogin(event) {
    event.preventDefault();

    var email = document.getElementById('email').value.trim();
    var password = document.getElementById('password').value;
    var button = document.getElementById('loginButton');

    if (!email || !password) {
        showError('Please enter both email and password');
        return;
    }

    button.disabled = true;
    button.textContent = 'Signing in...';

    try {
        var response = await fetch(API_BASE_URL + '/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email, password: password })
        });

        var data = await response.json();

        if (data.status === 'success' && data.user) {
            saveUserData(data.user);
            log('Login successful', 'success');
            window.location.href = 'index.html';
        } else {
            showError(data.message || 'Login failed');
        }
    } catch (error) {
        log('Login error: ' + error.message, 'error');
        showError('Login failed — check if server is running');
    } finally {
        button.disabled = false;
        button.textContent = 'Sign In';
    }
}

async function handleLogout() {
    log('Logging out...');

    if (typeof zE === 'function') {
        try { zE('messenger', 'logoutUser'); log('Widget logout successful'); }
        catch (error) { log('Widget logout error: ' + error.message, 'error'); }
    }

    clearUserData();
    window.location.href = 'login.html';
}

// ─── Initialization ────────────────────────────────────────────

function initLoginPage() {
    log('Login page init');

    var emailInput = document.getElementById('email');
    var passwordInput = document.getElementById('password');

    if (emailInput) emailInput.value = 'user@example.com';
    if (passwordInput) passwordInput.value = 'password123';

    var form = document.getElementById('loginForm');
    if (form) { form.addEventListener('submit', handleLogin); }
}

function initDashboardPage() {
    log('Dashboard init');

    var userData = getUserData();

    if (!userData) {
        log('No user session — redirecting to login');
        window.location.href = 'login.html';
        return;
    }

    var elements = {
        displayName: document.getElementById('displayName'),
        displayEmail: document.getElementById('displayEmail'),
        userName: document.getElementById('userName'),
        userEmail: document.getElementById('userEmail'),
        userId: document.getElementById('userId')
    };

    if (elements.displayName) elements.displayName.textContent = userData.name;
    if (elements.displayEmail) elements.displayEmail.textContent = userData.email;
    if (elements.userName) elements.userName.textContent = userData.name;
    if (elements.userEmail) elements.userEmail.textContent = userData.email;
    if (elements.userId) elements.userId.textContent = userData.id;

    log('User: ' + userData.name + ' (' + userData.email + ')');

    var logoutBtn = document.getElementById('logoutButton');
    var authBtn = document.getElementById('authWidgetBtn');
    var testBtn = document.getElementById('testWidgetBtn');

    if (logoutBtn) logoutBtn.addEventListener('click', handleLogout);
    if (authBtn) authBtn.addEventListener('click', setupZendeskAuthentication);
    if (testBtn) testBtn.addEventListener('click', function () {
        if (typeof zE === 'function') { log('✓ zE is available', 'success'); }
        else { log('✗ zE not defined', 'error'); }
    });

    if (typeof onZendeskWidgetReady === 'function') {
        onZendeskWidgetReady(function () {
            log('✓ Widget ready, setting up auth', 'success');
            setupZendeskAuthentication();
        });
    } else {
        var attempts = 0;
        var check = setInterval(function () {
            attempts++;
            if (typeof zE === 'function') {
                clearInterval(check);
                log('✓ Zendesk widget loaded', 'success');
                setupZendeskAuthentication();
            } else if (attempts > 50) {
                clearInterval(check);
                log('✗ Widget load timeout', 'error');
            }
        }, 200);
    }
}

function init() {
    var currentPage = window.location.pathname.split('/').pop() || 'index.html';

    if (currentPage === 'login.html' || currentPage === '') {
        initLoginPage();
    } else if (currentPage === 'setup.html') {
        // Setup page has its own JS
    } else {
        initDashboardPage();
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

// Expose for debugging
window.zendeskAuthDebug = {
    getUserData: getUserData,
    getConfig: getConfig,
    fetchFreshJwtToken: fetchFreshJwtToken,
    setupZendeskAuthentication: setupZendeskAuthentication,
    log: log
};