const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const PDFDocument = require('pdfkit');
const crypto = require('crypto');
const cron = require('node-cron');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const { findMatchingAuthUser } = require('./account-reconciliation');

const app = express();
app.use(cookieParser());
app.set('trust proxy', 1);

const port = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://paypoint-backend.vercel.app';
console.log(`🌐 Frontend URL: ${FRONTEND_URL}`);
const IS_PROD = process.env.NODE_ENV === 'production';
const COOKIE_SAME_SITE = IS_PROD ? 'none' : 'lax';

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

const defaultAllowedOrigins = ['https://paypoint-app.netlify.app', 'https://paypoint-backend.vercel.app', 'http://localhost:3000'];
const allowedOrigins = (process.env.ALLOWED_ORIGINS || defaultAllowedOrigins.join(','))
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
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
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
    console.log(`📨 ${req.method} ${req.originalUrl}`);
    next();
});

app.use((req, res, next) => {
    console.log(`🔍 EXACT REQUEST: ${req.method} ${req.originalUrl} (raw: ${req.url})`);
    next();
});

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
// SUPABASE CLIENTS
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
// EMAIL DISABLED (Console Logger for Testing)
// ============================================
async function sendEmailWithRetry(to, subject, html, retries = 2) {
    const linkMatch = html.match(/https:\/\/[^"]+\/portal\/[a-f0-9]+/);
    
    // ✅ SECURITY: Only log in development, hide in production
    if (process.env.NODE_ENV !== 'production') {
        console.log(`📧 ========== INVOICE READY ==========`);
        console.log(`📧 Brand Email: ${to}`);
        console.log(`📧 Subject: ${subject}`);
        if (linkMatch) {
            console.log(`🔗 COPY THIS LINK TO PAY: ${linkMatch[0]}`);
        } else {
            console.log(`📧 No link found in HTML.`);
        }
        console.log(`📧 ===================================`);
    } else {
        console.log(`✅ Invoice prepared (email hidden)`);
    }
    return true;
}

// ============================================
// CRON JOB – Automated Invoice Chasing
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
                console.log(`✅ Reminder logged for invoice ${invoice.invoice_number} (${reminderType})`);
            } else {
                console.error(`❌ Failed to log reminder for invoice ${invoice.invoice_number}`);
            }
        }

    } catch (err) {
        console.error('Cron job error:', err);
    }
});

// ============================================
// HELPERS
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
// SUBSCRIPTION & USAGE HELPERS
// ============================================

const PLAN_LIMITS = {
    free: {
        max_deals: 5,
        max_invoices: 5,
        max_expenses: 10,
    },
    pro: {
        max_deals: 999999,
        max_invoices: 999999,
        max_expenses: 999999,
    }
};

async function getUserPlan(userId) {
    const { data: profile, error } = await supabase
        .from('profiles')
        .select('subscription_tier, subscription_status, subscription_expires_at')
        .eq('id', userId)
        .single();
    if (error || !profile) return { tier: 'free', status: 'active' };
    if (profile.subscription_tier === 'pro' &&
        profile.subscription_status === 'active' &&
        profile.subscription_expires_at &&
        new Date(profile.subscription_expires_at) < new Date()) {
        return { tier: 'free', status: 'expired' };
    }
    return {
        tier: profile.subscription_tier || 'free',
        status: profile.subscription_status || 'active'
    };
}

async function checkUsageLimit(userIdOrIds, resourceType) {
    // Accept a single userId or an array of userIds (for reconciled/merged accounts)
    const ids = Array.isArray(userIdOrIds) ? userIdOrIds.filter(Boolean) : [userIdOrIds];
    // Use the first id to determine plan (primary account)
    const plan = await getUserPlan(ids[0]);
    const limits = PLAN_LIMITS[plan.tier];
    const max = limits[`max_${resourceType}s`] || 999999;
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const table = resourceType === 'deal' ? 'deals' :
                  resourceType === 'invoice' ? 'invoices' : 'expenses';

    try {
        let query = supabaseAdmin
            .from(table)
            .select('id', { count: 'exact', head: true })
            .gte('created_at', monthStart.toISOString());

        if (ids.length === 1) {
            query = query.eq('user_id', ids[0]);
        } else {
            query = query.in('user_id', ids);
        }

        const { count, error } = await query;
        if (error) {
            console.error('Usage check error:', error);
            return { allowed: true, current: 0, max: 999999, tier: plan.tier };
        }

        const current = count || 0;
        return {
            allowed: current < max,
            current: current,
            max: max,
            tier: plan.tier
        };
    } catch (err) {
        console.error('Usage check exception:', err);
        return { allowed: true, current: 0, max: 999999, tier: plan.tier };
    }
}

