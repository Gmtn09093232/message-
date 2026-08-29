const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');

// ============================================================
//  CONFIGURATION
// ============================================================
const PORT = process.env.PORT || 3000;

// Supabase credentials (replace with your own)
const SUPABASE_URL = 'https://gtxbpxdehdsfdqkaamqf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd0eGJweGRlaGRzZmRxa2FhbXFmIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NzkxOTQyNiwiZXhwIjoyMTAzNDk1NDI2fQ.sMQQoYWqjs7qAYJ7W_953Xn9svSM4K2Q4R_d7ZLyHrY';
const SUPABASE_SERVICE_ROLE_KEY = 'your-service-role-key'; // Keep this secret!

// ============================================================
//  INIT SUPABASE (with service role for admin operations)
// ============================================================
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ============================================================
//  AUTH MIDDLEWARE (verify Supabase JWT)
// ============================================================
async function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing or invalid token' }));
        return;
    }
    const token = authHeader.slice(7);
    try {
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error || !user) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid token' }));
            return;
        }
        req.user = user; // Attach user object
        next();
    } catch (err) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Authentication failed' }));
    }
}

// ============================================================
//  ROUTE HANDLERS
// ============================================================

// ---------- Serve index.html ----------
function serveIndex(req, res) {
    const filePath = path.join(__dirname, 'index.html');
    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(500);
            res.end('Server Error: index.html not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(content);
    });
}

// ---------- Register ----------
async function register(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
        try {
            const { username, password, full_name, phone } = JSON.parse(body);
            if (!username || !password) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Username and password required' }));
                return;
            }

            // 1. Check if username already exists in profiles table
            const { data: existing, error: checkError } = await supabase
                .from('profiles')
                .select('username')
                .eq('username', username)
                .maybeSingle();
            if (existing) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Username already taken' }));
                return;
            }

            // 2. Create user in Supabase Auth
            const { data: authData, error: authError } = await supabase.auth.admin.createUser({
                email: `${username}@${username}.temp`, // Supabase requires email, we use a dummy
                password,
                email_confirm: true,
                user_metadata: { username, full_name, phone }
            });
            if (authError) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: authError.message }));
                return;
            }

            const userId = authData.user.id;

            // 3. Create profile record (public_key and other fields)
            const { error: profileError } = await supabase
                .from('profiles')
                .insert([{
                    id: userId,
                    username,
                    full_name: full_name || '',
                    phone: phone || null,
                    public_key: null // will be set later
                }]);
            if (profileError) {
                // Rollback: delete auth user if profile insert fails
                await supabase.auth.admin.deleteUser(userId);
                res.writeHead(500);
                res.end(JSON.stringify({ error: 'Failed to create profile' }));
                return;
            }

            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, user: { id: userId, username } }));
        } catch (err) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Invalid request' }));
        }
    });
}

// ---------- Login ----------
async function login(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
        try {
            const { username, password } = JSON.parse(body);
            if (!username || !password) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Username and password required' }));
                return;
            }

            // We need to get the user's email from the profiles table or use a predictable email
            // Since we used dummy email pattern, we can construct it.
            const { data: profile, error: profileError } = await supabase
                .from('profiles')
                .select('id')
                .eq('username', username)
                .single();
            if (profileError || !profile) {
                res.writeHead(401);
                res.end(JSON.stringify({ error: 'Invalid credentials' }));
                return;
            }

            // Attempt login with Supabase Auth using the dummy email
            const email = `${username}@${username}.temp`;
            const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
                email,
                password
            });
            if (authError) {
                res.writeHead(401);
                res.end(JSON.stringify({ error: 'Invalid credentials' }));
                return;
            }

            // Get full profile
            const { data: fullProfile, error: fullError } = await supabase
                .from('profiles')
                .select('*')
                .eq('id', authData.user.id)
                .single();

            if (fullError) {
                res.writeHead(500);
                res.end(JSON.stringify({ error: 'Failed to fetch profile' }));
                return;
            }

            const responseUser = { ...fullProfile };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                token: authData.session.access_token,
                user: responseUser
            }));
        } catch (err) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Invalid request' }));
        }
    });
}

// ---------- Get current user ----------
async function getMe(req, res) {
    const userId = req.user.id;
    const { data: profile, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single();
    if (error) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'User not found' }));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(profile));
}

