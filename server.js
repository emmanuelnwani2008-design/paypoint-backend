require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');   // Force IPv4 globally

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const PDFDocument = require('pdfkit');
const { Resend } = require('resend');      // <-- KEPT (This is correct)
const crypto = require('crypto');
const cron = require('node-cron');
const multer = require('multer');
const nodemailer = require('nodemailer'); // <-- KEPT (For Gmail fallback)

const app = express();
app.set('trust proxy', 1);

const port = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://your-app.vercel.app';
console.log(`🌐 Frontend URL: ${FRONTEND_URL}`);

// ============================================
// SECURITY MIDDLEWARE (UNCHANGED)
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
    .map(o => o.trim())
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
    max: 5,
    keyGenerator: function (req) {
        const email = req.body?.email || '';
        const ip = req.ip || req.connection.remoteAddress;
        return `${ip}-${email}`;
    },
    skipSuccessfulRequests: true,
    message: { error: 'Too many failed attempts for this account. Please try again later.' },
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
// SUPABASE CLIENTS (UNCHANGED)
// ============================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
    console.error('❌ Missing required Supabase environment variables.');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

// ============================================
// EMAIL SETUP (UPDATED: Brevo REMOVED, Resend ADDED)
// ============================================

// 1. Instantiate Resend
const resend = new Resend(process.env.RESEND_API_KEY);

// 2. Gmail SMTP Transporter (KEPT for fallback)
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    tls: { rejectUnauthorized: false },
    requireTLS: true
});

// 3. NEW: Send email with Resend (Replaces Brevo)
async function sendEmailResend(to, subject, htmlContent) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
        console.log('⚠️ RESEND_API_KEY not set – skipping Resend.');
        return false;
    }

    try {
        const { data, error } = await resend.emails.send({
            from: process.env.EMAIL_FROM || 'PayPoint <onboarding@resend.dev>',
            to: [to],
            subject: subject,
            html: htmlContent,
        });

        if (error) {
            console.error('❌ Resend error:', error);
            return false;
        }

        console.log(`✅ Resend email sent to ${to}`);
        return true;
    } catch (err) {
        console.error('❌ Resend fetch error:', err.message);
        return false;
    }
}

// 4. UPDATED: Unified sender (Now tries Resend first, then Gmail)
async function sendEmailWithRetry(to, subject, html, retries = 2) {
    // 1. Try Resend (primary)
    if (process.env.RESEND_API_KEY) {
        const sent = await sendEmailResend(to, subject, html);
        if (sent) return true;
        console.log('⚠️ Resend failed – falling back to Gmail SMTP.');
    }

    // 2. Fallback to Gmail SMTP with retry
    const mailOptions = { from: process.env.EMAIL_USER, to, subject, html };
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            await transporter.sendMail(mailOptions);
            console.log(`📧 Gmail fallback sent (attempt ${attempt})`);
            return true;
        } catch (err) {
            console.log(`📧 Gmail attempt ${attempt} failed:`, err.message);
            if (attempt === retries) {
                console.error('❌ All email attempts failed.');
                return false;
            }
            await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
    }
    return false;
}

