require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');

const app = express();
app.set('trust proxy', 1);

const port = process.env.PORT || 3000;

// ============================================
// SECURITY MIDDLEWARE
// ============================================

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'", "https://api.paystack.co", "https://*.supabase.co"],
        },
    },
    crossOriginEmbedderPolicy: false,
}));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'https://paypoint-app.netlify.app,http://localhost:3000')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) !== -1) {
            return callback(null, true);
        } else {
            return callback(new Error('Not allowed by CORS'));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
    maxAge: 86400,
}));

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

app.use(limiter);

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { error: 'Too many authentication attempts. Please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use((req, res, next) => {
    if (req.query && typeof req.query === 'object') {
        for (let key in req.query) {
            if (Array.isArray(req.query[key]) && req.query[key].length > 1) {
                return res.status(400).json({ error: 'Invalid parameter format' });
            }
        }
    }
    next();
});

// ============================================
// SUPABASE
// ============================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
    console.error('❌ Missing SUPABASE_URL or SUPABASE_ANON_KEY in environment variables.');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

// ============================================
// HELPERS
// ============================================
function isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}

function sanitizeInput(str) {
    if (!str || typeof str !== 'string') return str;
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;')
        .replace(/\//g, '&#x2F;');
}

function isValidAmount(amount) {
    const num = parseFloat(amount);
    return !isNaN(num) && num > 0 && num < 1000000000;
}

// ============================================
// AUTHENTICATION
// ============================================
async function authenticate(req, res, next) {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        if (!token.match(/^[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+$/)) {
            return res.status(401).json({ error: 'Invalid token format' });
        }
        const { data: userData, error } = await supabase.auth.getUser(token);
        if (error || !userData?.user) {
            return res.status(401).json({ error: 'Invalid or expired token' });
        }
        req.user = userData.user;
        req.userId = userData.user.id;
        next();
    } catch (err) {
        console.error('Auth error:', err);
        res.status(500).json({ error: 'Authentication failed' });
    }
}

// ============================================
// TEST ROUTES
// ============================================
app.get('/', (req, res) => {
    res.json({
        message: '🚀 PayPoint API is running!',
        status: 'secure',
        timestamp: new Date().toISOString(),
        version: '2.0.0'
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// ============================================
// AUTH ROUTES
// ============================================
app.post('/api/auth/signup', authLimiter, async (req, res) => {
    try {
        const { name, email, password } = req.body || {};
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }
        if (!isValidEmail(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }
        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }
        if (password.length > 100) {
            return res.status(400).json({ error: 'Password too long' });
        }
        const suspiciousPatterns = ['admin', 'root', 'test', 'password', '123456'];
        if (suspiciousPatterns.some(p => password.toLowerCase().includes(p))) {
            return res.status(400).json({ error: 'Password is too common' });
        }
        const sanitizedName = name ? sanitizeInput(name.trim()) : '';
        const { data, error } = await supabase.auth.signUp({
            email: email.toLowerCase().trim(),
            password,
            options: { data: { name: sanitizedName || '' } }
        });
        if (error) {
            console.error('Signup error:', error);
            return res.status(400).json({ error: error.message });
        }
        res.json({ success: true, user: data.user });
    } catch (err) {
        console.error('Signup server error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
    try {
        const { email, password } = req.body || {};
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }
        if (!isValidEmail(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }
        const { data, error } = await supabase.auth.signInWithPassword({
            email: email.toLowerCase().trim(),
            password
        });
        if (error) {
            console.error('Login error:', error);
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        res.json({ success: true, user: data.user, session: data.session });
    } catch (err) {
        console.error('Login server error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/auth/logout', authenticate, async (req, res) => {
    try {
        const { error } = await supabase.auth.signOut();
        if (error) {
            return res.status(400).json({ error: error.message });
        }
        res.json({ success: true, message: 'Logged out successfully' });
    } catch (err) {
        console.error('Logout error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/auth/user', authenticate, async (req, res) => {
    try {
        res.json({ success: true, user: req.user });
    } catch (err) {
        console.error('Get user error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// UPDATE PROFILE
// ============================================
app.put('/api/auth/update', authenticate, async (req, res) => {
    try {
        const { name, bio } = req.body;
        if (!name) {
            return res.status(400).json({ error: 'Name is required' });
        }
        const sanitizedName = sanitizeInput(name.trim());
        if (sanitizedName.length < 2 || sanitizedName.length > 50) {
            return res.status(400).json({ error: 'Name must be between 2 and 50 characters' });
        }
        const { data, error } = await supabase.auth.updateUser({
            data: { 
                name: sanitizedName,
                bio: bio ? sanitizeInput(bio.trim()) : ''
            }
        });
        if (error) {
            console.error('Update profile error:', error);
            return res.status(400).json({ error: error.message });
        }
        res.json({ success: true, user: data.user, message: 'Profile updated successfully' });
    } catch (err) {
        console.error('Update profile server error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// DEALS ROUTES
// ============================================
app.get('/api/deals', authenticate, async (req, res) => {
    try {
        const userId = req.userId;
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
        console.error('Deals GET error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/deals', authenticate, async (req, res) => {
    try {
        const userId = req.userId;
        const { brand_name, amount, due_date, deliverable, status } = req.body;
        if (!brand_name || !amount) {
            return res.status(400).json({ error: 'brand_name and amount required' });
        }
        const sanitizedBrand = sanitizeInput(brand_name.trim());
        if (sanitizedBrand.length < 2 || sanitizedBrand.length > 100) {
            return res.status(400).json({ error: 'Brand name must be between 2 and 100 characters' });
        }
        if (!isValidAmount(amount)) {
            return res.status(400).json({ error: 'Invalid amount' });
        }
        const sanitizedDeliverable = deliverable ? sanitizeInput(deliverable.trim()) : '';
        if (sanitizedDeliverable.length > 500) {
            return res.status(400).json({ error: 'Deliverable too long (max 500 characters)' });
        }
        if (due_date && isNaN(Date.parse(due_date))) {
            return res.status(400).json({ error: 'Invalid due date format' });
        }
        const { data, error } = await supabase
            .from('deals')
            .insert([{
                user_id: userId,
                brand_name: sanitizedBrand,
                amount: parseFloat(amount),
                due_date: due_date || null,
                deliverable: sanitizedDeliverable || '',
                status: status || 'pending'
            }])
            .select();
        if (error) {
            console.error('Supabase error:', error);
            return res.status(500).json({ error: error.message });
        }
        res.status(201).json({ success: true, data: data[0] });
    } catch (err) {
        console.error('Deals POST error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// EXPENSES ROUTES
// ============================================
app.get('/api/expenses', authenticate, async (req, res) => {
    try {
        const userId = req.userId;
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
        console.error('Expenses GET error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/expenses', authenticate, async (req, res) => {
    try {
        const userId = req.userId;
        const { vendor, amount, category, receipt_url } = req.body;
        if (!vendor || !amount) {
            return res.status(400).json({ error: 'vendor and amount required' });
        }
        const sanitizedVendor = sanitizeInput(vendor.trim());
        if (sanitizedVendor.length < 2 || sanitizedVendor.length > 100) {
            return res.status(400).json({ error: 'Vendor name must be between 2 and 100 characters' });
        }
        if (!isValidAmount(amount)) {
            return res.status(400).json({ error: 'Invalid amount' });
        }
        const validCategories = ['equipment', 'travel', 'meals', 'software', 'office', 'other', 'uncategorized'];
        const sanitizedCategory = category && validCategories.includes(category) ? category : 'uncategorized';
        if (receipt_url && !receipt_url.startsWith('data:image/')) {
            return res.status(400).json({ error: 'Invalid receipt format' });
        }
        const { data, error } = await supabase
            .from('expenses')
            .insert([{
                user_id: userId,
                vendor: sanitizedVendor,
                amount: parseFloat(amount),
                category: sanitizedCategory,
                receipt_url: receipt_url || ''
            }])
            .select();
        if (error) {
            console.error('Supabase error:', error);
            return res.status(500).json({ error: error.message });
        }
        res.status(201).json({ success: true, data: data[0] });
    } catch (err) {
        console.error('Expenses POST error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// PAYSTACK ROUTES
// ============================================
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
if (!PAYSTACK_SECRET_KEY) {
    console.error('❌ PAYSTACK_SECRET_KEY is missing. Set it in Render environment.');
    process.exit(1);
}

app.post('/api/payments/initialize', authenticate, async (req, res) => {
    try {
        const { dealId, email } = req.body;
        const userId = req.userId;

        if (!dealId) {
            return res.status(400).json({ error: 'dealId required' });
        }

        const { data: deal, error: dealError } = await supabase
            .from('deals')
            .select('*')
            .eq('id', dealId)
            .eq('user_id', userId)
            .single();

        if (dealError || !deal) {
            return res.status(404).json({ error: 'Deal not found' });
        }

        if (deal.status === 'paid') {
            return res.status(400).json({ error: 'This deal has already been paid' });
        }

        let customerEmail = email;
        if (!customerEmail || !isValidEmail(customerEmail)) {
            customerEmail = 'customer@paypoint.com';
        }

        const PLATFORM_FEE_PERCENT = 5;
        const totalAmount = Math.round(deal.amount * (1 + PLATFORM_FEE_PERCENT / 100) * 100);
        const callbackUrl = 'https://paypoint-backend.vercel.app/success.html';

        const response = await fetch('https://api.paystack.co/transaction/initialize', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
            },
            body: JSON.stringify({
                email: customerEmail,
                amount: totalAmount,
                callback_url: callbackUrl,
                metadata: {
                    deal_id: dealId,
                    brand_name: deal.brand_name,
                    user_id: userId,
                    platform_fee: (totalAmount / 100) - deal.amount
                }
            })
        });

        const result = await response.json();

        if (!result.status) {
            console.error('Paystack error:', result);
            return res.status(502).json({ error: 'Payment provider error: ' + (result.message || '') });
        }

        res.json({
            success: true,
            authorization_url: result.data.authorization_url,
            reference: result.data.reference
        });

    } catch (err) {
        console.error('Paystack initialize error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/payments/verify/:reference', authenticate, async (req, res) => {
    try {
        const { reference } = req.params;
        if (!reference) {
            return res.status(400).json({ error: 'Reference required' });
        }

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
        const amountVerified = result.data.amount / 100;

        if (paid && dealId) {
            const { data: deal } = await supabase
                .from('deals')
                .select('amount, status')
                .eq('id', dealId)
                .single();

            if (deal) {
                if (deal.status === 'paid') {
                    return res.json({
                        success: true,
                        status: 'success',
                        paid: true,
                        amount: amountVerified,
                        brand_name: result.data.metadata?.brand_name || 'Unknown',
                        already_paid: true
                    });
                }

                if (Math.abs(deal.amount - amountVerified) > 0.01) {
                    console.error(`Amount mismatch: Expected ${deal.amount}, got ${amountVerified}`);
                    return res.status(400).json({ error: 'Amount mismatch' });
                }

                const { error } = await supabase
                    .from('deals')
                    .update({
                        status: 'paid',
                        paid_at: new Date().toISOString()
                    })
                    .eq('id', dealId);

                if (error) {
                    console.error('Error updating deal:', error);
                } else {
                    console.log(`✅ Deal ${dealId} marked as paid`);
                }
            }
        }

        res.json({
            success: true,
            status: status,
            paid: paid,
            amount: amountVerified,
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

// CREATE INVOICE (saves to database and sends email)
app.post('/api/invoices/create', authenticate, async (req, res) => {
    try {
        const { dealId, invoiceNumber, brandEmail } = req.body;
        const userId = req.userId;

        if (!dealId || !brandEmail) {
            return res.status(400).json({ error: 'dealId and brandEmail required' });
        }

        if (!isValidEmail(brandEmail)) {
            return res.status(400).json({ error: 'Invalid brand email format' });
        }

        const { data: deal, error: dealError } = await supabase
            .from('deals')
            .select('*')
            .eq('id', dealId)
            .eq('user_id', userId)
            .single();

        if (dealError || !deal) {
            return res.status(404).json({ error: 'Deal not found' });
        }

        const invNumber = invoiceNumber || `INV-${Date.now()}`;
        const { data, error } = await supabase
            .from('invoices')
            .insert([{
                user_id: userId,
                deal_id: dealId,
                invoice_number: invNumber,
                brand_email: brandEmail.toLowerCase().trim(),
                status: 'sent'
            }])
            .select();

        if (error) {
            console.error('Invoice create error:', error);
            return res.status(500).json({ error: error.message });
        }

        // Try to send email if credentials are set
        if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
            try {
                const transporter = nodemailer.createTransport({
                    service: 'gmail',
                    auth: {
                        user: process.env.EMAIL_USER,
                        pass: process.env.EMAIL_PASS
                    }
                });

                const dueDate = deal.due_date ? new Date(deal.due_date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'Not set';

                await transporter.sendMail({
                    from: process.env.EMAIL_USER,
                    to: brandEmail,
                    subject: `📄 Invoice #${invNumber} from ${deal.brand_name}`,
                    html: `
                        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #E8EDF2; border-radius: 12px;">
                            <h1 style="color: #4F7CFF; text-align: center;">PayPoint</h1>
                            <h2 style="text-align: center; color: #000000;">Invoice</h2>
                            <hr style="border: none; border-top: 1px solid #E8EDF2;">
                            <p><strong>Invoice #:</strong> ${invNumber}</p>
                            <p><strong>Brand:</strong> ${deal.brand_name}</p>
                            <p><strong>Amount:</strong> <span style="font-size: 20px; font-weight: bold; color: #4F7CFF;">$${Number(deal.amount).toLocaleString()}</span></p>
                            <p><strong>Deliverable:</strong> ${deal.deliverable || 'Not specified'}</p>
                            <p><strong>Due Date:</strong> ${dueDate}</p>
                            <hr style="border: none; border-top: 1px solid #E8EDF2;">
                            <p style="text-align: center; color: #8A9AAB; font-size: 14px;">
                                <a href="https://paypoint-backend.vercel.app/invoice.html" style="color: #4F7CFF; text-decoration: none;">View Invoice</a> · 
                                PayPoint · Finance OS for Creators
                            </p>
                        </div>
                    `
                });
                console.log(`✅ Invoice email sent to ${brandEmail}`);
            } catch (emailErr) {
                console.error('❌ Email send error:', emailErr);
            }
        } else {
            console.log('ℹ️ Email credentials not set – email not sent.');
        }

        res.status(201).json({ success: true, data: data[0] });

    } catch (err) {
        console.error('Invoice create error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GENERATE INVOICE PDF (Preview & Download)
app.post('/api/invoices/generate', authenticate, async (req, res) => {
    try {
        const { dealId } = req.body;
        const userId = req.userId;

        if (!dealId) {
            return res.status(400).json({ error: 'dealId required' });
        }

        const { data: deal, error } = await supabase
            .from('deals')
            .select('*')
            .eq('id', dealId)
            .eq('user_id', userId)
            .single();

        if (error || !deal) {
            return res.status(404).json({ error: 'Deal not found' });
        }

        const invoiceNumber = `INV-${Date.now().toString().slice(-8)}`;
        const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
        const dueDate = deal.due_date ? new Date(deal.due_date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'Not set';

        const doc = new PDFDocument({ size: 'A4', margin: 50 });

        res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `inline; filename=invoice-${deal.brand_name}-${Date.now()}.pdf`
        });

        doc.pipe(res);

        // Header
        doc.fontSize(24).font('Helvetica-Bold').text('PayPoint', { align: 'center' });
        doc.fontSize(12).font('Helvetica').text('Finance OS for Creators', { align: 'center' });
        doc.moveDown(0.5);
        doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke('#CCCCCC');
        doc.moveDown(1);

        // Title
        doc.fontSize(20).font('Helvetica-Bold').text('INVOICE', { align: 'center' });
        doc.moveDown(0.5);

        // Metadata
        doc.fontSize(10).font('Helvetica');
        doc.text(`Invoice #: ${invoiceNumber}`, 50, doc.y);
        doc.text(`Date: ${date}`, 400, doc.y - 12);
        doc.text(`Status: ${(deal.status || 'pending').toUpperCase()}`, 50, doc.y + 12);
        doc.moveDown(2);

        // Brand Details
        doc.fontSize(14).font('Helvetica-Bold').text('Brand Details', { underline: true });
        doc.moveDown(0.3);
        doc.fontSize(12).font('Helvetica');
        doc.text(`Brand Name: ${deal.brand_name}`);
        doc.text(`Email: ${req.user.email || 'Not provided'}`);
        doc.moveDown(1);

        // Deal Details
        doc.fontSize(14).font('Helvetica-Bold').text('Deal Details', { underline: true });
        doc.moveDown(0.3);
        doc.fontSize(12).font('Helvetica');
        doc.text(`Deliverable: ${deal.deliverable || 'Not specified'}`);
        doc.text(`Due Date: ${dueDate}`);
        doc.moveDown(1);

        doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke('#CCCCCC');
        doc.moveDown(0.5);

        // Amount
        doc.fontSize(16).font('Helvetica-Bold');
        doc.text(`Total Amount: $${Number(deal.amount).toLocaleString()}`, { align: 'right' });
        doc.moveDown(2);

        // Footer
        doc.fontSize(10).font('Helvetica');
        doc.text('Thank you for your business!', { align: 'center' });
        doc.text('Payment is due within 30 days of invoice date.', { align: 'center' });
        doc.text('For questions, contact: support@paypoint.com', { align: 'center' });
        doc.moveDown(1);
        doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke('#EEEEEE');
        doc.moveDown(0.3);
        doc.fontSize(8).text('PayPoint · Finance OS for Creators · www.paypoint.com', { align: 'center' });

        doc.end();

    } catch (err) {
        console.error('Invoice generation error:', err);
        res.status(500).json({ error: 'Failed to generate invoice: ' + err.message });
    }
});

// ============================================
// PAYSTACK WEBHOOK
// ============================================
app.post('/api/webhooks/paystack',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
        try {
            const signature = req.headers['x-paystack-signature'];
            const crypto = require('crypto');

            if (!signature) {
                console.error('Missing webhook signature');
                return res.status(401).send('Missing signature');
            }

            const hash = crypto
                .createHmac('sha512', PAYSTACK_SECRET_KEY)
                .update(req.body)
                .digest('hex');

            if (hash !== signature) {
                console.error('Invalid webhook signature');
                return res.status(401).send('Invalid signature');
            }

            const event = JSON.parse(req.body.toString());
            console.log('📨 Webhook event:', event.event);

            if (event.event === 'charge.success') {
                const dealId = event.data.metadata?.deal_id;
                const amountPaid = event.data.amount / 100;

                if (dealId) {
                    const { data: deal, error: dealError } = await supabase
                        .from('deals')
                        .select('amount, status')
                        .eq('id', dealId)
                        .single();

                    if (dealError) {
                        console.error('Error fetching deal:', dealError);
                        return res.sendStatus(500);
                    }

                    if (deal.status === 'paid') {
                        console.log(`⚠️ Deal ${dealId} already marked as paid`);
                        return res.sendStatus(200);
                    }

                    if (Math.abs(deal.amount - amountPaid) > 0.01) {
                        console.error(`❌ Amount mismatch: Expected ${deal.amount}, got ${amountPaid}`);
                        return res.sendStatus(400);
                    }

                    const { error: updateError } = await supabase
                        .from('deals')
                        .update({
                            status: 'paid',
                            paid_at: new Date().toISOString()
                        })
                        .eq('id', dealId);

                    if (updateError) {
                        console.error('Error updating deal:', updateError);
                        return res.sendStatus(500);
                    }

                    console.log(`✅ Deal ${dealId} marked as paid via webhook`);
                }
            }

            res.sendStatus(200);

        } catch (err) {
            console.error('Webhook error:', err);
            res.sendStatus(500);
        }
    }
);

// ============================================
// ERROR HANDLERS
// ============================================
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        error: 'Something went wrong',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

// ============================================
// START SERVER
// ============================================
app.listen(port, () => {
    console.log(`🚀 PayPoint API running on port ${port}`);
    console.log(`🔒 Security: Helmet, CORS, Rate Limiting enabled`);
    console.log(`🌐 Allowed origins: ${allowedOrigins.join(', ')}`);
});