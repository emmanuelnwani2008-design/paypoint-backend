// Simple toast notification system
function showToast(message, type = 'info', duration = 3000) {
    const container = document.querySelector('.toast-container') || (() => {
        const c = document.createElement('div');
        c.className = 'toast-container';
        c.style.cssText = `
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
        document.body.appendChild(c);
        return c;
    })();

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
    setTimeout(() => { if (toast.parentElement) toast.remove(); }, duration);
}

// Add animation
const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn {
        from { opacity: 0; transform: translateX(20px); }
        to { opacity: 1; transform: translateX(0); }
    }
`;
document.head.appendChild(style);

window.showToast = showToast;