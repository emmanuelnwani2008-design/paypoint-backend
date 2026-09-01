/* Global auth helpers for PayPoint frontend */
(function () {
    window.getApiUrl = function () {
        return window.__API_URL__ || '/api';
    };

    window.getAuthHeaders = function () {
        const token = localStorage.getItem('paypoint_session');
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        return headers;
    };

    window.checkAuth = async function (opts = { redirect: true }) {
        const token = localStorage.getItem('paypoint_session');
        const cachedUser = localStorage.getItem('paypoint_user');

        if (token && cachedUser) {
            try {
                const u = JSON.parse(cachedUser);
                return { ok: true, user: u };
            } catch (e) {
                console.warn('Invalid cached user');
            }
        }

        try {
            const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
            const res = await fetch(window.getApiUrl() + '/auth/user', {
                headers,
                credentials: 'include'
            });

            if (res.status === 401) {
                localStorage.removeItem('paypoint_user');
                localStorage.removeItem('paypoint_session');
                if (opts.redirect) window.location.replace('login.html');
                return { ok: false };
            }

            const data = await res.json();
            if (data && data.success && data.user) {
                localStorage.setItem('paypoint_user', JSON.stringify(data.user));
                return { ok: true, user: data.user };
            }

            if (opts.redirect) window.location.replace('login.html');
            return { ok: false };
        } catch (err) {
            console.error('checkAuth error', err);
            return { ok: false, error: err };
        }
    };
    // Helper: escape HTML safely
    window.escapeHtml = function (text) {
        if (!text && text !== 0) return '';
        const div = document.createElement('div');
        div.textContent = String(text);
        return div.innerHTML;
    };
})();
// ============================================
// SHARED AUTHENTICATION (HttpOnly cookie based)
// ============================================

// Define API_URL based on environment
window.API_URL = window.__API_URL__ || (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? '/api' : 'https://paypoint-7dmc.onrender.com/api');

// Check authentication – uses HttpOnly cookie, so credentials: 'include'
window.checkAuth = async function(redirectOnFail = true) {
    try {
        const res = await fetch(`${window.API_URL}/auth/user`, {
            credentials: 'include'
        });
        if (res.status === 401) {
            if (redirectOnFail) {
                window.location.replace('login.html');
            }
            return false;
        }
        const data = await res.json();
        if (data.success && data.user) {
            // Store user data (NOT the token)
            localStorage.setItem('paypoint_user', JSON.stringify(data.user));
            // If session token is returned (for hybrid fallback), store it in sessionStorage
            if (data.session?.access_token) {
                sessionStorage.setItem('paypoint_session', data.session.access_token);
            }
            return true;
        } else {
            if (redirectOnFail) {
                window.location.replace('login.html');
            }
            return false;
        }
    } catch (err) {
        console.error('Auth check error:', err);
        if (redirectOnFail) {
            window.location.replace('login.html');
        }
        return false;
    }
};

// Get auth headers – only needed for pages that still use Bearer token fallback
// Most API calls should use credentials: 'include' instead
window.getAuthHeaders = function() {
    const token = sessionStorage.getItem('paypoint_session') || localStorage.getItem('paypoint_session');
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return headers;
};

// Escape HTML (XSS protection)
window.escapeHtml = function(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
};

// Logout
window.logout = async function() {
    try {
        await fetch(`${window.API_URL}/auth/logout`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include'
        });
    } catch (e) {}
    localStorage.removeItem('paypoint_user');
    sessionStorage.removeItem('paypoint_session');
    window.location.replace('login.html');
};