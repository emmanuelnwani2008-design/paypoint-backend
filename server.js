const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const port = process.env.PORT || 3000;

// MIDDLEWARE
app.use(cors());
app.use(express.json());

// SUPABASE
const supabaseUrl = 'https://mqggkwhdbwkaftmewdca.supabase.co';
const supabaseAnonKey = 'sb_publishable_u1Ag_qpF5L8LbHc6ZzYnxQ_z4w3ExhV';
const supabase = createClient(supabaseUrl, supabaseAnonKey);

// ROUTES
app.get('/', (req, res) => {
    res.json({ message: '🚀 PayPoint API is running!' });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// SIGNUP
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

// LOGIN
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

// LOGOUT
app.post('/api/auth/logout', async (req, res) => {
    try {
        const { error } = await supabase.auth.signOut();
        if (error) return res.status(400).json({ error: error.message });
        res.json({ success: true, message: 'Logged out' });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DEALS
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

// EXPENSES
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

app.listen(port, () => {
    console.log(`🚀 PayPoint API running on port ${port}`);
});