// ============================================
// AUTHENTICATION
// ============================================
async function authenticate(req, res, next) {
    try {
        // --------------------------------------------
        // 1. TOKEN RETRIEVAL (Hybrid)
        //    - Try HttpOnly cookie first (more secure)
        //    - Fallback to Authorization header (for invoice page)
        // --------------------------------------------
        let token = req.cookies?.paypoint_session;
        if (!token) {
            const authHeader = req.headers.authorization;
            if (authHeader && authHeader.startsWith('Bearer ')) {
                token = authHeader.split(' ')[1];
            }
        }

        if (!token) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        // --------------------------------------------
        // 2. TOKEN FORMAT VALIDATION (JWT format)
        // --------------------------------------------
        if (!/^[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+$/.test(token)) {
            return res.status(401).json({ error: 'Invalid token format' });
        }

        // --------------------------------------------
        // 3. VERIFY TOKEN WITH SUPABASE
        // --------------------------------------------
        const { data: userData, error } = await supabase.auth.getUser(token);
        if (error || !userData?.user) {
            return res.status(401).json({ error: 'Invalid or expired token' });
        }

        // --------------------------------------------
        // 4. SET USER DATA ON REQUEST OBJECT
        // --------------------------------------------
        req.user = userData.user;
        req.userId = userData.user.id;

        // --------------------------------------------
        // 5. ENSURE USER HAS A PROFILE WITH DEFAULT CURRENCY
        //    - This is critical for Google sign‑in users who may not have a profile yet.
        //    - Default set to 'USD' per your preference.
        // --------------------------------------------
        const { data: profile, error: profileError } = await supabaseAdmin
            .from('profiles')
            .select('default_currency')
            .eq('id', req.userId)
            .single();

        if (profileError && profileError.code === 'PGRST116') {
    // Profile doesn't exist – create it
    await supabaseAdmin.from('profiles').insert({
        id: req.userId,
        default_currency: 'USD',
        subscription_tier: 'free',
        subscription_status: 'active'
    });
} else if (profile && !profile.default_currency) {
    // Profile exists but default_currency is null – update it
    await supabaseAdmin.from('profiles')
        .update({
            default_currency: 'USD',
            subscription_tier: 'free',
            subscription_status: 'active'
        })
        .eq('id', req.userId);
}

        // --------------------------------------------
        // 6. ACCOUNT RECONCILIATION (Keep your existing logic)
        //    - Merges accounts with the same email (if you use it).
        // --------------------------------------------
        const email = userData.user?.email;
        if (email) {
            const { data: userMatches, error: listError } = await supabaseAdmin.auth.admin.listUsers();
            if (!listError) {
                const matchingUser = findMatchingAuthUser(userMatches?.users, userData.user.id, email);
                if (matchingUser) {
                    req.reconciledUserId = matchingUser.id;
                    req.reconciledUserEmail = matchingUser.email;
                }
            }
        }

        // --------------------------------------------
        // 7. PROCEED TO NEXT MIDDLEWARE / ROUTE
        // --------------------------------------------
        next();

    } catch (err) {
        console.error('Authentication error:', err);
        res.status(500).json({ error: 'Authentication failed' });
    }
}

// (Removed stray top-level await block that caused startup errors.)

// ============================================
// DASHBOARD STATS WITH REAL PERCENTAGES
// ============================================

app.get('/api/dashboard/stats', authenticate, async (req, res) => {
    try {
        const userId = req.userId;
        const fallbackUserId = req.reconciledUserId || null;
        const ids = [userId, fallbackUserId].filter(Boolean);

        console.log('📊 Dashboard stats for user IDs:', ids);

        const now = new Date();
        const currentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

        // Fetch deals and expenses using supabaseAdmin
        let allDeals = [];
        if (ids.length === 1) {
            const { data, error } = await supabaseAdmin
                .from('deals')
                .select('amount, currency, created_at')
                .eq('user_id', ids[0]);
            if (error) console.error('Deals query error:', error);
            allDeals = data || [];
        } else {
            const { data, error } = await supabaseAdmin
                .from('deals')
                .select('amount, currency, created_at')
                .in('user_id', ids);
            if (error) console.error('Deals query error:', error);
            allDeals = data || [];
        }

        let allExpenses = [];
        if (ids.length === 1) {
            const { data, error } = await supabaseAdmin
                .from('expenses')
                .select('amount, currency, created_at')
                .eq('user_id', ids[0]);
            if (error) console.error('Expenses query error:', error);
            allExpenses = data || [];
        } else {
            const { data, error } = await supabaseAdmin
                .from('expenses')
                .select('amount, currency, created_at')
                .in('user_id', ids);
            if (error) console.error('Expenses query error:', error);
            allExpenses = data || [];
        }

        console.log(`📊 Found ${allDeals.length} deals and ${allExpenses.length} expenses`);

        // Convert dates to ISO for reliable comparison
        const currentMonthStart = currentMonth.toISOString();
        const currentMonthEnd = nextMonth.toISOString();
        const lastMonthStart = lastMonth.toISOString();
        const lastMonthEnd = currentMonth.toISOString();

        const currentRevenue = allDeals
            .filter(d => d.created_at >= currentMonthStart && d.created_at < currentMonthEnd)
            .reduce((sum, d) => sum + Number(d.amount), 0);

        const lastRevenue = allDeals
            .filter(d => d.created_at >= lastMonthStart && d.created_at < lastMonthEnd)
            .reduce((sum, d) => sum + Number(d.amount), 0);

        const currentExpenses = allExpenses
            .filter(e => e.created_at >= currentMonthStart && e.created_at < currentMonthEnd)
            .reduce((sum, e) => sum + Number(e.amount), 0);

        const lastExpenses = allExpenses
            .filter(e => e.created_at >= lastMonthStart && e.created_at < lastMonthEnd)
            .reduce((sum, e) => sum + Number(e.amount), 0);

        // Determine change: 'new' if no previous data, otherwise percentage
        const revenueChange = lastRevenue > 0
            ? Math.round(((currentRevenue - lastRevenue) / lastRevenue) * 100)
            : (currentRevenue > 0 ? 'new' : 0);

        const expensesChange = lastExpenses > 0
            ? Math.round(((currentExpenses - lastExpenses) / lastExpenses) * 100)
            : (currentExpenses > 0 ? 'new' : 0);

        // Get user's tax rate from profile
        const { data: profile, error: profileError } = await supabaseAdmin
            .from('profiles')
            .select('tax_rate')
            .eq('id', userId)
            .single();

        if (profileError) {
            console.error('Error fetching tax rate:', profileError);
        }
        const taxRate = profile?.tax_rate || 30;

        // Total revenue (all time)
        const totalRevenue = allDeals.reduce((sum, d) => sum + Number(d.amount), 0);
        const totalExpenses = allExpenses.reduce((sum, e) => sum + Number(e.amount), 0);
        const taxes = totalRevenue * (taxRate / 100);
        const takeHome = totalRevenue - taxes - totalExpenses;

        res.json({
            success: true,
            data: {
                totalRevenue,
                totalExpenses,
                taxes,
                takeHome,
                revenueChange,
                expensesChange,
                taxRate
            }
        });

    } catch (err) {
        console.error('Dashboard stats error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============================================
// GET USAGE DATA (for dashboard rings)
// ============================================
app.get('/api/usage', authenticate, async (req, res) => {
    try {
        const userId = req.userId;
        const fallbackUserId = req.reconciledUserId || null;
        const ids = [userId, fallbackUserId].filter(Boolean);
        const dealUsage = await checkUsageLimit(ids, 'deal');
        const invoiceUsage = await checkUsageLimit(ids, 'invoice');
        const expenseUsage = await checkUsageLimit(ids, 'expense');
        res.json({
            success: true,
            deals: { current: dealUsage.current, max: dealUsage.max },
            invoices: { current: invoiceUsage.current, max: invoiceUsage.max },
            expenses: { current: expenseUsage.current, max: expenseUsage.max }
        });
    } catch (err) {
        console.error('Usage API error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============================================
// UPDATE TAX RATE
// ============================================

app.put('/api/profile/tax-rate', authenticate, async (req, res) => {
    try {
        const userId = req.userId;
        const { taxRate } = req.body;

        if (!taxRate || taxRate < 0 || taxRate > 100) {
            return res.status(400).json({ error: 'Tax rate must be between 0 and 100' });
        }

        const { error } = await supabase
            .from('profiles')
            .update({ tax_rate: taxRate })
            .eq('id', userId);

        if (error) {
            console.error('Update tax rate error:', error);
            return res.status(500).json({ error: 'Failed to update tax rate' });
        }

        res.json({ success: true, message: 'Tax rate updated successfully' });
    } catch (err) {
        console.error('Tax rate update error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============================================
// USER SETTINGS – GET
// ============================================

app.get('/api/settings', authenticate, async (req, res) => {
    try {
        const userId = req.userId;

        const { data: profile, error } = await supabaseAdmin
            .from('profiles')
            .select('default_currency, tax_rate')
            .eq('id', userId)
            .single();

        if (error) {
            console.error('Settings fetch error:', error);
            return res.status(500).json({ error: 'Failed to fetch settings' });
        }

        res.json({
            success: true,
            data: {
                currency: profile?.default_currency || 'NGN',
                taxRate: profile?.tax_rate || 30
            }
        });
    } catch (err) {
        console.error('Settings error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============================================
// USER SETTINGS – UPDATE
// ============================================

app.put('/api/settings', authenticate, async (req, res) => {
    try {
        const userId = req.userId;
        const { currency, taxRate } = req.body;

        const updates = {};
        if (currency && ['NGN', 'USD'].includes(currency)) {
            updates.default_currency = currency;
        }
        if (taxRate !== undefined && taxRate >= 0 && taxRate <= 100) {
            updates.tax_rate = taxRate;
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ error: 'No valid settings to update' });
        }

        const { error } = await supabaseAdmin
            .from('profiles')
            .update(updates)
            .eq('id', userId);

        if (error) {
            console.error('Settings update error:', error);
            return res.status(500).json({ error: 'Failed to update settings: ' + error.message });
        }

        if (updates.default_currency) {
            await supabase.auth.updateUser({
                data: { default_currency: updates.default_currency }
            });
        }

        const { data: profile, error: fetchError } = await supabaseAdmin
            .from('profiles')
            .select('default_currency, tax_rate')
            .eq('id', userId)
            .single();

        if (fetchError) {
            console.error('Error fetching updated profile:', fetchError);
        }

        res.json({
            success: true,
            message: 'Settings updated successfully',
            data: profile || null
        });
    } catch (err) {
        console.error('Settings update error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============================================
// TEST & HEALTH ROUTES
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

app.get('/api/test', (req, res) => {
    res.json({ status: 'ok', message: 'This is the latest code!' });
});

app.get('/api/public/deal/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { data: deal, error } = await supabaseAdmin
            .from('deals')
            .select('id, brand_name, amount, currency, due_date, deliverable, status')
            .eq('id', id)
            .single();

        if (error || !deal) {
            console.error('Public deal fetch: not found or error', error);
            return res.status(404).json({ error: 'Deal not found' });
        }

        res.json({ success: true, data: deal });
    } catch (err) {
        console.error('Public deal fetch error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============================================
// AUTH ROUTES
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
            await supabaseAdmin.from('profiles').upsert({
                id: data.user.id,
                default_currency: 'USD',
                subscription_tier: 'free'
            }, { onConflict: 'id' });
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

        // ✅ Set the cookie (for all pages that use cookies)
        res.cookie('paypoint_session', data.session.access_token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'Lax',
            maxAge: 7 * 24 * 60 * 60 * 1000
        });

        // ✅ Also return the session (so invoice page can store token in localStorage)
        res.json({ success: true, user: data.user, session: data.session });
    } catch (err) {
        console.error('Login server error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/auth/logout', authenticate, async (req, res) => {
    try {
        // Clear the cookie if present
        res.clearCookie('paypoint_session');
        
        // Sign out from Supabase
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
// GOOGLE OAUTH – SET HTTPONLY COOKIE
// ============================================

app.post('/api/auth/oauth', async (req, res) => {
    try {
        const { access_token } = req.body;
        if (!access_token) {
            return res.status(400).json({ error: 'Access token required' });
        }

        const { data: userData, error } = await supabase.auth.getUser(access_token);
        if (error || !userData?.user) {
            console.error('OAuth token verification failed:', error);
            return res.status(401).json({ error: 'Invalid or expired token' });
        }

        // ✅ Set cookie
        res.cookie('paypoint_session', access_token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'Lax',
            maxAge: 7 * 24 * 60 * 60 * 1000
        });

        // ✅ Return session
        res.json({
            success: true,
            user: userData.user,
            session: { access_token: access_token }
        });
    } catch (err) {
        console.error('OAuth error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============================================
// DELETE USER ACCOUNT
// ============================================
app.delete('/api/auth/delete', authenticate, async (req, res) => {
    try {
        const userId = req.userId;

        await supabaseAdmin.from('deals').delete().eq('user_id', userId);
        await supabaseAdmin.from('expenses').delete().eq('user_id', userId);
        await supabaseAdmin.from('invoices').delete().eq('user_id', userId);

        await supabaseAdmin.from('profiles').delete().eq('id', userId);

        const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);

        if (error) {
            console.error('Error deleting user:', error);
            return res.status(500).json({ error: 'Failed to delete account' });
        }

        res.json({ success: true, message: 'Account deleted successfully' });
    } catch (err) {
        console.error('Delete account error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// ADMIN ROUTE – Role‑Based Check (NEW)
// ============================================
app.post('/api/admin/force-pro', authLimiter, authenticate, async (req, res) => {
    try {
        const userId = req.userId;

        // ✅ Check if user is admin (is_admin = true)
        const { data: profile, error: profileError } = await supabaseAdmin
            .from('profiles')
            .select('is_admin')
            .eq('id', userId)
            .single();

        if (profileError || !profile?.is_admin) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { targetEmail } = req.body;
        if (!targetEmail || !isValidEmail(targetEmail)) {
            return res.status(400).json({ error: 'Valid email is required' });
        }

        // Find user by email
        const { data: user, error: userError } = await supabaseAdmin
            .from('profiles')
            .select('id')
            .eq('email', targetEmail)
            .single();

        if (userError || !user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 30);

        const { error: upsertError } = await supabaseAdmin
            .from('profiles')
            .upsert({
                id: user.id,
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
            user.id,
            { user_metadata: { subscription_tier: 'pro' } }
        );

        res.json({
            success: true,
            message: `✅ ${targetEmail} is now Pro! (Expires: ${expiresAt.toISOString()})`,
            expires_at: expiresAt.toISOString()
        });

    } catch (err) {
        console.error('Force Pro error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// UPLOAD PROFILE PICTURE
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
// UPDATE PROFILE
// ============================================
app.put('/api/auth/update', authenticate, async (req, res) => {
    try {
        const { name, bio, default_currency } = req.body;
        if (!name) return res.status(400).json({ error: 'Name is required' });
        
        const sanitizedName = sanitizeInput(name.trim());
        if (sanitizedName.length < 2 || sanitizedName.length > 50) {
            return res.status(400).json({ error: 'Name must be between 2 and 50 characters' });
        }
        
        const sanitizedBio = bio ? sanitizeInput(bio.trim()) : '';
        
        const { data, error } = await supabaseAdmin.auth.admin.updateUserById(
            req.userId,
            {
                user_metadata: {
                    name: sanitizedName,
                    bio: sanitizedBio,
                    default_currency: default_currency || 'USD'
                }
            }
        );
        
        if (error) {
            console.error('Update profile error:', error);
            return res.status(400).json({ error: error.message });
        }
        
        const { data: userData } = await supabaseAdmin.auth.admin.getUserById(req.userId);
        const user = userData?.user || data.user;
        
        res.json({ success: true, user: user, message: 'Profile updated successfully' });
    } catch (err) {
        console.error('Update profile server error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// PROFILE – BANK DETAILS (for invoices)
// ============================================

app.put('/api/profile/bank-details', authenticate, async (req, res) => {
    try {
        const userId = req.userId;
        const { accountName, bankName, accountNumber } = req.body;

        if (!accountName || !bankName || !accountNumber) {
            return res.status(400).json({ error: 'All fields are required' });
        }

        const { error } = await supabaseAdmin
            .from('profiles')
            .update({
                bank_account_name: accountName,
                bank_name: bankName,
                bank_account_number: accountNumber
            })
            .eq('id', userId);

        if (error) {
            console.error('Error saving bank details:', error);
            return res.status(500).json({ error: 'Failed to save bank details' });
        }

        res.json({ success: true, message: 'Bank details saved successfully' });
    } catch (err) {
        console.error('Bank details save error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/profile/bank-details', authenticate, async (req, res) => {
    try {
        const userId = req.userId;

        const { data: profile, error } = await supabaseAdmin
            .from('profiles')
            .select('bank_account_name, bank_name, bank_account_number')
            .eq('id', userId)
            .single();

        if (error) {
            console.error('Error fetching bank details:', error);
            return res.status(500).json({ error: 'Failed to fetch bank details' });
        }

        res.json({
            success: true,
            data: {
                account_name: profile?.bank_account_name || '',
                bank_name: profile?.bank_name || '',
                account_number: profile?.bank_account_number || ''
            }
        });
    } catch (err) {
        console.error('Bank details fetch error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============================================
// DEALS ROUTES
// ============================================
app.get('/api/deals', authenticate, async (req, res) => {
    try {
        const userId = req.userId;
        const fallbackUserId = req.reconciledUserId || null;
        const ids = [userId, fallbackUserId].filter(Boolean);
        const { data, error } = await supabaseAdmin
            .from('deals')
            .select('*')
            .in('user_id', ids)
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
        const fallbackUserId = req.reconciledUserId || null;
        const ids = [userId, fallbackUserId].filter(Boolean);
        // ✅ Check usage limit – MUST BE BEFORE ANYTHING ELSE
        const usage = await checkUsageLimit(ids, 'deal');
        if (!usage.allowed) {
            return res.status(403).json({
                error: `Deal limit reached (${usage.max}). Upgrade to Pro for unlimited deals.`,
                limit_reached: true,
                current: usage.current,
                max: usage.max
            });
        }
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
        const { data, error } = await supabaseAdmin
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

        const fallbackUserId = req.reconciledUserId || null;
        const ids = [userId, fallbackUserId].filter(Boolean);
        const { data, error } = await supabaseAdmin
            .from('deals')
            .update({
                brand_name: sanitizedBrand,
                amount: parseFloat(amount),
                due_date: due_date || null,
                deliverable: sanitizedDeliverable || '',
                status: status || 'pending',
                currency: currency || 'NGN',
                notes: req.body.notes || null
            })
            .eq('id', dealId)
            .in('user_id', ids)
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

        const fallbackUserId = req.reconciledUserId || null;
        const ids = [userId, fallbackUserId].filter(Boolean);
        const { error } = await supabaseAdmin
            .from('deals')
            .delete()
            .eq('id', dealId)
            .in('user_id', ids);

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
// GET SINGLE DEAL WITH PROFIT
// ============================================
app.get('/api/deals/:id', authenticate, async (req, res) => {
    try {
        const dealId = req.params.id;
        const userId = req.userId;

        const { data: deal, error: dealError } = await supabaseAdmin
            .from('deals')
            .select('*')
            .eq('id', dealId)
            .in('user_id', ids)
            .single();

        if (dealError || !deal) {
            return res.status(404).json({ error: 'Deal not found' });
        }

        const { data: expenses, error: expensesError } = await supabaseAdmin
            .from('expenses')
            .select('amount, vendor, category, created_at')
            .eq('deal_id', dealId)
            .eq('user_id', userId);

        if (expensesError) {
            console.error('Error fetching expenses for deal:', expensesError);
        }

        const totalExpenses = (expenses || []).reduce((sum, exp) => sum + Number(exp.amount), 0);
        const profit = Number(deal.amount) - totalExpenses;

        res.json({
            success: true,
            data: {
                ...deal,
                expenses: expenses || [],
                total_expenses: totalExpenses,
                profit: profit
            }
        });

    } catch (err) {
        console.error('Error in GET /api/deals/:id:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// EXPENSES ROUTES
// ============================================
app.post('/api/expenses', authenticate, async (req, res) => {
    try {
        const userId = req.userId;
        const fallbackUserId = req.reconciledUserId || null;
        const ids = [userId, fallbackUserId].filter(Boolean);
        // ✅ Check usage limit – MUST BE BEFORE ANYTHING ELSE
        const usage = await checkUsageLimit(ids, 'expense');
        if (!usage.allowed) {
            return res.status(403).json({
                error: `expense limit reached (${usage.max}). Upgrade to Pro for unlimited expense.`,
                limit_reached: true,
                current: usage.current,
                max: usage.max
            });
        }

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
        const { data, error } = await supabaseAdmin
            .from('expenses')
            .insert([{
                user_id: userId,
                vendor: sanitizedVendor,
                amount: parseFloat(amount),
                category: sanitizedCategory,
                receipt_url: receipt_url || '',
                currency: currency || 'NGN',
                deal_id: req.body.deal_id || null 
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
// DELETE EXPENSE
// ============================================

app.delete('/api/expenses/:id', authenticate, async (req, res) => {
    try {
        const expenseId = req.params.id;
        const userId = req.userId;

        const { data: expense, error: findError } = await supabaseAdmin
            .from('expenses')
            .select('id')
            .eq('id', expenseId)
            .eq('user_id', userId)
            .single();

        if (findError || !expense) {
            return res.status(404).json({ error: 'Expense not found' });
        }

        const { error } = await supabaseAdmin
            .from('expenses')
            .delete()
            .eq('id', expenseId)
            .eq('user_id', userId);

        if (error) {
            console.error('Delete expense error:', error);
            return res.status(500).json({ error: 'Failed to delete expense' });
        }

        res.json({ success: true, message: 'Expense deleted successfully' });
    } catch (err) {
        console.error('Expense delete error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============================================
// GET EXPENSES
// ============================================
app.get('/api/expenses', authenticate, async (req, res) => {
    try {
        const userId = req.userId;
        const { data, error } = await supabaseAdmin
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

        const { data: deal, error: dealError } = await supabaseAdmin
            .from('deals')
            .select('*')
            .eq('id', dealId)
            .in('user_id', ids)
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
                currency: deal.currency || 'NGN',
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
// INVOICE ROUTES
// ============================================

// ---- extracted handler for invoice creation ----
async function handleInvoiceCreate(req, res) {
    try {
        const { dealId, invoiceNumber, brandEmail } = req.body;
        const userId = req.userId;
        const fallbackUserId = req.reconciledUserId || null;
        const ids = [userId, fallbackUserId].filter(Boolean);
        // ✅ Check usage limit – MUST BE BEFORE ANYTHING ELSE
        const usage = await checkUsageLimit(ids, 'invoice');
        if (!usage.allowed) {
            return res.status(403).json({
                error: `invoice limit reached (${usage.max}). Upgrade to Pro for unlimited invoices.`,
                limit_reached: true,
                current: usage.current,
                max: usage.max
            });
        }


        if (!dealId || !brandEmail) {
            return res.status(400).json({ error: 'dealId and brandEmail required' });
        }

        if (!isValidEmail(brandEmail)) {
            return res.status(400).json({ error: 'Invalid brand email format' });
        }

        const { data: deal, error: dealError } = await supabaseAdmin
            .from('deals')
            .select('*')
            .eq('id', dealId)
            .in('user_id', ids)
            .single();

        if (dealError || !deal) {
            return res.status(404).json({ error: 'Deal not found' });
        }

        const invNumber = invoiceNumber || `INV-${Date.now()}`;
        const { data, error } = await supabaseAdmin
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
        const { error: tokenError } = await  supabaseAdmin
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

        const sent = await sendEmailWithRetry(brandEmail, subject, html);

        if (sent) {
            console.log(`✅ Invoice logged for ${brandEmail}`);
        } else {
            console.warn(`⚠️ Invoice logging failed.`);
        }

        res.status(201).json({
            success: true,
            data: newInvoice,
            portal_token: portalToken,
            portal_link: portalLink,
            email_sent: sent
        });

    } catch (err) {
        console.error('Invoice create error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}

// ---- explicit routes to avoid 404s ----
app.post(['/api/invoices/create', '/api/invoices/create/'], authenticate, handleInvoiceCreate);

// ============================================
// GENERATE INVOICE PDF
// ============================================
app.post('/api/invoices/generate', authenticate, async (req, res) => {
    try {
        const { dealId } = req.body;
        const userId = req.userId;

        // 1. Get deal details
        const { data: deal, error: dealError } = await supabaseAdmin
            .from('deals')
            .select('*')
            .eq('id', dealId)
            .eq('user_id', userId)
            .single();

        if (dealError || !deal) {
            return res.status(404).json({ error: 'Deal not found' });
        }

        // 2. Get creator's bank details from profile
        const { data: profile, error: profileError } = await supabaseAdmin
            .from('profiles')
            .select('bank_account_name, bank_name, bank_account_number')
            .eq('id', userId)
            .single();

        if (profileError) {
            console.error('Profile fetch error:', profileError);
            // Continue without bank details – just don't show them.
        }

        const bankName = profile?.bank_name || 'Not provided';
        const accountName = profile?.bank_account_name || 'Not provided';
        const accountNumber = profile?.bank_account_number || 'Not provided';

        // 3. Generate PDF
        const invoiceNumber = `INV-${Date.now().toString().slice(-8)}`;
        const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
        const dueDate = deal.due_date ? new Date(deal.due_date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'Not set';

        const doc = new PDFDocument({ size: 'A4', margin: 50 });

        res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `inline; filename=invoice-${deal.brand_name}-${Date.now()}.pdf`
        });

        doc.pipe(res);

        // ----- Header -----
        doc.fontSize(24).font('Helvetica-Bold').text('PayPoint', { align: 'center' });
        doc.fontSize(12).font('Helvetica').text('Finance OS for Creators', { align: 'center' });
        doc.moveDown(0.5);
        doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke('#CCCCCC');
        doc.moveDown(1);

        // ----- Invoice Title -----
        doc.fontSize(20).font('Helvetica-Bold').text('INVOICE', { align: 'center' });
        doc.moveDown(0.5);

        // ----- Invoice Info -----
        doc.fontSize(10).font('Helvetica');
        doc.text(`Invoice #: ${invoiceNumber}`, 50, doc.y);
        doc.text(`Date: ${date}`, 400, doc.y - 12);
        doc.text(`Status: ${(deal.status || 'pending').toUpperCase()}`, 50, doc.y + 12);
        doc.moveDown(2);

        // ----- Brand Details -----
        doc.fontSize(14).font('Helvetica-Bold').text('Brand Details', { underline: true });
        doc.moveDown(0.3);
        doc.fontSize(12).font('Helvetica');
        doc.text(`Brand Name: ${deal.brand_name}`);
        doc.text(`Email: ${req.user.email || 'Not provided'}`);
        doc.moveDown(1);

        // ----- Deal Details -----
        doc.fontSize(14).font('Helvetica-Bold').text('Deal Details', { underline: true });
        doc.moveDown(0.3);
        doc.fontSize(12).font('Helvetica');
        doc.text(`Deliverable: ${deal.deliverable || 'Not specified'}`);
        doc.text(`Due Date: ${dueDate}`);
        doc.moveDown(1);

        // ----- Payment Instructions -----
        doc.fontSize(14).font('Helvetica-Bold').text('Payment Instructions', { underline: true });
        doc.moveDown(0.3);
        doc.fontSize(12).font('Helvetica');
        doc.text(`Account Name: ${accountName}`);
        doc.text(`Bank: ${bankName}`);
        doc.text(`Account Number: ${accountNumber}`);
        doc.text(`Please use the invoice number (${invoiceNumber}) as your payment reference.`);
        doc.moveDown(1);

        // ----- Total Amount -----
        doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke('#CCCCCC');
        doc.moveDown(0.5);
        doc.fontSize(16).font('Helvetica-Bold');
        const currencySymbol = deal.currency === 'USD' ? '$' : '₦';
        doc.text(`Total Amount: ${currencySymbol}${Number(deal.amount).toLocaleString()}`, { align: 'right' });
        doc.moveDown(2);

        // ----- Footer -----
        doc.fontSize(10).font('Helvetica');
        doc.text('Thank you for your business!', { align: 'center' });
        doc.text('Payment is due within 30 days of invoice date.', { align: 'center' });
        doc.text('For questions, contact: support@paypoint.com', { align: 'center' });
        doc.moveDown(1);
        doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke('#EEEEEE');
        doc.moveDown(0.3);
        doc.fontSize(8).text('PayPoint · Finance OS for Creators · www.paypoint.com', { align: 'center' });

        // ✅ CRITICAL: End the document
        doc.end();

    } catch (err) {
        console.error('Invoice generation error:', err);
        res.status(500).json({ error: 'Failed to generate invoice: ' + err.message });
    }
});

// ============================================
// BANK ACCOUNT VERIFICATION & SUBACCOUNT
// ============================================

app.post('/api/payments/verify-account', authenticate, async (req, res) => {
    // ... keep existing ...
});

app.post('/api/payments/create-subaccount', authenticate, async (req, res) => {
    // ... keep existing ...
});

// ============================================
// SUBSCRIPTION SYSTEM (Pro/Free)
// ============================================
app.post('/api/subscribe', authenticate, async (req, res) => {
    try {
        const userId = req.userId;
        const userEmail = req.user?.email;
        const { plan, interval } = req.body;

        if (!userEmail) {
            return res.status(400).json({ error: 'User email required' });
        }

        if (plan !== 'pro') {
            return res.status(400).json({ error: 'Invalid plan' });
        }

        // PRICING IN USD
        let usdAmount;
        if (interval === 'monthly') {
            usdAmount = 9;
        } else if (interval === 'annual') {
            usdAmount = 90;
        } else {
            return res.status(400).json({ error: 'Invalid interval' });
        }

        // ✅ Fetch live exchange rate using the API key
        const apiKey = process.env.EXCHANGE_RATE_API_KEY;
        if (!apiKey) {
            console.error('EXCHANGE_RATE_API_KEY is not set');
            return res.status(500).json({ error: 'Currency conversion not configured' });
        }

        let ngnRate;
        try {
            const exchangeRes = await fetch(
                `https://api.exchangerate-api.com/v4/latest/USD?api_key=${apiKey}`
            );
            const exchangeData = await exchangeRes.json();

            if (exchangeData.rates && exchangeData.rates.NGN) {
                ngnRate = exchangeData.rates.NGN;
            } else {
                throw new Error('NGN rate not found in response');
            }
        } catch (err) {
            console.error('Exchange rate API error:', err);

            // ✅ Fallback to public endpoint
            const fallbackRes = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
            const fallbackData = await fallbackRes.json();
            ngnRate = fallbackData.rates.NGN;

            if (!ngnRate) {
                return res.status(500).json({ error: 'Currency conversion temporarily unavailable' });
            }
        }

        const ngnAmount = Math.round(usdAmount * ngnRate * 100); // kobo
        const displayNgn = Math.round(usdAmount * ngnRate);

        console.log(`💰 USD $${usdAmount} → ₦${displayNgn} at rate ${ngnRate}`);

        // ✅ Initialize Paystack transaction
        const response = await fetch('https://api.paystack.co/transaction/initialize', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
            },
            body: JSON.stringify({
                email: userEmail,
                amount: ngnAmount,
                currency: 'NGN',
                metadata: {
                    user_id: userId,
                    plan: plan,
                    interval: interval,
                    usd_amount: usdAmount,
                    ngn_amount: displayNgn,
                    exchange_rate: ngnRate
                },
                callback_url: `${FRONTEND_URL}/dashboard.html?subscription=success`
            })
        });

        const result = await response.json();

        if (!result.status) {
            console.error('Paystack error:', result);
            return res.status(502).json({ error: result.message || 'Payment provider error' });
        }

        res.json({
            success: true,
            authorization_url: result.data.authorization_url,
            reference: result.data.reference,
            amount_usd: usdAmount,
            amount_ngn: displayNgn,
            exchange_rate: ngnRate
        });

    } catch (err) {
        console.error('Subscription error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// WEBHOOKS
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

            // ✅ event is defined HERE, inside the try block
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

// ============================================
// PUBLIC PORTAL - View Invoice
// ============================================
app.get('/portal/:token', async (req, res) => {
    // ... keep existing ...
});

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
    console.log(`📧 Email: DISABLED (Console Logger Active)`);
    console.log(`🌐 Allowed origins: ${allowedOrigins.join(', ')}`);
});