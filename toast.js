/* Toast utility for PayPoint. Keep a single global implementation. */
(function () {
    if (window.__paypointToastReady) return;
    window.__paypointToastReady = true;

    function showToast(message, type = 'info', duration = 3000) {
        if (!document) return;

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
            <span>${String(message || '')}</span>
            <button onclick="this.parentElement.remove()" style="background: none; border: none; color: #8A9AAB; cursor: pointer; font-size: 18px;">&times;</button>
        `;
        container.appendChild(toast);
        setTimeout(() => {
            if (toast.parentElement) toast.remove();
        }, duration);
    }

    function showMessage(idOrText, textOrType, maybeType) {
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

        const text = typeof idOrText === 'string' ? idOrText : String(idOrText);
        const type = typeof textOrType === 'string' ? textOrType : (maybeType || 'info');
        showToast(text, type);
    }

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

    window.showToast = showToast;
    window.showMessage = showMessage;
})();