// Load environment variables from .env file (development). Render provides env at runtime.
require('dotenv').config();
console.log('SUPABASE_URL:', process.env.SUPABASE_URL);

// Check required environment variables
const requiredEnv = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'PAYSTACK_SECRET_KEY'];
for (const env of requiredEnv) {
    if (!process.env[env]) {
        console.error(`❌ Missing ${env} environment variable`);
        process.exit(1);
    }
}

const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const PDFDocument = require('pdfkit');
const crypto = require('crypto');
const fetch = global.fetch || require('node-fetch');
const { createSecurity } = require('./security');
const { body, param, validationResult } = require('express-validator');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const xss = require('xss-clean');
const morgan = require('morgan');

const app = express();
const port = process.env.PORT || 3000;

// ENV validation (fail fast if critical values missing)
// Initialize Supabase client - HARDCODED FOR RENDER DEPLOYMENT
const supabaseUrl = 'https://mqggkwhdbwkaftmewdca.supabase.co';
const supabaseAnonKey = 'sb_publishable_u1Ag_qpF5L8LbHc6ZzYnxQ_z4w3ExhV';

// Skip validation since we hardcoded it
const supabase = createClient(supabaseUrl, supabaseAnonKey);
console.log('✅ Supabase connected with hardcoded credentials');

// Security middlewares (helmet, cors, rate-limit, xss-clean, logging)
const allowed = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',').map(s => s.trim());
createSecurity(app, { allowedOrigins: allowed, rate: { windowMs: 15 * 60 * 1000, max: 200 } });

// Body parser that also saves raw body for webhook signature verification
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));

// Serve static files (frontend)
app.use(express.static(path.join(__dirname)));
// ============================================
// AUTHENTICATION & PROFILE ROUTES
// ============================================

// SIGNUP - Create a new user
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { name: name || '' } }
    });

    if (error) return res.status(400).json({ error: error.message });

    res.json({ success: true, user: data.user, session: data.session || null });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// LOGIN - Authenticate a user
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: 'Invalid credentials' });

    res.json({ success: true, user: data.user, session: data.session || null });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// LOGOUT - client should clear tokens; we'll accept token and attempt server-side signout if possible
