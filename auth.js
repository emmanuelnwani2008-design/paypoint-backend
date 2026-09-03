/* Global auth helpers for PayPoint frontend */
(function () {
    // Use the frontend proxy so auth requests keep the same origin as the page.
    // This avoids browser CORS and cross-site cookie failures on deployed pages.
    window.__API_URL__ = window.__API_URL__ || '/api';
    window.API_URL = window.__API_URL__;

    window.getApiUrl = function () {
        return window.__API_URL__ || '/api';
    };

    window.getAuthHeaders = function () {
        const token = sessionStorage.getItem('paypoint_session') || localStorage.getItem('paypoint_session');
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        return headers;
    };

    window.checkAuth = async function (redirectOnFail = true) {
        try {
            const res = await fetch(`${window.API_URL}/auth/user`, {
                credentials: 'include',
                headers: window.getAuthHeaders()
            });

            if (res.status === 401) {
                localStorage.removeItem('paypoint_user');
                localStorage.removeItem('paypoint_session');
                sessionStorage.removeItem('paypoint_session');
                if (redirectOnFail) window.location.replace('login.html');
                return false;
            }

            const data = await res.json();
            if (data && data.success && data.user) {
                const normalizedUser = window.normalizeUser ? window.normalizeUser(data.user) : data.user;
                localStorage.setItem('paypoint_user', JSON.stringify(normalizedUser));
                if (data.session?.access_token) {
                    sessionStorage.setItem('paypoint_session', data.session.access_token);
                }
                return true;
            }

            if (redirectOnFail) window.location.replace('login.html');
            return false;
        } catch (err) {
            console.error('Auth check error:', err);
            if (redirectOnFail) window.location.replace('login.html');
            return false;
        }
    };

    window.escapeHtml = function (text) {
        if (!text && text !== 0) return '';
        const div = document.createElement('div');
        div.textContent = String(text);
        return div.innerHTML;
    };

    window.normalizeUser = function (user) {
        if (!user || typeof user !== 'object') return user;

        const metadata = { ...(user.user_metadata || {}) };
        const displayName = metadata.name || metadata.full_name || metadata.display_name ||
            [metadata.given_name, metadata.family_name].filter(Boolean).join(' ').trim() ||
            user.name || user.full_name || user.display_name || '';

        if (displayName) {
            metadata.name = displayName;
            metadata.full_name = metadata.full_name || displayName;
            metadata.display_name = metadata.display_name || displayName;
            user.name = user.name || displayName;
            user.full_name = user.full_name || displayName;
            user.display_name = user.display_name || displayName;
        }

        user.user_metadata = metadata;
        return user;
    };

    window.logout = async function () {
        try {
            await fetch(`${window.API_URL}/auth/logout`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include'
            });
        } catch (e) {
            console.warn('Logout request failed:', e);
        }
        localStorage.removeItem('paypoint_user');
        localStorage.removeItem('paypoint_session');
        sessionStorage.removeItem('paypoint_session');
        window.location.replace('login.html');
    };
})();