// ============================================
// CRON JOB – Automated Invoice Chasing (UNCHANGED)
// ============================================
cron.schedule('0 9 * * *', async () => {
    console.log('🔔 Running overdue invoice check...');

    try {
        const { data: invoices, error } = await supabase
            .from('invoices')
            .select(`
                *,
                deals ( id, brand_name, amount, due_date, user_id )
            `)
            .eq('status', 'sent')
            .eq('paid', false)
            .lt('reminder_count', 3);

        if (error) {
            console.error('Error fetching invoices:', error);
            return;
        }

        if (!invoices || invoices.length === 0) {
            console.log('✅ No overdue invoices to chase.');
            return;
        }

        console.log(`📨 Found ${invoices.length} overdue invoices.`);

        for (const invoice of invoices) {
            const deal = invoice.deals;
            if (!deal) continue;

            const dueDate = deal.due_date;
            if (!dueDate) continue;

            const { data: profile, error: profileError } = await supabase
                .from('profiles')
                .select('email, subscription_tier, user_metadata')
                .eq('id', deal.user_id)
                .single();

            if (profileError || !profile) {
                console.error(`❌ Could not find profile for user ${deal.user_id}`);
                continue;
            }

            if (profile.subscription_tier !== 'pro') continue;

            const daysOverdue = Math.floor((Date.now() - new Date(dueDate).getTime()) / (1000 * 60 * 60 * 24));

            let reminderType = 'first';
            let subject = '🔔 Friendly Reminder: Invoice Overdue';
            let urgency = 'gentle';

            if (daysOverdue >= 14) {
                reminderType = 'final';
                subject = '⚠️ URGENT: Invoice Final Notice';
                urgency = 'urgent';
            } else if (daysOverdue >= 7) {
                reminderType = 'second';
                subject = '⏰ Second Reminder: Invoice Overdue';
                urgency = 'moderate';
            }

            const brandEmail = profile.email || 'brand@example.com';
            const creatorName = profile.user_metadata?.name || 'Creator';
            const paymentLink = `${FRONTEND_URL}/pay-invoice.html?deal=${deal.id}`;

            const html = `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #E8EDF2; border-radius: 12px;">
                    <h1 style="color: #4F7CFF; text-align: center;">PayPoint</h1>
                    <hr>
                    <p>Dear Brand,</p>
                    <p>This is a <strong>${reminderType}</strong> reminder that invoice <strong>#${invoice.invoice_number}</strong> of <strong>₦${Number(deal.amount).toLocaleString()}</strong> is now <strong style="color: #FF3B30;">${daysOverdue} days overdue</strong>.</p>
                    ${urgency === 'urgent' ? '<p style="color: #FF3B30; font-weight: bold;">Please make payment immediately to avoid further escalation.</p>' : ''}
                    <div style="text-align: center; margin: 24px 0;">
                        <a href="${paymentLink}" style="background: #4F7CFF; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600;">
                            💳 Pay Now
                        </a>
                    </div>
                    <p style="font-size: 12px; color: #8A9AAB;">If you have already paid, please ignore this message. For questions, contact ${creatorName}.</p>
                    <hr>
                    <p style="text-align: center; color: #8A9AAB; font-size: 12px;">PayPoint · Finance OS for Creators</p>
                </div>
            `;

            const sent = await sendEmailWithRetry(brandEmail, subject, html);
            if (sent) {
                await supabase
                    .from('invoices')
                    .update({
                        reminder_count: invoice.reminder_count + 1,
                        last_reminder_sent_at: new Date().toISOString()
                    })
                    .eq('id', invoice.id);
                console.log(`✅ Reminder sent for invoice ${invoice.invoice_number} (${reminderType})`);
            } else {
                console.error(`❌ Failed to send reminder for invoice ${invoice.invoice_number}`);
            }
        }

    } catch (err) {
        console.error('Cron job error:', err);
    }
});

