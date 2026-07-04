// Load environment variables from .env file (development). Render provides env at runtime.
require('dotenv').config();

const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const port = process.env.PORT || 3000;

// ============================================
// SECURITY MIDDLEWARE
// ============================================
app.use(helmet({
    contentSecurityPolicy: false,
}));

app.use(cors({
    origin: '*',
    credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static files (frontend)
app.use(express.static(path.join(__dirname)));

// ============================================
// INITIALIZE SUPABASE
// ============================================
const supabaseUrl = 'https://mqggkwhdbwkaftmewdca.supabase.co';
const supabaseAnonKey = 'sb_publishable_u1Ag_qpF5L8LbHc6ZzYnxQ_z4w3ExhV';

const supabase = createClient(supabaseUrl, supabaseAnonKey);
console.log('✅ Supabase connected');

// ============================================
// TEST ROUTE
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

// SIGNUP - Create a new user
app.post('/api/auth/signup', async (req, res) => {
    try {
        const { name, email, password } = req.body || {};
        
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }

        const { data, error } = await supabase.auth.signUp({
            email,
            password,
            options: {
                data: { name: name || '' }
            }
        });

        if (error) {
            console.error('Signup error:', error);
            return res.status(400).json({ error: error.message });
        }

        res.json({ 
            success: true, 
            user: data.user,
            session: data.session || null
        });
    } catch (err) {
        console.error('Signup error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// LOGIN - Authenticate a user
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body || {};
        
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }

        const { data, error } = await supabase.auth.signInWithPassword({ 
            email, 
            password 
        });

        if (error) {
            console.error('Login error:', error);
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        res.json({ 
            success: true, 
            user: data.user,
            session: data.session || null
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// LOGOUT - Sign out a user
app.post('/api/auth/logout', async (req, res) => {
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

// GET USER - Get current user info
app.get('/api/auth/user', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        
        if (!token) {
            return res.status(401).json({ error: 'No token provided' });
        }

        const { data, error } = await supabase.auth.getUser(token);

        if (error) {
            return res.status(401).json({ error: 'Invalid token' });
        }

        res.json({ success: true, user: data.user });
    } catch (err) {
        console.error('Get user error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// DEALS ROUTES
// ============================================

// GET /api/deals - Fetch all deals for the logged-in user
app.get('/api/deals', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ error: 'No token provided' });
        }

        const { data: userData, error: userError } = await supabase.auth.getUser(token);
        if (userError || !userData?.user) {
            return res.status(401).json({ error: 'Invalid token' });
        }

        const userId = userData.user.id;

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
app.post('/api/deals', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ error: 'No token provided' });
        }

        const { data: userData, error: userError } = await supabase.auth.getUser(token);
        if (userError || !userData?.user) {
            return res.status(401).json({ error: 'Invalid token' });
        }

        const userId = userData.user.id;
        const { brand_name, amount, due_date, deliverable, status } = req.body;

        if (!brand_name || !amount) {
            return res.status(400).json({ error: 'brand_name and amount are required' });
        }

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
app.put('/api/deals/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ error: 'No token provided' });
        }

        const { data: userData, error: userError } = await supabase.auth.getUser(token);
        if (userError || !userData?.user) {
            return res.status(401).json({ error: 'Invalid token' });
        }

        const userId = userData.user.id;
        const { brand_name, amount, due_date, deliverable, status } = req.body;

        if (!brand_name || !amount) {
            return res.status(400).json({ error: 'brand_name and amount are required' });
        }

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
app.delete('/api/deals/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ error: 'No token provided' });
        }

        const { data: userData, error: userError } = await supabase.auth.getUser(token);
        if (userError || !userData?.user) {
            return res.status(401).json({ error: 'Invalid token' });
        }

        const userId = userData.user.id;

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
// EXPENSES ROUTES
// ============================================

// GET /api/expenses - Fetch all expenses for the logged-in user
app.get('/api/expenses', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ error: 'No token provided' });
        }

        const { data: userData, error: userError } = await supabase.auth.getUser(token);
        if (userError || !userData?.user) {
            return res.status(401).json({ error: 'Invalid token' });
        }

        const userId = userData.user.id;

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
app.post('/api/expenses', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ error: 'No token provided' });
        }

        const { data: userData, error: userError } = await supabase.auth.getUser(token);
        if (userError || !userData?.user) {
            return res.status(401).json({ error: 'Invalid token' });
        }

        const userId = userData.user.id;
        const { vendor, amount, category, receipt_url } = req.body;

        if (!vendor || !amount) {
            return res.status(400).json({ error: 'vendor and amount are required' });
        }

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

// DELETE /api/expenses/:id - Delete an expense
app.delete('/api/expenses/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ error: 'No token provided' });
        }

        const { data: userData, error: userError } = await supabase.auth.getUser(token);
        if (userError || !userData?.user) {
            return res.status(401).json({ error: 'Invalid token' });
        }

        const userId = userData.user.id;

        const { data, error } = await supabase
            .from('expenses')
            .delete()
            .eq('id', id)
            .eq('user_id', userId)
            .select();

        if (error) {
            console.error('Supabase error:', error);
            return res.status(500).json({ error: error.message });
        }

        if (!data || data.length === 0) {
            return res.status(404).json({ success: false, error: 'Expense not found' });
        }

        res.json({ success: true, data: data[0] });
    } catch (err) {
        console.error('Server error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// START THE SERVER (MUST BE AT THE BOTTOM)
// ============================================
app.listen(port, () => {
    console.log(`🚀 PayPoint API running on http://localhost:${port}`);
});

// Graceful shutdown handlers
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