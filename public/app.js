/**
 * Zendesk JWT Authentication - Client-side JavaScript
 * 
 * CRITICAL: The JWT token MUST be generated fresh when zE calls the loginUser callback.
 * Do NOT generate the token ahead of time - it must be requested at the moment of authentication.
 * 
 * Required JWT claims per Zendesk:
 * - iat: Issued at timestamp (REQUIRED)
 * - name: User's full name (REQUIRED)  
 * - email: User's email address (REQUIRED)
 * - external_id: Unique identifier from your system (REQUIRED)
 * - email_verified: Boolean indicating if email is verified (REQUIRED for verification)
 * - exp: Expiration timestamp (optional but recommended)
 */

// API base URL
const API_BASE_URL = window.location.origin;

// Debug logging
const DEBUG = true;
function log(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    const prefix = `[${timestamp}]`;
    
    if (DEBUG) {
        const emoji = type === 'error' ? '🔴' : type === 'success' ? '🟢' : '🔵';
        console.log(`${emoji} ${prefix} ${message}`);
    }
    
    const debugLog = document.getElementById('debugLog');
    if (debugLog) {
        const color = type === 'error' ? '#ff6b6b' : type === 'success' ? '#51cf66' : '#d4d4d4';
        const line = document.createElement('div');
        line.style.color = color;
        line.style.marginBottom = '2px';
        line.style.fontSize = '11px';
        line.textContent = `${prefix} ${message}`;
        debugLog.appendChild(line);
        debugLog.scrollTop = debugLog.scrollHeight;
        
        // Limit log size
        while (debugLog.children.length > 100) {
            debugLog.removeChild(debugLog.firstChild);
        }
    }
}

// Demo credentials
const DEMO_CREDENTIALS = {
    email: 'user@example.com',
    password: 'password123'
};

function isLoggedIn() {
    return localStorage.getItem('userData') !== null;
}

function getUserData() {
    const data = localStorage.getItem('userData');
    return data ? JSON.parse(data) : null;
}

function saveUserData(userData) {
    localStorage.setItem('userData', JSON.stringify(userData));
}

function clearUserData() {
    localStorage.removeItem('userData');
}

function showError(message) {
    const errorElement = document.getElementById('errorMessage');
    if (errorElement) {
        errorElement.textContent = message;
        errorElement.classList.add('show');
        setTimeout(() => {
            errorElement.classList.remove('show');
        }, 5000);
    }
}

function updateAuthStatus(status, message) {
    const statusBadge = document.getElementById('authStatus');
    const statusText = document.getElementById('authStatusText');
    
    if (statusBadge && statusText) {
        statusBadge.className = 'status-badge ' + status;
        statusText.textContent = message;
        log(`Status: ${message}`, status === 'authenticated' ? 'success' : 'info');
    }
}

/**
 * Fetch fresh JWT token from server
 * CRITICAL: Must be called at authentication time, not before
 */
