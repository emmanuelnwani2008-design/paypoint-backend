require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { createSecurity } = require('./security');

const app = express();
const port = process.env.PORT || 3000;

// SECURITY - helmet, restricted CORS, rate limiting, XSS cleaning (see security.js)
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
createSecurity(app, { allowedOrigins });

// MIDDLEWARE
app.use(express.json());

// SUPABASE - loaded from environment variables (set these in Render's Environment tab)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
if (!supabaseUrl || !supabaseAnonKey) {
    console.warn('⚠️  SUPABASE_URL / SUPABASE_ANON_KEY are not set — auth and data routes will fail.');
}
const supabase = createClient(supabaseUrl, supabaseAnonKey);

// ============================================
// TEST ROUTES
// ============================================
app.get('/', (req, res) => {
    res.json({ message: '🚀 PayPoint API is running!' });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================
// AUTHENTICATION ROUTES
// ============================================
app.post('/api/auth/signup', async (req, res) => {
    try {
        const { name, email, password } = req.body || {};
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }
        const { data, error } = await supabase.auth.signUp({
            email,
            password,
            options: { data: { name: name || '' } }
        });
        if (error) return res.status(400).json({ error: error.message });
        res.json({ success: true, user: data.user });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body || {};
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) return res.status(401).json({ error: 'Invalid credentials' });
        res.json({ success: true, user: data.user });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/auth/logout', async (req, res) => {
    try {
        const { error } = await supabase.auth.signOut();
        if (error) return res.status(400).json({ error: error.message });
        res.json({ success: true, message: 'Logged out' });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// DEALS ROUTES
// ============================================
app.get('/api/deals', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: 'No token provided' });
        const { data: userData, error: userError } = await supabase.auth.getUser(token);
        if (userError || !userData?.user) return res.status(401).json({ error: 'Invalid token' });
        const { data, error } = await supabase.from('deals').select('*').eq('user_id', userData.user.id);
        if (error) return res.status(500).json({ error: error.message });
        res.json({ success: true, data: data || [] });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/deals', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: 'No token provided' });
        const { data: userData, error: userError } = await supabase.auth.getUser(token);
        if (userError || !userData?.user) return res.status(401).json({ error: 'Invalid token' });
        const { brand_name, amount, due_date, deliverable, status } = req.body;
        if (!brand_name || !amount) return res.status(400).json({ error: 'brand_name and amount required' });
        const { data, error } = await supabase.from('deals').insert([{
            user_id: userData.user.id,
            brand_name,
            amount: parseFloat(amount),
            due_date: due_date || null,
            deliverable: deliverable || '',
            status: status || 'pending'
        }]).select();
        if (error) return res.status(500).json({ error: error.message });
        res.status(201).json({ success: true, data: data[0] });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// EXPENSES ROUTES
// ============================================
app.get('/api/expenses', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: 'No token provided' });
        const { data: userData, error: userError } = await supabase.auth.getUser(token);
        if (userError || !userData?.user) return res.status(401).json({ error: 'Invalid token' });
        const { data, error } = await supabase.from('expenses').select('*').eq('user_id', userData.user.id);
        if (error) return res.status(500).json({ error: error.message });
        res.json({ success: true, data: data || [] });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/expenses', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: 'No token provided' });
        const { data: userData, error: userError } = await supabase.auth.getUser(token);
        if (userError || !userData?.user) return res.status(401).json({ error: 'Invalid token' });
        const { vendor, amount, category, receipt_url } = req.body;
        if (!vendor || !amount) return res.status(400).json({ error: 'vendor and amount required' });
        const { data, error } = await supabase.from('expenses').insert([{
            user_id: userData.user.id,
            vendor,
            amount: parseFloat(amount),
            category: category || 'uncategorized',
            receipt_url: receipt_url || ''
        }]).select();
        if (error) return res.status(500).json({ error: error.message });
        res.status(201).json({ success: true, data: data[0] });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// PAYSTACK PAYMENT ROUTES
// ============================================
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
if (!PAYSTACK_SECRET_KEY) {
    console.warn('⚠️  PAYSTACK_SECRET_KEY is not set — payment routes will fail.');
}

app.post('/api/payments/initialize', async (req, res) => {
    try {
        const { dealId, email } = req.body;
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: 'No token provided' });
        const { data: userData, error: userError } = await supabase.auth.getUser(token);
        if (userError || !userData?.user) return res.status(401).json({ error: 'Invalid token' });

        if (!dealId) return res.status(400).json({ error: 'dealId required' });

        const { data: deal, error: dealError } = await supabase
            .from('deals')
            .select('*')
            .eq('id', dealId)
            .eq('user_id', userData.user.id)
            .single();

        if (dealError || !deal) return res.status(404).json({ error: 'Deal not found' });

        const amountInKobo = Math.round(deal.amount * 100);
        const callbackUrl = 'https://paypoint-app.netlify.app/success.html';

        const response = await fetch('https://api.paystack.co/transaction/initialize', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
            },
            body: JSON.stringify({
                email: email || 'customer@example.com',
                amount: amountInKobo,
                callback_url: callbackUrl,
                metadata: { deal_id: dealId, brand_name: deal.brand_name }
            })
        });

        const result = await response.json();

        if (!result.status) {
            return res.status(502).json({ error: 'Payment provider error', details: result });
        }

        res.json({
            success: true,
            authorization_url: result.data.authorization_url,
            reference: result.data.reference
        });

    } catch (err) {
        console.error('Paystack error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/payments/verify/:reference', async (req, res) => {
    try {
        const { reference } = req.params;
        if (!reference) return res.status(400).json({ error: 'Reference required' });

        const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
            headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
        });
        const result = await response.json();

        if (!result.status) {
            return res.status(502).json({ error: 'Verification failed' });
        }

        const status = result.data.status;
        const paid = status === 'success';
        const dealId = result.data.metadata?.deal_id;

        if (paid && dealId) {
            const { error } = await supabase
                .from('deals')
                .update({ status: 'paid' })
                .eq('id', dealId);
            if (error) console.error('Error updating deal:', error);
        }

        res.json({
            success: true,
            status: status,
            paid: paid,
            amount: result.data.amount / 100,
            brand_name: result.data.metadata?.brand_name || 'Unknown'
        });

    } catch (err) {
        console.error('Verification error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// INVOICE ROUTES
// ============================================
app.post('/api/invoices/create', async (req, res) => {
    try {
        const { dealId, invoiceNumber, brandEmail } = req.body;
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: 'No token provided' });
        const { data: userData, error: userError } = await supabase.auth.getUser(token);
        if (userError || !userData?.user) return res.status(401).json({ error: 'Invalid token' });

        if (!dealId || !brandEmail) {
            return res.status(400).json({ error: 'dealId and brandEmail required' });
        }

        const { data, error } = await supabase
            .from('invoices')
            .insert([{
                user_id: userData.user.id,
                deal_id: dealId,
                invoice_number: invoiceNumber || `INV-${Date.now()}`,
                brand_email: brandEmail,
                status: 'sent'
            }])
            .select();

        if (error) return res.status(500).json({ error: error.message });
        res.status(201).json({ success: true, data: data[0] });

    } catch (err) {
        console.error('Invoice create error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/invoices/generate', async (req, res) => {
    try {
        const { dealId } = req.body;
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: 'No token provided' });
        const { data: userData, error: userError } = await supabase.auth.getUser(token);
        if (userError || !userData?.user) return res.status(401).json({ error: 'Invalid token' });

        if (!dealId) return res.status(400).json({ error: 'dealId required' });

        const { data: deal, error: dealError } = await supabase
            .from('deals')
            .select('*')
            .eq('id', dealId)
            .eq('user_id', userData.user.id)
            .single();

        if (dealError || !deal) return res.status(404).json({ error: 'Deal not found' });

        // Simple HTML invoice that can be printed as PDF
        const html = `
            <html>
            <head><title>Invoice</title></head>
            <body style="font-family:Arial;padding:40px;">
                <h1 style="color:#4F7CFF;">PayPoint</h1>
                <h2>Invoice #INV-${Date.now()}</h2>
                <hr>
                <p><strong>Brand:</strong> ${deal.brand_name}</p>
                <p><strong>Amount:</strong> $${Number(deal.amount).toLocaleString()}</p>
                <p><strong>Deliverable:</strong> ${deal.deliverable || 'Not specified'}</p>
                <p><strong>Due Date:</strong> ${deal.due_date || 'Not set'}</p>
                <hr>
                <p>Thank you for using PayPoint!</p>
            </body>
            </html>
        `;

        res.setHeader('Content-Type', 'text/html');
        res.send(html);

    } catch (err) {
        console.error('PDF generation error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// PAYSTACK WEBHOOK
// ============================================
app.post('/api/webhooks/paystack', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        const event = JSON.parse(req.body.toString());
        console.log('📨 Webhook event:', event.event);

        if (event.event === 'charge.success') {
            const dealId = event.data.metadata?.deal_id;
            if (dealId) {
                const { error } = await supabase
                    .from('deals')
                    .update({ status: 'paid' })
                    .eq('id', dealId);
                if (error) console.error('Error updating deal:', error);
                else console.log(`✅ Deal ${dealId} marked as paid via webhook`);
            }
        }
        res.sendStatus(200);
    } catch (err) {
        console.error('Webhook error:', err);
        res.sendStatus(500);
    }
});

// ============================================
// KEEP-ALIVE (prevents Render free tier from sleeping)
// Only runs in production, and only if RENDER_EXTERNAL_URL is set
// (Render sets this automatically — no config needed on your end)
// ============================================
if (process.env.RENDER_EXTERNAL_URL) {
    const SELF_URL = process.env.RENDER_EXTERNAL_URL;
    const PING_INTERVAL_MS = 10 * 60 * 1000; // every 10 minutes, safely under the 15-min sleep window

    setInterval(() => {
        fetch(`${SELF_URL}/health`)
            .then(() => console.log('💓 Keep-alive ping sent'))
            .catch((err) => console.warn('Keep-alive ping failed:', err.message));
    }, PING_INTERVAL_MS);

    console.log(`💓 Keep-alive enabled, pinging every ${PING_INTERVAL_MS / 60000} min`);
}

// ============================================
// START SERVER
// ============================================
app.listen(port, () => {
    console.log(`🚀 PayPoint API running on port ${port}`);
});