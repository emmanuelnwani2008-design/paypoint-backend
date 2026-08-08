// nav.js – Auto-highlight bottom navigation based on current page
document.addEventListener('DOMContentLoaded', function() {
    // Get current page filename (e.g., "deals.html")
    let currentPage = window.location.pathname.split('/').pop() || 'dashboard.html';

    // Handle special pages – map them to the correct tab
    if (currentPage === 'deal-detail.html') {
        currentPage = 'deals.html';
    }
    if (currentPage === 'pay-invoice.html') {
        currentPage = 'invoice.html';
    }
    if (currentPage === 'admin.html') {
        currentPage = 'dashboard.html';
    }

    const navLinks = document.querySelectorAll('.bottom-nav a');

    // Remove any existing active classes (safety)
    navLinks.forEach(link => link.classList.remove('active'));

    // Add active to the matching link
    navLinks.forEach(link => {
        const href = link.getAttribute('href');
        if (href === currentPage) {
            link.classList.add('active');
        }
    });
});