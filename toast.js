/* Simple global toast utility */
(function () {
    window.showToast = function (message, type = 'info', timeout = 4000) {
        if (!document) return;
        let container = document.getElementById('global-toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'global-toast-container';
            Object.assign(container.style, {
                position: 'fixed',
                right: '20px',
                top: '20px',
                zIndex: 10000,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-end',
                gap: '8px'
            });
            document.body.appendChild(container);
        }

        const el = document.createElement('div');
        el.style.transition = 'opacity 240ms ease, transform 240ms ease';
        el.style.opacity = '0';
        el.style.transform = 'translateY(-6px)';

        const color = type === 'success' ? '#16a34a' : type === 'error' ? '#dc2626' : '#0ea5e9';
        el.innerHTML = `<div style="background:#fff; border:1px solid #e6e9ef; padding:10px 14px; border-left:4px solid ${color}; box-shadow:0 6px 18px rgba(16,24,40,0.06); border-radius:8px; font-size:14px; max-width:320px;">${message}</div>`;
        container.prepend(el);

        // animate in
        requestAnimationFrame(() => {
            el.style.opacity = '1';
            el.style.transform = 'translateY(0)';
        });

        setTimeout(() => {
            el.style.opacity = '0';
            el.style.transform = 'translateY(-6px)';
            setTimeout(() => { el.remove(); if (!container.hasChildNodes()) container.remove(); }, 260);
        }, timeout);
    };
    // Backwards-compatible showMessage(id, text, type)
    window.showMessage = function (idOrText, textOrType, maybeType) {
        // If first arg looks like an element id and that element exists, update it
        try {
            const el = document.getElementById(idOrText);
            if (el) {
                const text = textOrType || '';
                el.innerHTML = text;
                if (maybeType === 'success') el.style.color = '#16a34a';
                else if (maybeType === 'error') el.style.color = '#dc2626';
                else el.style.color = '';
                return;
            }
        } catch (e) {
            // ignore
        }

        // Otherwise treat arguments as (text, type)
        const text = typeof idOrText === 'string' ? idOrText : String(idOrText);
        const type = typeof textOrType === 'string' ? textOrType : (maybeType || 'info');
        window.showToast(text, type);
    };
})();
// ============================================
// TOAST NOTIFICATIONS (replaces alert)
// ============================================

window.showToast = function(message, type = 'info', duration = 3000) {
    // Create container if it doesn't exist
    let container = document.querySelector('.toast-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'toast-container';
        container.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 99999;
            display: flex;
            flex-direction: column;
            gap: 10px;
            max-width: 350px;
            width: 100%;
            pointer-events: none;
        `;
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    const colors = { success: '#34C759', error: '#FF3B30', warning: '#FF9500', info: '#4F7CFF' };
    const bgColor = colors[type] || colors.info;
    toast.style.cssText = `
        background: white;
        border-left: 4px solid ${bgColor};
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        border-radius: 8px;
        padding: 12px 16px;
        font-family: 'Inter', sans-serif;
        font-size: 14px;
        color: #1A1A2E;
        pointer-events: auto;
        display: flex;
        justify-content: space-between;
        align-items: center;
        animation: slideIn 0.3s ease;
        width: 100%;
    `;
    toast.innerHTML = `
        <span>${message}</span>
        <button onclick="this.parentElement.remove()" style="background: none; border: none; color: #8A9AAB; cursor: pointer; font-size: 18px;">&times;</button>
    `;
    container.appendChild(toast);
    setTimeout(() => {
        if (toast.parentElement) toast.remove();
    }, duration);
};

// Add animation
if (!document.querySelector('#toast-style')) {
    const style = document.createElement('style');
    style.id = 'toast-style';
    style.textContent = `
        @keyframes slideIn {
            from { opacity: 0; transform: translateX(20px); }
            to { opacity: 1; transform: translateX(0); }
        }
    `;
    document.head.appendChild(style);
}