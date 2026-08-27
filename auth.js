// ============================================
// SHARED AUTHENTICATION – auth.js
// ============================================

const API_URL = window.__API_URL__ || (
    window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
        ? '/api'
        : 'https://paypoint-7dmc.onrender.com/api'
);

let currentUser = null;

async function checkAuth(redirectOnFail = true) {
    try {
        const res = await fetch(`${API_URL}/auth/user`, {
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
            localStorage.setItem('paypoint_user', JSON.stringify(data.user));
            if (data.session?.access_token) {
                sessionStorage.setItem('paypoint_session', data.session.access_token);
            }
            currentUser = data.user;
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
}

function getAuthHeaders() {
    const token = sessionStorage.getItem('paypoint_session');
    return {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
    };
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function updateUserBadge() {
    const user = JSON.parse(localStorage.getItem('paypoint_user') || 'null');
    const badge = document.getElementById('userBadge');
    if (badge && user) {
        const name = user?.user_metadata?.name || user?.name || 'Creator';
        badge.innerHTML = `<i class="fas fa-user"></i> ${escapeHtml(name)}`;
    }
}

async function logout() {
    try {
        await fetch(`${API_URL}/auth/logout`, { method: 'POST', credentials: 'include' });
    } catch (e) {}
    localStorage.removeItem('paypoint_user');
    sessionStorage.removeItem('paypoint_session');
    window.location.replace('login.html');
}

window.checkAuth = checkAuth;
window.getAuthHeaders = getAuthHeaders;
window.updateUserBadge = updateUserBadge;
window.logout = logout;