app.post('/api/auth/logout', async (req, res) => {
  try {
    // Supabase signOut requires client-side context; just return success for now
    res.json({ success: true, message: 'Logged out' });
  } catch (err) {
    console.error('Logout error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// TEST ROUTE - Check if API is running
// ============================================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

// ============================================
// DEALS ROUTES
// ============================================

// GET /api/deals - Fetch all deals for the logged-in user
app.get('/api/deals', authenticate, async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });
        
        const { data, error } = await supabase
            .from('deals')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Supabase error:', error);
            return res.status(500).json({ error: error.message });
        }

        res.json({ success: true, data: data || [] });
    } catch (err) {
        console.error('Server error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/deals - Add a new deal
app.post('/api/deals', authenticate, async (req, res) => {
    try {
        const { brand_name, amount, due_date, deliverable, status } = req.body;
        
        // Basic validation
        if (!brand_name || !amount) {
            return res.status(400).json({ error: 'brand_name and amount are required' });
        }

        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });

        const { data, error } = await supabase
            .from('deals')
            .insert([
                {
                    user_id: userId,
                    brand_name,
                    amount: parseFloat(amount),
                    due_date: due_date || null,
                    deliverable: deliverable || '',
                    status: status || 'pending'
                }
            ])
            .select();

        if (error) {
            console.error('Supabase error:', error);
            return res.status(500).json({ error: error.message });
        }

        res.status(201).json({ success: true, data: data[0] });
    } catch (err) {
        console.error('Server error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PUT /api/deals/:id - Update an existing deal
app.put('/api/deals/:id', authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        const { brand_name, amount, due_date, deliverable, status } = req.body;

        if (!brand_name || amount === undefined || amount === null) {
            return res.status(400).json({ error: 'brand_name and amount are required' });
        }

        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });

        const { data, error } = await supabase
            .from('deals')
            .update({
                brand_name,
                amount: parseFloat(amount),
                due_date: due_date || null,
                deliverable: deliverable || '',
                status: status || 'pending'
            })
            .eq('id', id)
            .eq('user_id', userId)
            .select();

        if (error) {
            console.error('Supabase error:', error);
            return res.status(500).json({ error: error.message });
        }

        if (!data || data.length === 0) {
            return res.status(404).json({ success: false, error: 'Deal not found' });
        }

        res.json({ success: true, data: data[0] });
    } catch (err) {
        console.error('Server error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE /api/deals/:id - Delete a deal
app.delete('/api/deals/:id', authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });

        const { data, error } = await supabase
            .from('deals')
            .delete()
            .eq('id', id)
            .eq('user_id', userId)
            .select();

        if (error) {
            console.error('Supabase error:', error);
            return res.status(500).json({ error: error.message });
        }

        if (!data || data.length === 0) {
            return res.status(404).json({ success: false, error: 'Deal not found' });
        }

        res.json({ success: true, data: data[0] });
    } catch (err) {
        console.error('Server error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// PAYSTACK SETUP
// ============================================

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
if (!PAYSTACK_SECRET_KEY) {
    console.warn('⚠️ PAYSTACK_SECRET_KEY not set. Paystack routes will be disabled.');
}

// Helper: validate request results
function handleValidation(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    return null;
}

// 1. INITIALIZE PAYMENT
app.post('/api/payments/initialize',
    // Accept either dealId or amount+email
    [
        body('dealId').optional().isUUID().withMessage('dealId must be a UUID'),
        body('amount').optional().isFloat({ gt: 0 }).withMessage('amount must be a positive number'),
        body('email').optional().isEmail().withMessage('email must be valid')
    ],
    authenticate,
    async (req, res) => {
        try {
            const invalid = handleValidation(req, res);
            if (invalid) return;

            const { dealId, amount, email, metadata } = req.body || {};
            const userId = req.user?.id;
            if (!userId) return res.status(401).json({ error: 'Unauthorized' });

            let payAmount = 0;
            let meta = metadata || {};
            let brandEmail = email || 'customer@example.com';

            if (dealId) {
                const { data: deal, error: dealError } = await supabase.from('deals').select('*').eq('id', dealId).eq('user_id', userId).single();
                if (dealError || !deal) return res.status(404).json({ error: 'Deal not found' });
                payAmount = Number(deal.amount);
                meta.deal_id = dealId;
                meta.brand_name = deal.brand_name;
                brandEmail = brandEmail || deal.brand_email || brandEmail;
            } else if (amount) {
                payAmount = Number(amount);
            } else {
                return res.status(400).json({ error: 'Either dealId or amount is required' });
            }

            if (!PAYSTACK_SECRET_KEY) return res.status(503).json({ error: 'Payment provider not configured' });

            const amountInKobo = Math.round(payAmount * 100);
            const callbackUrl = (process.env.FRONTEND_URL || `http://localhost:${port}`) + '/success.html';

            // Initialize via Paystack HTTP API
            const resp = await fetch('https://api.paystack.co/transaction/initialize', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
                },
                body: JSON.stringify({
                    email: brandEmail,
                    amount: amountInKobo,
                    callback_url: callbackUrl,
                    metadata: meta
                })
            });
            const result = await resp.json();
            if (!result || !result.status) {
                console.error('Paystack initialize failed:', result);
                return res.status(502).json({ error: 'Payment provider error' });
            }

            const { authorization_url: authorization_url, access_code, reference } = result.data || {};

            // Store a pending payment record to allow idempotency checks (if payments table exists)
            try {
                await supabase.from('payments').insert([{
                    user_id: userId,
                    deal_id: meta.deal_id || null,
                    amount: payAmount,
                    reference,
                    status: 'initialized'
                }]);
            } catch (e) {
                console.warn('Could not create payment record (payments table may not exist):', e.message || e);
            }

            res.json({ success: true, authorization_url, access_code, reference });
        } catch (err) {
            console.error('Paystack initialize error:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
);

// 2. VERIFY PAYMENT
app.get('/api/payments/verify/:reference', [param('reference').notEmpty().withMessage('reference required')], authenticate, async (req, res) => {
    try {
        const invalid = handleValidation(req, res);
        if (invalid) return;

        const { reference } = req.params;
        if (!reference) return res.status(400).json({ error: 'Reference required' });
        if (!PAYSTACK_SECRET_KEY) return res.status(503).json({ error: 'Payment provider not configured' });

        const resp = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
            headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
        });
        const result = await resp.json();
        if (!result || !result.status) {
            console.error('Paystack verify failed:', result);
            return res.status(502).json({ error: 'Payment provider error' });
        }

        const status = result.data.status;
        const paid = status === 'success';
        const metadata = result.data.metadata || {};
        const dealId = metadata.deal_id;
        const paidAmount = (result.data.amount || 0) / 100;

        // Idempotency: check if reference already processed
        try {
            const { data: existing } = await supabase.from('payments').select('*').eq('reference', reference).limit(1).maybeSingle();
            if (existing && existing.status === 'success') {
                return res.json({ success: true, status, paid: true, amount: paidAmount, brand_name: metadata.brand_name || 'Unknown' });
            }
        } catch (e) {
            // ignore if payments table not present
        }

        if (paid && dealId) {
            // Validate amount matches deal
            const { data: deal } = await supabase.from('deals').select('*').eq('id', dealId).limit(1).maybeSingle();
            if (deal && Number(deal.amount) === Number(paidAmount)) {
                const { error: updError } = await supabase.from('deals').update({ status: 'paid' }).eq('id', dealId);
                if (updError) console.error('Error updating deal:', updError);
            } else {
                console.warn('Payment amount does not match deal amount; not marking paid');
            }

            // record payment
            try {
                await supabase.from('payments').insert([{ reference, deal_id: dealId, amount: paidAmount, status: 'success' }]);
            } catch (e) {
                console.warn('Could not insert payment record:', e.message || e);
            }
        }

        res.json({ success: true, status, paid, amount: paidAmount, brand_name: metadata.brand_name || 'Unknown' });
    } catch (err) {
        console.error('Verification error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 3. WEBHOOK - verify signature
app.post('/api/webhooks/paystack', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        const signature = req.headers['x-paystack-signature'];
        const secret = PAYSTACK_SECRET_KEY;

        // verify signature using raw body
        const raw = req.rawBody || req.body || Buffer.from('');
        const expected = crypto.createHmac('sha512', secret).update(raw).digest('hex');
        if (!signature || signature !== expected) {
            console.warn('⚠️ Invalid Paystack webhook signature');
            return res.sendStatus(400);
        }

        const event = JSON.parse(raw.toString());
        console.log('📨 Webhook event:', event.event);

        if (event.event === 'charge.success' || event.event === 'payment.success') {
            const reference = event.data.reference;
            const metadata = event.data.metadata || {};
            const dealId = metadata.deal_id;
            const amount = (event.data.amount || 0) / 100;

            // Idempotency: check payments table
            try {
                const { data: existing } = await supabase.from('payments').select('*').eq('reference', reference).limit(1).maybeSingle();
                if (existing && existing.status === 'success') {
                    console.log('Duplicate webhook ignored for reference', reference);
                    return res.sendStatus(200);
                }
            } catch (e) {
                // ignore if payments table not present
            }

            if (dealId) {
                // Validate amount matches deal amount
                const { data: deal } = await supabase.from('deals').select('*').eq('id', dealId).limit(1).maybeSingle();
                if (deal && Number(deal.amount) === Number(amount)) {
                    const { error } = await supabase.from('deals').update({ status: 'paid' }).eq('id', dealId);
                    if (error) console.error('Error updating deal:', error);
                    else console.log(`✅ Deal ${dealId} marked as paid via webhook`);
                } else {
                    console.warn('Webhook payment amount does not match deal; skipping mark paid');
                }

                // record payment
                try {
                    await supabase.from('payments').insert([{ reference, deal_id: dealId, amount, status: 'success' }]);
                } catch (e) {
                    console.warn('Could not insert payment record from webhook:', e.message || e);
                }
            }
        }

        res.sendStatus(200);
    } catch (err) {
        console.error('Webhook error:', err);
        res.sendStatus(500);
    }
});

// ============================================
// EXPENSES ROUTES
// ============================================

// GET /api/expenses - Fetch all expenses for the logged-in user
app.get('/api/expenses', authenticate, async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });
        const { data, error } = await supabase
            .from('expenses')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Supabase error:', error);
            return res.status(500).json({ error: error.message });
        }

        res.json({ success: true, data: data || [] });
    } catch (err) {
        console.error('Server error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/expenses - Add a new expense
app.post('/api/expenses', authenticate, async (req, res) => {
    try {
        const { vendor, amount, category, receipt_url } = req.body;
        
        // Basic validation
        if (!vendor || !amount) {
            return res.status(400).json({ error: 'vendor and amount are required' });
        }

        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });

        const { data, error } = await supabase
            .from('expenses')
            .insert([
                {
                    user_id: userId,
                    vendor,
                    amount: parseFloat(amount),
                    category: category || 'uncategorized',
                    receipt_url: receipt_url || ''
                }
            ])
            .select();

        if (error) {
            console.error('Supabase error:', error);
            return res.status(500).json({ error: error.message });
        }

        res.status(201).json({ success: true, data: data[0] });
    } catch (err) {
        console.error('Server error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// START THE SERVER
// ============================================
app.listen(port, () => {
    console.log(`🚀 PayPoint API running on http://localhost:${port}`);
});

// Graceful shutdown
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
});

process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down');
    process.exit(0);
});

// ============================================
// INVOICES ROUTES
// ============================================

// POST /api/invoices/create - create an invoice record and (optionally) send
app.post('/api/invoices/create', authenticate, async (req, res) => {
    try {
        const { dealId, invoiceNumber, brandEmail } = req.body;
        if (!dealId || !brandEmail) {
            return res.status(400).json({ success: false, error: 'dealId and brandEmail are required' });
        }

        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

        const { data, error } = await supabase
            .from('invoices')
            .insert([
                {
                    user_id: userId,
                    deal_id: dealId,
                    invoice_number: invoiceNumber,
                    brand_email: brandEmail,
                    status: 'sent'
                }
            ])
            .select();

        if (error) {
            console.error('Supabase error:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        res.status(201).json({ success: true, data: data[0] });
    } catch (err) {
        console.error('Server error:', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// POST /api/invoices/generate - generate a PDF for a deal and return it
app.post('/api/invoices/generate', authenticate, async (req, res) => {
    try {
        const { dealId } = req.body;
        if (!dealId) return res.status(400).json({ success: false, error: 'dealId required' });

        // Fetch deal from DB
        const { data: deals, error: dealError } = await supabase
            .from('deals')
            .select('*')
            .eq('id', dealId)
            .limit(1);

        if (dealError) {
            console.error('Supabase error:', dealError);
            return res.status(500).json({ success: false, error: dealError.message });
        }

        const deal = deals && deals[0];
        if (!deal) return res.status(404).json({ success: false, error: 'Deal not found' });

        // Generate PDF using PDFKit
        const doc = new PDFDocument();
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=invoice-${deal.id}.pdf`);
        doc.fontSize(20).text('PayPoint Invoice', { align: 'center' });
        doc.moveDown();
        doc.fontSize(12).text(`Brand: ${deal.brand_name}`);
        doc.text(`Amount: $${Number(deal.amount).toLocaleString()}`);
        doc.text(`Deliverable: ${deal.deliverable || '—'}`);
        doc.text(`Due Date: ${deal.due_date || 'Not set'}`);
        doc.text(`Status: ${deal.status || 'pending'}`);
        doc.moveDown();
        doc.text('Thank you for using PayPoint.', { align: 'center' });
        doc.end();
        doc.pipe(res);
    } catch (err) {
        console.error('PDF generation error:', err);
        res.status(500).json({ success: false, error: 'Failed to generate PDF' });
    }
});

// POST /api/invoices/send - placeholder: generate + pretend to send invoice
app.post('/api/invoices/send', authenticate, async (req, res) => {
    try {
        const { dealId, brandEmail } = req.body;
        if (!dealId || !brandEmail) return res.status(400).json({ success: false, error: 'dealId and brandEmail required' });

        // For now, we won't integrate an email provider. We'll mark invoice as sent.
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

        const { data, error } = await supabase
            .from('invoices')
            .insert([
                {
                    user_id: userId,
                    deal_id: dealId,
                    brand_email: brandEmail,
                    status: 'sent'
                }
            ])
            .select();

        if (error) {
            console.error('Supabase error:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        // In a real app you'd send the PDF via email here.
        res.json({ success: true, data: data[0] });
    } catch (err) {
        console.error('Server error:', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Authentication middleware: validates bearer token and attaches `req.user`
async function authenticate(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader?.split(' ')[1];

        if (!token) return res.status(401).json({ error: 'No token provided' });
        // If JWT_SECRET provided, try to verify token locally
        const jwtSecret = process.env.JWT_SECRET || '';
        if (jwtSecret) {
            const jwt = require('jsonwebtoken');
            try {
                const decoded = jwt.verify(token, jwtSecret);
                req.user = decoded;
                return next();
            } catch (e) {
                // fall through to supabase verification
            }
        }

        const { data, error } = await supabase.auth.getUser(token);
        if (error || !data?.user) return res.status(401).json({ error: 'Invalid token' });

        req.user = data.user;
        next();
    } catch (err) {
        console.error('Auth middleware error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}

// Simple in-memory rate limiter factory (not for production)
function makeRateLimiter(maxRequests, windowMs) {
    const hits = new Map();
    return (req, res, next) => {
        try {
            const id = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
            const now = Date.now();
            const arr = hits.get(id) || [];
            const recent = arr.filter(ts => ts > now - windowMs);
            recent.push(now);
            hits.set(id, recent);
            if (recent.length > maxRequests) return res.status(429).json({ error: 'Too many requests' });
            next();
        } catch (err) {
            next();
        }
    };
}