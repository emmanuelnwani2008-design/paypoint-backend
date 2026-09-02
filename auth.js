/* Global auth helpers for PayPoint frontend */
(function () {
    window.__API_URL__ = window.__API_URL__ || (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? '/api' : 'https://paypoint-7dmc.onrender.com/api');
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
                localStorage.setItem('paypoint_user', JSON.stringify(data.user));
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