// ============================================
// HELPERS (UNCHANGED)
// ============================================
function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function sanitizeInput(str) {
    if (!str || typeof str !== 'string') return str;
    if (str.length > 10000) return str.substring(0, 10000);
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;', '/': '&#x2F;' };
    return str.replace(/[&<>"'\/]/g, m => map[m]);
}

function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function isValidAmount(amount) {
    const num = parseFloat(amount);
    return !isNaN(num) && num > 0 && num < 1e9;
}

// ============================================
// AUTHENTICATION (UNCHANGED)
// ============================================
async function authenticate(req, res, next) {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: 'Authentication required' });
        if (!/^[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+$/.test(token)) {
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
// TEST & HEALTH ROUTES (UNCHANGED)
// ============================================
app.get('/', (req, res) => {
    res.json({ message: '🚀 PayPoint API is running!', status: 'secure', timestamp: new Date().toISOString() });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime() });
});

app.get('/api/db-health', async (req, res) => {
    try {
        const { data, error } = await supabase.from('profiles').select('count').limit(1);
        if (error) throw error;
        res.json({ status: 'ok', message: 'Database connected' });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ============================================
// AUTH ROUTES (UNCHANGED)
// ============================================
app.post('/api/auth/signup', authLimiter, async (req, res) => {
    try {
        const { name, email, password } = req.body || {};
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
        if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email format' });
        if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
        if (password.length > 100) return res.status(400).json({ error: 'Password too long' });
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
        if (data.user) {
            await supabaseAdmin.from('profiles').upsert({ id: data.user.id }, { onConflict: 'id' });
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
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
        if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email format' });
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
        if (error) return res.status(400).json({ error: error.message });
        res.json({ success: true, message: 'Logged out successfully' });
    } catch (err) {
        console.error('Logout error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/auth/user', authenticate, async (req, res) => {
    try {
        const { data: profile, error } = await supabase
            .from('profiles')
            .select('subscription_tier, subscription_status, subscription_expires_at')
            .eq('id', req.userId)
            .single();

        if (error && error.code !== 'PGRST116') {
            console.error('Profile fetch error:', error);
        }

        const user = req.user;
        if (profile) {
            user.user_metadata = {
                ...user.user_metadata,
                subscription_tier: profile.subscription_tier,
                subscription_status: profile.subscription_status,
                subscription_expires_at: profile.subscription_expires_at
            };
        }
        res.json({ success: true, user });
    } catch (err) {
        console.error('Get user error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// ADMIN ROUTE – Force Pro (UNCHANGED)
// ============================================
app.post('/api/admin/force-pro', authenticate, async (req, res) => {
    try {
        const userId = req.userId;
        const { email } = req.user;
        const adminEmails = ['emmysmart850@gmail.com'];
        if (!adminEmails.includes(email)) {
            return res.status(403).json({ error: 'Access denied. Admin only.' });
        }

        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 30);

        const { error: upsertError } = await supabaseAdmin
            .from('profiles')
            .upsert({
                id: userId,
                subscription_tier: 'pro',
                subscription_status: 'active',
                subscription_expires_at: expiresAt.toISOString(),
                updated_at: new Date().toISOString()
            }, { onConflict: 'id' });

        if (upsertError) {
            console.error('❌ Error updating profile:', upsertError);
            return res.status(500).json({ error: 'Failed to upgrade to Pro' });
        }

        await supabaseAdmin.auth.admin.updateUserById(
            userId,
            { user_metadata: { subscription_tier: 'pro' } }
        );

        res.json({
            success: true,
            message: '✅ You are now Pro! (Testing only – expires in 30 days)',
            expires_at: expiresAt.toISOString()
        });
    } catch (err) {
        console.error('Force Pro error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// UPLOAD PROFILE PICTURE (UNCHANGED)
// ============================================
const storage = multer.memoryStorage();
const upload = multer({
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only images are allowed'), false);
        }
    }
});

app.post('/api/auth/upload-avatar', authenticate, upload.single('avatar'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No image file provided' });
        const userId = req.userId;
        const fileExt = req.file.originalname.split('.').pop();
        const fileName = `${userId}-${Date.now()}.${fileExt}`;

        const { data, error } = await supabaseAdmin
            .storage
            .from('avatars')
            .upload(fileName, req.file.buffer, {
                contentType: req.file.mimetype,
                upsert: true
            });
        if (error) throw error;

        const { data: urlData } = supabaseAdmin.storage.from('avatars').getPublicUrl(fileName);
        const avatarUrl = urlData.publicUrl;

        const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(
            userId,
            { user_metadata: { avatar_url: avatarUrl } }
        );
        if (updateError) throw updateError;

        res.json({ success: true, avatar_url: avatarUrl });
    } catch (err) {
        console.error('Avatar upload error:', err);
        res.status(500).json({ error: 'Failed to upload avatar: ' + err.message });
    }
});

// ============================================
// UPDATE PROFILE (UNCHANGED)
// ============================================
app.put('/api/auth/update', authenticate, async (req, res) => {
    try {
        const { name, bio } = req.body;
        if (!name) return res.status(400).json({ error: 'Name is required' });
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
// DEALS ROUTES (UNCHANGED)
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
        const { brand_name, amount, due_date, deliverable, status, currency } = req.body;
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
                status: status || 'pending',
                currency: currency || 'NGN'
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

app.put('/api/deals/:id', authenticate, async (req, res) => {
    try {
        const dealId = req.params.id;
        const userId = req.userId;
        const { brand_name, amount, due_date, deliverable, status, currency } = req.body;

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

        const { data: existing, error: findError } = await supabase
            .from('deals')
            .select('id')
            .eq('id', dealId)
            .eq('user_id', userId)
            .single();

        if (findError || !existing) {
            return res.status(404).json({ error: 'Deal not found or you do not own it' });
        }

        const { data, error } = await supabase
            .from('deals')
            .update({
                brand_name: sanitizedBrand,
                amount: parseFloat(amount),
                due_date: due_date || null,
                deliverable: sanitizedDeliverable || '',
                status: status || 'pending',
                currency: currency || 'NGN'
            })
            .eq('id', dealId)
            .eq('user_id', userId)
            .select();

        if (error) {
            console.error('Supabase update error:', error);
            return res.status(500).json({ error: error.message });
        }

        res.json({ success: true, data: data[0] });
    } catch (err) {
        console.error('Deals PUT error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/deals/:id', authenticate, async (req, res) => {
    try {
        const dealId = req.params.id;
        const userId = req.userId;

        const { data: existing, error: findError } = await supabase
            .from('deals')
            .select('id')
            .eq('id', dealId)
            .eq('user_id', userId)
            .single();

        if (findError || !existing) {
            return res.status(404).json({ error: 'Deal not found or you do not own it' });
        }

        const { error } = await supabase
            .from('deals')
            .delete()
            .eq('id', dealId)
            .eq('user_id', userId);

        if (error) {
            console.error('Supabase delete error:', error);
            return res.status(500).json({ error: error.message });
        }

        res.json({ success: true, message: 'Deal deleted successfully' });
    } catch (err) {
        console.error('Deals DELETE error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// EXPENSES ROUTES (UNCHANGED)
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
        const { vendor, amount, category, receipt_url, currency } = req.body;
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
                receipt_url: receipt_url || '',
                currency: currency || 'NGN'
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
// PAYSTACK ROUTES (UNCHANGED)
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

        const totalAmount = Math.round(deal.amount * 100);
        const callbackUrl = `${FRONTEND_URL}/success.html`;

        const subaccountCode = req.user?.user_metadata?.subaccount_code;
        if (!subaccountCode) {
            return res.status(400).json({ error: 'Please add your bank account in the Profile page first.' });
        }

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
                subaccount: subaccountCode,
                metadata: {
                    deal_id: dealId,
                    brand_name: deal.brand_name,
                    user_id: userId
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
        if (!reference || !/^[a-zA-Z0-9\-_]+$/.test(reference)) {
            return res.status(400).json({ error: 'Invalid reference format' });
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
// INVOICE ROUTES (UNCHANGED - but uses new email sender)
// ============================================

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

        const newInvoice = data[0];

        const portalToken = crypto.randomBytes(32).toString('hex');
        const { error: tokenError } = await supabase
            .from('invoices')
            .update({ portal_token: portalToken })
            .eq('id', newInvoice.id);

        if (tokenError) {
            console.error('❌ Failed to save portal token:', tokenError);
        } else {
            console.log(`✅ Portal token saved for invoice ${newInvoice.id}`);
        }

        const portalLink = `${FRONTEND_URL}/portal/${portalToken}`;

        const html = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #E8EDF2; border-radius: 12px;">
                <h1 style="color: #4F7CFF; text-align: center;">PayPoint</h1>
                <h2 style="text-align: center; color: #000000;">Invoice</h2>
                <hr>
                <p><strong>Invoice #:</strong> ${invNumber}</p>
                <p><strong>Brand:</strong> ${deal.brand_name}</p>
                <p><strong>Amount:</strong> <span style="font-size: 20px; font-weight: bold; color: #4F7CFF;">₦${Number(deal.amount).toLocaleString()}</span></p>
                <p><strong>Deliverable:</strong> ${deal.deliverable || 'Not specified'}</p>
                <p><strong>Due Date:</strong> ${deal.due_date ? new Date(deal.due_date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'Not set'}</p>
                <hr>
                <p style="text-align: center;">
                    <a href="${portalLink}" style="color: #4F7CFF; text-decoration: none;">📄 View Invoice Portal</a>
                </p>
                <p style="text-align: center; color: #8A9AAB; font-size: 12px;">PayPoint · Finance OS for Creators</p>
            </div>
        `;
        const subject = `📄 Invoice #${invNumber} from ${deal.brand_name}`;

        // *** THIS IS THE LINE THAT SENDS THE EMAIL USING THE NEW RESEND FUNCTION ***
        const sent = await sendEmailWithRetry(brandEmail, subject, html);

        if (sent) {
            console.log(`✅ Invoice email sent to ${brandEmail}`);
        } else {
            console.warn(`⚠️ All email attempts failed – but invoice was created.`);
        }

        res.status(201).json({
            success: true,
            data: newInvoice,
            portal_token: portalToken,
            email_sent: sent
        });

    } catch (err) {
        console.error('Invoice create error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

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

        doc.fontSize(24).font('Helvetica-Bold').text('PayPoint', { align: 'center' });
        doc.fontSize(12).font('Helvetica').text('Finance OS for Creators', { align: 'center' });
        doc.moveDown(0.5);
        doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke('#CCCCCC');
        doc.moveDown(1);

        doc.fontSize(20).font('Helvetica-Bold').text('INVOICE', { align: 'center' });
        doc.moveDown(0.5);

        doc.fontSize(10).font('Helvetica');
        doc.text(`Invoice #: ${invoiceNumber}`, 50, doc.y);
        doc.text(`Date: ${date}`, 400, doc.y - 12);
        doc.text(`Status: ${(deal.status || 'pending').toUpperCase()}`, 50, doc.y + 12);
        doc.moveDown(2);

        doc.fontSize(14).font('Helvetica-Bold').text('Brand Details', { underline: true });
        doc.moveDown(0.3);
        doc.fontSize(12).font('Helvetica');
        doc.text(`Brand Name: ${deal.brand_name}`);
        doc.text(`Email: ${req.user.email || 'Not provided'}`);
        doc.moveDown(1);

        doc.fontSize(14).font('Helvetica-Bold').text('Deal Details', { underline: true });
        doc.moveDown(0.3);
        doc.fontSize(12).font('Helvetica');
        doc.text(`Deliverable: ${deal.deliverable || 'Not specified'}`);
        doc.text(`Due Date: ${dueDate}`);
        doc.moveDown(1);

        doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke('#CCCCCC');
        doc.moveDown(0.5);

        doc.fontSize(16).font('Helvetica-Bold');
        doc.text(`Total Amount: $${Number(deal.amount).toLocaleString()}`, { align: 'right' });
        doc.moveDown(2);

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
// BANK ACCOUNT VERIFICATION & SUBACCOUNT (UNCHANGED)
// ============================================

app.post('/api/payments/verify-account', authenticate, async (req, res) => {
    try {
        const { bank_code, account_number } = req.body;

        if (!bank_code || !account_number) {
            return res.status(400).json({ error: 'Bank code and account number are required' });
        }

        if (!/^\d{10}$/.test(account_number)) {
            return res.status(400).json({ error: 'Account number must be exactly 10 digits' });
        }

        const response = await fetch(
            `https://api.paystack.co/bank/resolve?account_number=${account_number}&bank_code=${bank_code}`,
            {
                headers: { 'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}` }
            }
        );

        const result = await response.json();
        console.log('📊 Account verification response:', JSON.stringify(result, null, 2));

        if (!result.status) {
            let errorMsg = result.message || 'Account verification failed';
            if (result.data?.message) errorMsg = result.data.message;
            if (errorMsg.toLowerCase().includes('invalid')) {
                errorMsg = 'The account number could not be found. Please check and try again.';
            }
            return res.status(400).json({ error: errorMsg });
        }

        res.json({
            success: true,
            account_name: result.data.account_name,
            bank_name: result.data.bank_name
        });

    } catch (err) {
        console.error('Account verification error:', err);
        res.status(500).json({ error: 'Internal server error. Please try again.' });
    }
});

app.post('/api/payments/create-subaccount', authenticate, async (req, res) => {
    try {
        const userId = req.userId;
        const { bank_code, account_number, business_name } = req.body;

        if (!bank_code || !account_number) {
            return res.status(400).json({ error: 'Bank code and account number are required' });
        }

        if (!/^\d{10}$/.test(account_number)) {
            return res.status(400).json({ error: 'Account number must be exactly 10 digits' });
        }

        const businessName = (business_name || req.user?.user_metadata?.name || 'Creator').trim();
        if (!businessName) {
            return res.status(400).json({ error: 'Business name is required' });
        }

        const response = await fetch('https://api.paystack.co/subaccount', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`
            },
            body: JSON.stringify({
                business_name: businessName,
                bank_code: bank_code,
                account_number: account_number,
                percentage_charge: 0
            })
        });

        const result = await response.json();
        console.log('📊 Subaccount creation response:', JSON.stringify(result, null, 2));

        if (!result.status) {
            let errorMsg = result.message || 'Failed to create subaccount';
            if (result.data?.message) errorMsg = result.data.message;
            if (errorMsg.toLowerCase().includes('duplicate')) {
                errorMsg = 'This account is already registered. Please use a different account.';
            } else if (errorMsg.toLowerCase().includes('invalid')) {
                errorMsg = 'The account could not be validated. Please ensure the account is active and verified with BVN.';
            }
            return res.status(400).json({ error: errorMsg });
        }

        const { error: updateError } = await supabase.auth.updateUser({
            data: {
                subaccount_code: result.data.subaccount_code,
                bank_name: result.data.bank_name || 'Unknown',
                account_verified: true
            }
        });

        if (updateError) {
            console.error('Error saving subaccount code:', updateError);
            return res.status(500).json({ error: 'Failed to save subaccount. Please contact support.' });
        }

        res.json({
            success: true,
            message: 'Bank account added successfully! You can now receive payments.',
            subaccount_code: result.data.subaccount_code
        });

    } catch (err) {
        console.error('Create subaccount error:', err);
        res.status(500).json({ error: 'Internal server error. Please try again.' });
    }
});

// ============================================
// SUBSCRIPTION SYSTEM (Pro/Free) (UNCHANGED)
// ============================================

app.post('/api/subscribe', authenticate, async (req, res) => {
    try {
        const userId = req.userId;
        const userEmail = req.user?.email;

        if (!userEmail) {
            return res.status(400).json({ error: 'User email required' });
        }

        const { data: profile, error } = await supabase
            .from('profiles')
            .select('subscription_tier, subscription_status, subscription_expires_at')
            .eq('id', userId)
            .single();

        if (error && error.code !== 'PGRST116') {
            console.error('Profile fetch error:', error);
        }

        if (profile?.subscription_tier === 'pro' && profile?.subscription_status === 'active') {
            if (profile.subscription_expires_at && new Date(profile.subscription_expires_at) > new Date()) {
                return res.status(400).json({ 
                    error: 'You already have an active Pro subscription',
                    already_pro: true 
                });
            }
        }

        const response = await fetch('https://api.paystack.co/transaction/initialize', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
            },
            body: JSON.stringify({
                email: userEmail,
                amount: 300000,
                plan: process.env.PAYSTACK_PLAN_CODE,
                metadata: { user_id: userId },
                callback_url: `${FRONTEND_URL}/dashboard.html?subscription=success`
            })
        });

        const result = await response.json();

        if (!result.status) {
            return res.status(502).json({ error: result.message || 'Payment provider error' });
        }

        res.json({
            success: true,
            authorization_url: result.data.authorization_url,
            reference: result.data.reference
        });

    } catch (err) {
        console.error('Subscription error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// WEBHOOKS (UNCHANGED)
// ============================================

app.post('/api/webhooks/paystack',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
        try {
            const signature = req.headers['x-paystack-signature'];
            if (!signature) {
                return res.status(401).send('Missing signature');
            }

            const hash = crypto
                .createHmac('sha512', PAYSTACK_SECRET_KEY)
                .update(req.body)
                .digest('hex');

            if (hash !== signature) {
                return res.status(401).send('Invalid signature');
            }

            const event = JSON.parse(req.body.toString());
            console.log('📨 Webhook received:', event.event);

            if (event.event === 'charge.success' || event.event === 'subscription.create') {
                const userId = event.data.metadata?.user_id;
                if (!userId) {
                    console.error('❌ No user_id in webhook');
                    return res.status(400).send('Missing user_id');
                }

                const expiresAt = new Date();
                expiresAt.setDate(expiresAt.getDate() + 30);

                const { error: upsertError } = await supabaseAdmin
                    .from('profiles')
                    .upsert({
                        id: userId,
                        subscription_tier: 'pro',
                        subscription_status: 'active',
                        subscription_expires_at: expiresAt.toISOString(),
                        paystack_subscription_code: event.data.subscription?.subscription_code || null,
                        paystack_customer_code: event.data.customer?.customer_code || null,
                        updated_at: new Date().toISOString()
                    }, { onConflict: 'id' });

                if (upsertError) {
                    console.error('❌ Error updating profile:', upsertError);
                    return res.status(500).send('Database update failed');
                }

                console.log(`✅ User ${userId} upgraded to Pro (expires: ${expiresAt.toISOString()})`);
            }

            res.sendStatus(200);

        } catch (err) {
            console.error('Webhook error:', err);
            res.sendStatus(500);
        }
    }
);

app.post('/api/webhooks/paystack-deal',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
        try {
            const signature = req.headers['x-paystack-signature'];
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
            console.log('📨 Deal webhook event:', event.event);

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

                    await supabase
                        .from('invoices')
                        .update({
                            paid: true,
                            paid_at: new Date().toISOString()
                        })
                        .eq('deal_id', dealId);
                }
            }

            res.sendStatus(200);

        } catch (err) {
            console.error('Deal webhook error:', err);
            res.sendStatus(500);
        }
    }
);

// ============================================
// PUBLIC PORTAL - View Invoice (UNCHANGED)
// ============================================
app.get('/portal/:token', async (req, res) => {
    try {
        const { token } = req.params;

        if (!token) {
            return res.status(400).send('Invalid portal link');
        }

        const { data: invoice, error } = await supabase
            .from('invoices')
            .select(`
                *,
                deals(
                    id,
                    brand_name,
                    amount,
                    deliverable,
                    due_date,
                    user_id,
                    users(
                        email,
                        user_metadata->name
                    )
                )
            `)
            .eq('portal_token', token)
            .single();

        if (error || !invoice) {
            return res.status(404).send('Invoice not found');
        }

        const deal = invoice.deals;
        const creator = deal.users;
        const isPaid = invoice.paid || false;

        const brandName = escapeHtml(deal.brand_name);
        const deliverable = escapeHtml(deal.deliverable || 'Not specified');
        const invoiceNumber = escapeHtml(invoice.invoice_number);
        const creatorName = escapeHtml(creator?.user_metadata?.name || 'Creator');
        const amountFormatted = Number(deal.amount).toLocaleString();
        const dueDateFormatted = new Date(deal.due_date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

        res.send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Invoice · ${brandName}</title>
                <style>
                    * { margin: 0; padding: 0; box-sizing: border-box; }
                    body {
                        font-family: 'Inter', -apple-system, sans-serif;
                        background: #F8FAFC;
                        color: #000000;
                        padding: 24px;
                        min-height: 100vh;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                    }
                    .portal-container {
                        max-width: 600px;
                        width: 100%;
                        background: #FFFFFF;
                        border-radius: 16px;
                        border: 1px solid #E8EDF2;
                        padding: 40px 36px;
                        box-shadow: 0 4px 24px rgba(0,0,0,0.06);
                    }
                    .header { text-align: center; margin-bottom: 32px; }
                    .header h1 { font-size: 28px; font-weight: 700; color: #4F7CFF; }
                    .header p { color: #8A9AAB; font-size: 14px; }
                    .divider { border: none; border-top: 1px solid #E8EDF2; margin: 24px 0; }
                    .detail-row {
                        display: flex;
                        justify-content: space-between;
                        padding: 12px 0;
                        border-bottom: 1px solid #F0F2F5;
                    }
                    .detail-label { color: #8A9AAB; font-size: 14px; }
                    .detail-value { font-weight: 500; font-size: 14px; }
                    .amount {
                        font-size: 32px;
                        font-weight: 700;
                        color: #4F7CFF;
                        text-align: center;
                        padding: 16px 0;
                    }
                    .status-badge {
                        display: inline-block;
                        padding: 4px 16px;
                        border-radius: 40px;
                        font-size: 13px;
                        font-weight: 600;
                    }
                    .status-paid { background: #E8F9EF; color: #34C759; }
                    .status-pending { background: #FFF5E6; color: #FF9500; }
                    .btn-primary {
                        display: block;
                        width: 100%;
                        background: #4F7CFF;
                        border: none;
                        padding: 14px;
                        border-radius: 10px;
                        font-weight: 600;
                        font-size: 16px;
                        color: #FFFFFF;
                        cursor: pointer;
                        text-align: center;
                        text-decoration: none;
                        margin-top: 16px;
                        box-shadow: 0 2px 8px rgba(79, 124, 255, 0.25);
                        transition: all 0.2s ease;
                    }
                    .btn-primary:hover { background: #3A5FD9; transform: translateY(-1px); }
                    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
                    .footer {
                        text-align: center;
                        color: #8A9AAB;
                        font-size: 12px;
                        margin-top: 24px;
                        padding-top: 16px;
                        border-top: 1px solid #E8EDF2;
                    }
                </style>
            </head>
            <body>
                <div class="portal-container">
                    <div class="header">
                        <h1>💼 ${brandName}</h1>
                        <p>Invoice Portal · Powered by PayPoint</p>
                    </div>

                    <div class="amount">₦${amountFormatted}</div>

                    <div style="text-align: center; margin-bottom: 16px;">
                        <span class="status-badge ${isPaid ? 'status-paid' : 'status-pending'}">
                            ${isPaid ? '✅ Paid' : '⏳ Pending'}
                        </span>
                    </div>

                    <hr class="divider">

                    <div class="detail-row">
                        <span class="detail-label">Invoice #</span>
                        <span class="detail-value">${invoiceNumber}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Deliverable</span>
                        <span class="detail-value">${deliverable}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Due Date</span>
                        <span class="detail-value">${dueDateFormatted}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Creator</span>
                        <span class="detail-value">${creatorName}</span>
                    </div>

                    ${!isPaid ? `
                        <a href="${FRONTEND_URL}/pay-invoice.html?deal=${deal.id}" class="btn-primary">
                            💳 Pay Now
                        </a>
                    ` : `
                        <div style="text-align: center; color: #34C759; font-weight: 600; padding: 12px; background: #E8F9EF; border-radius: 8px; margin-top: 16px;">
                            ✅ This invoice has been paid. Thank you!
                        </div>
                    `}

                    <div class="footer">
                        PayPoint · Finance OS for Creators
                    </div>
                </div>
            </body>
            </html>
        `);

    } catch (err) {
        console.error('Portal error:', err);
        res.status(500).send('Something went wrong');
    }
});

// ============================================
// ERROR HANDLERS (UNCHANGED)
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
// START SERVER (UNCHANGED)
// ============================================
app.listen(port, () => {
    console.log(`🚀 PayPoint API running on port ${port}`);
    console.log(`🔒 Security: Helmet, CORS, Rate Limiting enabled`);
    console.log(`📧 Email: Resend (Primary) + Gmail (Fallback)`);
    console.log(`🌐 Allowed origins: ${allowedOrigins.join(', ')}`);
});