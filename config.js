// API Configuration
// This file sets the API URL based on the environment
(function() {
  const hostname = window.location.hostname;
  const isDevelopment = hostname === 'localhost' || hostname === '127.0.0.1';
  
  if (isDevelopment) {
    // Local development: use relative path (same server)
    window.__API_URL__ = '/api';
  } else {
    // Production: use Render backend URL
    window.__API_URL__ = 'https://paypoint-backend-9m63.onrender.com/api';
  }
  
  console.log('[Config] API URL:', window.__API_URL__, '(Environment:', isDevelopment ? 'development' : 'production', ')');
})();
