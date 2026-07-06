// config.js
// Sets window.__API_URL__ so every page (login.html, success.html, etc.)
// points at the same backend without repeating the URL everywhere.
(function () {
    // If a hosting platform injects window.__API_URL__ before this script runs, keep it.
    // Otherwise fall back to the live Render backend.
    window.__API_URL__ = window.__API_URL__ || 'https://paypoint-backend-9m63.onrender.com/api';
})();