// ============================================================
//  main.js — Клиентский JS для Anxiety.
// ============================================================

// hCaptcha token injection into forms
function setupCaptchaForms() {
    document.querySelectorAll('form').forEach(form => {
        const tokenField = form.querySelector('#hcaptchaToken');
        if (!tokenField) return;

        form.addEventListener('submit', (e) => {
            // Find the closest .hcaptcha-wrap and extract response
            const container = form.querySelector('.hcaptcha-wrap iframe')
                ? form.querySelector('.hcaptcha-wrap')
                : form.closest('.auth-card')?.querySelector('.hcaptcha-wrap');

            if (container) {
                const textarea = container.querySelector('textarea[name="h-captcha-response"]');
                if (textarea && textarea.value) {
                    tokenField.value = textarea.value;
                }
            }
        });
    });
}

// Flash messages auto-dismiss
function setupFlashDismiss() {
    document.querySelectorAll('.flash').forEach(el => {
        setTimeout(() => {
            el.style.opacity = '0';
            el.style.transition = 'opacity 0.3s ease';
            setTimeout(() => el.remove(), 300);
        }, 5000);
    });
}

// Init on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    setupCaptchaForms();
    setupFlashDismiss();
});
