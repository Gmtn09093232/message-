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

const SUPABASE_URL = 'https://gtxbpxdehdsfdqkaamqf.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd0eGJweGRlaGRzZmRxa2FhbXFmIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NzkxOTQyNiwiZXhwIjoyMTAzNDk1NDI2fQ.sMQQoYWqjs7qAYJ7W_953Xn9svSM4K2Q4R_d7ZLyHrY';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ============================================================
//  AUTH MIDDLEWARE
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
        req.user = user;
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
            if (username.length < 3) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Username must be at least 3 characters' }));
                return;
            }
            if (password.length < 6) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Password must be at least 6 characters' }));
                return;
            }

            // Check username uniqueness
            const { data: existing, error: checkError } = await supabase
                .from('profiles')
                .select('username')
                .eq('username', username)
                .maybeSingle();

            if (checkError && checkError.code !== 'PGRST116') {
                console.error('Check error:', checkError);
                res.writeHead(500);
                res.end(JSON.stringify({ error: 'Database error: ' + checkError.message }));
                return;
            }
            if (existing) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Username already taken' }));
                return;
            }

            // Create user in Supabase Auth
            const email = `${username}@temp.user`;
            const { data: authData, error: authError } = await supabase.auth.admin.createUser({
                email: email,
                password: password,
                email_confirm: true,
                user_metadata: { username, full_name: full_name || '', phone: phone || null }
            });

            if (authError) {
                console.error('Auth creation error:', authError);
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Auth error: ' + authError.message }));
                return;
            }

            const userId = authData.user.id;

            // Insert profile
            const { data: profileData, error: profileError } = await supabase
                .from('profiles')
                .insert({
                    id: userId,
                    username: username,
                    full_name: full_name || '',
                    phone: phone || null,
                    public_key: null,
                    avatar_url: null
                })
                .select()
                .single();

            if (profileError) {
                console.error('❌ Profile insert error:', profileError);
                // Rollback: delete auth user
                await supabase.auth.admin.deleteUser(userId);
                res.writeHead(500);
                res.end(JSON.stringify({
                    error: 'Failed to create profile',
                    details: profileError.message,
                    code: profileError.code
                }));
                return;
            }

            console.log(`✅ User registered: ${username} (${userId})`);
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, user: { id: userId, username } }));

        } catch (err) {
            console.error('Registration error:', err);
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Invalid request: ' + err.message }));
        }
    });
}

// ---------- Login (with auto‑profile‑creation fallback) ----------
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

            // Try to login with Supabase Auth
            const email = `${username}@temp.user`;
            const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
                email: email,
                password: password
            });

            if (authError) {
                console.error('Auth login error:', authError);
                res.writeHead(401);
                res.end(JSON.stringify({ error: 'Invalid credentials' }));
                return;
            }

            const userId = authData.user.id;

            // Fetch or create profile
            let { data: profile, error: profileError } = await supabase
                .from('profiles')
                .select('*')
                .eq('id', userId)
                .single();

            if (profileError || !profile) {
                // Profile missing – create it now (handles case where registration failed after auth)
                console.log(`Creating profile for ${username} on login`);
                const { data: newProfile, error: insertError } = await supabase
                    .from('profiles')
                    .insert({
                        id: userId,
                        username: username,
                        full_name: username, // fallback
                        phone: null,
                        public_key: null,
                        avatar_url: null
                    })
                    .select()
                    .single();

                if (insertError) {
                    console.error('Profile creation on login failed:', insertError);
                    res.writeHead(500);
                    res.end(JSON.stringify({ error: 'Failed to create profile' }));
                    return;
                }
                profile = newProfile;
            }

            const responseUser = {
                id: profile.id,
                username: profile.username,
                full_name: profile.full_name,
                phone: profile.phone,
                avatar_url: profile.avatar_url,
                public_key: profile.public_key
            };

            console.log(`✅ User logged in: ${username}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                token: authData.session.access_token,
                user: responseUser
            }));

        } catch (err) {
            console.error('Login error:', err);
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
        console.error('GetMe error:', error);
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
        .select('id, username, full_name, phone, avatar_url, public_key')
        .neq('id', req.user.id);

    if (error) {
        console.error('Get users error:', error);
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Failed to fetch users' }));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

// ---------- Get messages ----------
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
        console.error('Get messages error:', error);
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
                console.error('Insert message error:', error);
                res.writeHead(500);
                res.end(JSON.stringify({ error: 'Failed to save message' }));
                return;
            }

            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
        } catch (err) {
            console.error('Post message error:', err);
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
                console.error('Update user error:', error);
                res.writeHead(500);
                res.end(JSON.stringify({ error: 'Update failed' }));
                return;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
        } catch (err) {
            console.error('Update error:', err);
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Invalid request' }));
        }
    });
}

// ---------- Delete message ----------
async function deleteMessage(req, res, query) {
    const messageId = query.id;
    if (!messageId) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'id required' }));
        return;
    }

    const { data: msg, error: checkError } = await supabase
        .from('messages')
        .select('sender_id')
        .eq('id', messageId)
        .single();

    if (checkError) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Message not found' }));
        return;
    }

    if (msg.sender_id !== req.user.id) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'You can only delete your own messages' }));
        return;
    }

    const { error } = await supabase
        .from('messages')
        .delete()
        .eq('id', messageId);

    if (error) {
        console.error('Delete message error:', error);
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Failed to delete message' }));
        return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
}

// ---------- Not found ----------
function notFound(res) {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
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

    console.log(`${method} ${pathname}`);

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
                    else if (method === 'DELETE') deleteMessage(req, res, query);
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

    // Static files
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

// ============================================================
//  START SERVER
// ============================================================
const server = http.createServer(router);
server.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`🔗 Supabase URL: ${SUPABASE_URL}`);
    console.log(`📝 Logging enabled`);
});