async function fetchFreshJwtToken(userData) {
    try {
        log('Requesting fresh JWT token from server...');
        
        const response = await fetch(`${API_BASE_URL}/api/auth/token`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                userId: userData.id,
                email: userData.email,
                name: userData.name
            })
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Server error: ${response.status} - ${errorText}`);
        }
        
        const data = await response.json();
        
        if (data.status === 'success' && data.token) {
            log('Fresh JWT token received', 'success');
            return data.token;
        } else {
            throw new Error(data.message || 'Token generation failed');
        }
    } catch (error) {
        log(`Token fetch error: ${error.message}`, 'error');
        return null;
    }
}

/**
 * Set up Zendesk widget authentication
 * 
 * IMPORTANT: The zE('messenger', 'loginUser') must be called with a function
 * that fetches a FRESH token when invoked. Pre-generating the token will fail.
 */
async function setupZendeskAuthentication() {
    const userData = getUserData();
    
    if (!userData) {
        log('No user data - cannot authenticate', 'error');
        updateAuthStatus('unauthenticated', 'Not logged in');
        return;
    }
    
    if (typeof zE !== 'function') {
        log('zE not available - widget not loaded', 'error');
        updateAuthStatus('unauthenticated', 'Widget not loaded');
        return;
    }
    
    updateAuthStatus('pending', 'Setting up authentication...');
    
    try {
        log('Configuring Zendesk widget authentication...');
        
        // THIS IS THE CRITICAL PART:
        // The loginUser callback is invoked by Zendesk when authentication is needed
        // We MUST return a fresh token at that moment
        zE('messenger', 'loginUser', async function requestToken(callback) {
            log('Zendesk requesting JWT token...');
            
            // Fetch a FRESH token at the moment of authentication
            const token = await fetchFreshJwtToken(userData);
            
            if (token) {
                log('Providing fresh JWT token to Zendesk', 'success');
                // Pass the token to Zendesk via the callback
                callback(token);
                updateAuthStatus('authenticated', 'Authenticated with JWT');
            } else {
                log('Failed to get token - authentication will fail', 'error');
                // Call with null to indicate failure
                callback(null);
                updateAuthStatus('error', 'Authentication failed');
            }
        });
        
        // Also set conversation fields to pass user info
        zE('messenger:set', {
            conversationFields: [
                { id: 'name', value: userData.name },
                { id: 'email', value: userData.email }
            ]
        });
        
        log('Widget authentication configured', 'success');
        
    } catch (error) {
        log(`Authentication setup error: ${error.message}`, 'error');
        updateAuthStatus('error', 'Setup failed: ' + error.message);
    }
}

/**
 * Manually trigger authentication (for testing)
 */
async function forceAuthentication() {
    log('Forcing authentication...');
    await setupZendeskAuthentication();
}

/**
 * Test widget connection
 */
function testWidgetConnection() {
    log('Testing widget connection...');
    
    if (typeof zE !== 'function') {
        log('❌ zE not defined - Widget script not loaded', 'error');
        return false;
    }
    
    log('✅ zE is available', 'success');
    
    try {
        zE('messenger', function(data) {
            log('✅ Messenger is accessible', 'success');
            log('Messenger data: ' + JSON.stringify(data));
        });
        return true;
    } catch (error) {
        log(`❌ Messenger error: ${error.message}`, 'error');
        return false;
    }
}

/**
 * Wait for Zendesk widget to be ready
 */
function waitForWidget(callback, maxAttempts = 50) {
    let attempts = 0;
    
    const checkWidget = () => {
        attempts++;
        
        if (typeof zE === 'function') {
            log('✅ Zendesk widget ready', 'success');
            callback(true);
        } else if (attempts >= maxAttempts) {
            log('❌ Widget load timeout', 'error');
            callback(false);
        } else {
            if (attempts === 1) {
                log('Waiting for widget...');
            }
            setTimeout(checkWidget, 200);
        }
    };
    
    checkWidget();
}

/**
 * Handle login form
 */
async function handleLogin(event) {
    event.preventDefault();
    
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const button = document.getElementById('loginButton');
    
    if (!email || !password) {
        showError('Please enter both email and password');
        return;
    }
    
    button.disabled = true;
    button.textContent = 'Signing in...';
    
    try {
        const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        
        const data = await response.json();
        
        if (data.status === 'success' && data.user) {
            saveUserData(data.user);
            log('Login successful', 'success');
            window.location.href = 'index.html';
        } else {
            showError(data.message || 'Login failed');
        }
    } catch (error) {
        log(`Login error: ${error.message}`, 'error');
        showError('Login failed');
    } finally {
        button.disabled = false;
        button.textContent = 'Sign In';
    }
}

/**
 * Logout
 */
async function handleLogout() {
    log('Logging out...');
    
    if (typeof zE === 'function') {
        try {
            zE('messenger', 'logoutUser');
            log('Widget logout successful');
        } catch (error) {
            log(`Widget logout error: ${error.message}`, 'error');
        }
    }
    
    clearUserData();
    window.location.href = 'login.html';
}

/**
 * Initialize login page
 */
function initLoginPage() {
    log('Login page init');
    
    const emailInput = document.getElementById('email');
    const passwordInput = document.getElementById('password');
    
    if (emailInput && passwordInput) {
        emailInput.value = DEMO_CREDENTIALS.email;
        passwordInput.value = DEMO_CREDENTIALS.password;
    }
    
    const form = document.getElementById('loginForm');
    if (form) {
        form.addEventListener('submit', handleLogin);
    }
}

/**
 * Initialize dashboard
 */
function initDashboardPage() {
    log('Dashboard init');
    
    const userData = getUserData();
    
    if (!userData) {
        log('No user session', 'error');
        const overlay = document.getElementById('authOverlay');
        if (overlay) overlay.style.display = 'flex';
        return;
    }
    
    // Display user info
    const elements = {
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
    
    log(`User: ${userData.name} (${userData.email})`);
    
    // Attach handlers
    const logoutBtn = document.getElementById('logoutButton');
    const authBtn = document.getElementById('authWidgetBtn');
    const testBtn = document.getElementById('testWidgetBtn');
    
    if (logoutBtn) logoutBtn.addEventListener('click', handleLogout);
    if (authBtn) authBtn.addEventListener('click', forceAuthentication);
    if (testBtn) testBtn.addEventListener('click', testWidgetConnection);
    
    // Wait for widget then set up auth
    waitForWidget((ready) => {
        if (ready) {
            testWidgetConnection();
            // Setup authentication immediately
            setupZendeskAuthentication();
        }
    });
}

/**
 * Main init
 */
function init() {
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';
    
    if (currentPage === 'login.html' || currentPage === '') {
        initLoginPage();
    } else {
        if (!isLoggedIn() && currentPage !== 'login.html') {
            window.location.href = 'login.html';
            return;
        }
        initDashboardPage();
    }
}

// Start
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

// Expose for debugging
window.zendeskAuthDebug = {
    getUserData,
    fetchFreshJwtToken,
    setupZendeskAuthentication,
    testWidgetConnection,
    log
};
