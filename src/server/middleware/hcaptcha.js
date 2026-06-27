// ============================================================
//  middleware/hcaptcha.js — Проверка hCaptcha токена.
// ============================================================

const https = require('https');
const { HCAPTCHA_SECRET_KEY } = require('../lib/config');

function verifyCaptcha(response, remoteIp) {
    return new Promise((resolve) => {
        if (!HCAPTCHA_SECRET_KEY || !response) {
            return resolve(false);
        }

        const data = JSON.stringify({
            secret: HCAPTCHA_SECRET_KEY,
            response: response,
            remoteip: remoteIp || '',
        });

        const options = {
            hostname: 'hcaptcha.com',
            path: '/siteverify',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
            },
        };

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () => {
                try {
                    const json = JSON.parse(body);
                    resolve(json.success === true);
                } catch {
                    resolve(false);
                }
            });
        });

        req.on('error', () => resolve(false));
        req.setTimeout(5000, () => { req.destroy(); resolve(false); });
        req.write(data);
        req.end();
    });
}

// Express middleware — проверяет req.body.hcaptchaToken
async function requireCaptcha(req, res, next) {
    const token = req.body && req.body.hcaptchaToken;
    const ip = req.ip || req.headers['x-forwarded-for'] || '';
    const ok = await verifyCaptcha(token, ip);
    if (!ok) {
        return res.status(400).json({ error: 'Проверка капчи не пройдена' });
    }
    next();
}

module.exports = { verifyCaptcha, requireCaptcha };