// ---------- Get all users ----------
async function getUsers(req, res) {
    const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .neq('id', req.user.id);
    if (error) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Failed to fetch users' }));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

// ---------- Get messages for a user ----------
async function getMessages(req, res, query) {
    const userId = query.userId || query.user_id;
    if (!userId) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'userId required' }));
        return;
    }
    const { data, error } = await supabase
        .from('messages')
        .select('*')
        .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`)
        .order('created_at', { ascending: true });
    if (error) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Failed to fetch messages' }));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

// ---------- Send a message ----------
async function postMessage(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
        try {
            const { sender_id, receiver_id, ciphertext, iv } = JSON.parse(body);
            if (!sender_id || !receiver_id || !ciphertext) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Missing fields' }));
                return;
            }
            // Validate that sender is the authenticated user
            if (sender_id !== req.user.id) {
                res.writeHead(403);
                res.end(JSON.stringify({ error: 'Cannot send as another user' }));
                return;
            }
            const newMessage = {
                id: uuidv4(),
                sender_id,
                receiver_id,
                ciphertext,
                iv: iv || '',
                created_at: new Date().toISOString()
            };
            const { data, error } = await supabase
                .from('messages')
                .insert([newMessage])
                .select()
                .single();
            if (error) {
                res.writeHead(500);
                res.end(JSON.stringify({ error: 'Failed to save message' }));
                return;
            }
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
        } catch (err) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Invalid request' }));
        }
    });
}

// ---------- Update user ----------
async function updateUser(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
        try {
            const updates = JSON.parse(body);
            if (!updates.id || updates.id !== req.user.id) {
                res.writeHead(403);
                res.end(JSON.stringify({ error: 'You can only update your own profile' }));
                return;
            }
            // Check username uniqueness if changed
            if (updates.username) {
                const { data: existing, error } = await supabase
                    .from('profiles')
                    .select('id')
                    .eq('username', updates.username)
                    .neq('id', req.user.id)
                    .maybeSingle();
                if (existing) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Username already taken' }));
                    return;
                }
            }
            const { data, error } = await supabase
                .from('profiles')
                .update(updates)
                .eq('id', req.user.id)
                .select()
                .single();
            if (error) {
                res.writeHead(500);
                res.end(JSON.stringify({ error: 'Update failed' }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
        } catch (err) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Invalid request' }));
        }
    });
}

// ============================================================
//  ROUTER
// ============================================================
function router(req, res) {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    const method = req.method;
    const query = parsedUrl.query;

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // Public routes
    if (pathname === '/api/register' && method === 'POST') {
        register(req, res);
        return;
    }
    if (pathname === '/api/login' && method === 'POST') {
        login(req, res);
        return;
    }

    // Protected routes
    if (pathname.startsWith('/api/')) {
        authenticate(req, res, () => {
            const apiPath = pathname.replace('/api/', '');
            switch (apiPath) {
                case 'me':
                    if (method === 'GET') getMe(req, res);
                    else notFound(res);
                    break;
                case 'users':
                    if (method === 'GET') getUsers(req, res);
                    else if (method === 'PUT') updateUser(req, res);
                    else notFound(res);
                    break;
                case 'messages':
                    if (method === 'GET') getMessages(req, res, query);
                    else if (method === 'POST') postMessage(req, res);
                    else notFound(res);
                    break;
                default:
                    notFound(res);
            }
        });
        return;
    }

    // Serve index.html for root
    if (pathname === '/' || pathname === '/index.html') {
        serveIndex(req, res);
        return;
    }

    // Static files (optional)
    const filePath = path.join(__dirname, pathname);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath);
        const mimeTypes = {
            '.html': 'text/html',
            '.css': 'text/css',
            '.js': 'application/javascript',
            '.json': 'application/json',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.gif': 'image/gif',
            '.svg': 'image/svg+xml'
        };
        const contentType = mimeTypes[ext] || 'application/octet-stream';
        fs.readFile(filePath, (err, content) => {
            if (err) {
                res.writeHead(500);
                res.end('Server Error');
                return;
            }
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content);
        });
        return;
    }

    notFound(res);
}

function notFound(res) {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
}

// ============================================================
//  START SERVER
// ============================================================
const server = http.createServer(router);
server.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`🔗 Using Supabase at ${SUPABASE_URL}`);
});
