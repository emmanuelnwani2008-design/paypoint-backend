// config.js
(function() {
    // If Cloudflare Pages sets an environment variable, use it
    const apiUrl = window.__API_URL__ || 
                   (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? 
                   'http://localhost:3000/api' : 
                   'https://paypoint-backend-9m63.onrender.com/api');
    window.__API_URL__ = apiUrl;
    console.log('[Config] API URL:', apiUrl);
})();