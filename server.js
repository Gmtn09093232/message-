const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

// ============================================================
//  CONFIGURATION
// ============================================================
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';

// ============================================================
//  ENSURE DATA DIRECTORY & FILES
// ============================================================
function ensureDataFiles() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(MESSAGES_FILE)) {
        fs.writeFileSync(MESSAGES_FILE, JSON.stringify([]), 'utf8');
    }
    if (!fs.existsSync(USERS_FILE)) {
        // Seed with a default user (for testing)
        const defaultUsers = [
            {
                id: 'me',
                username: 'JohnDoe',
                password_hash: hashPassword('password123'),
                salt: 'somesalt',
                full_name: 'John Doe',
                phone: '+1 234 567 890',
                avatar_url: null
            },
            {
                id: 'u1',
                username: 'alice',
                password_hash: hashPassword('alice123'),
                salt: 'somesalt2',
                full_name: 'Alice Wonder',
                phone: null,
                avatar_url: null
            }
        ];
        fs.writeFileSync(USERS_FILE, JSON.stringify(defaultUsers, null, 2), 'utf8');
    }
}

// ============================================================
//  PASSWORD HASHING
// ============================================================
function hashPassword(password, salt = null) {
    if (!salt) salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
    return { hash, salt };
}

function verifyPassword(password, storedHash, salt) {
    const { hash } = hashPassword(password, salt);
    return hash === storedHash;
}

// ============================================================
//  JWT HELPERS (simplified HMAC)
// ============================================================
function signJWT(payload) {
    const header = { alg: 'HS256', typ: 'JWT' };
    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto
        .createHmac('sha256', JWT_SECRET)
        .update(`${encodedHeader}.${encodedPayload}`)
        .digest('base64url');
    return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function verifyJWT(token) {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [encodedHeader, encodedPayload, signature] = parts;
    const expectedSignature = crypto
        .createHmac('sha256', JWT_SECRET)
        .update(`${encodedHeader}.${encodedPayload}`)
        .digest('base64url');
    if (signature !== expectedSignature) return null;
    try {
        return JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
}

// ============================================================
//  DATA HELPERS
// ============================================================
function readMessages() {
    try {
        return JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
    } catch { return []; }
}
function writeMessages(messages) {
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2), 'utf8');
}
function readUsers() {
    try {
        return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    } catch { return []; }
}
function writeUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

// ============================================================
//  AUTH MIDDLEWARE
// ============================================================
function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
    }
    const token = authHeader.slice(7);
    const payload = verifyJWT(token);
    if (!payload || !payload.userId) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid token' }));
        return;
    }
    req.userId = payload.userId;
    next();
}

// ============================================================
//  ROUTE HANDLERS
// ============================================================

// ---------- Serve static HTML ----------
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

// ---------- API: Register ----------
function register(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
        try {
            const { username, password, full_name, phone } = JSON.parse(body);
            if (!username || !password) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Username and password required' }));
                return;
            }
            const users = readUsers();
            if (users.find(u => u.username === username)) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Username already taken' }));
                return;
            }
            const { hash, salt } = hashPassword(password);
            const newUser = {
                id: uuidv4(),
                username,
                password_hash: hash,
                salt,
                full_name: full_name || '',
                phone: phone || null,
                avatar_url: null
            };
            users.push(newUser);
            writeUsers(users);
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, user: { id: newUser.id, username: newUser.username } }));
        } catch (err) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Invalid request' }));
        }
    });
}

// ---------- API: Login ----------
function login(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
        try {
            const { username, password } = JSON.parse(body);
            const users = readUsers();
            const user = users.find(u => u.username === username);
            if (!user) {
                res.writeHead(401);
                res.end(JSON.stringify({ error: 'Invalid credentials' }));
                return;
            }
            if (!verifyPassword(password, user.password_hash, user.salt)) {
                res.writeHead(401);
                res.end(JSON.stringify({ error: 'Invalid credentials' }));
                return;
            }
            const payload = { userId: user.id, username: user.username };
            const token = signJWT(payload);
            const responseUser = { ...user };
            delete responseUser.password_hash;
            delete responseUser.salt;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ token, user: responseUser }));
        } catch (err) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Invalid request' }));
        }
    });
}

// ---------- API: Get current user (from token) ----------
function getMe(req, res) {
    const userId = req.userId;
    const users = readUsers();
    const user = users.find(u => u.id === userId);
    if (!user) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'User not found' }));
        return;
    }
    const responseUser = { ...user };
    delete responseUser.password_hash;
    delete responseUser.salt;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(responseUser));
}

// ---------- API: Get all users (protected) ----------
function getUsers(req, res) {
    const users = readUsers();
    const sanitized = users.map(u => {
        const { password_hash, salt, ...rest } = u;
        return rest;
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sanitized));
}

// ---------- API: Get messages for a user (protected) ----------
function getMessages(req, res, query) {
    const userId = query.userId || query.user_id;
    if (!userId) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'userId required' }));
        return;
    }
    const allMessages = readMessages();
    const userMessages = allMessages.filter(m =>
        m.sender_id === userId || m.receiver_id === userId
    );
    userMessages.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(userMessages));
}

// ---------- API: Send a message (protected) ----------
function postMessage(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
        try {
            const { sender_id, receiver_id, ciphertext, iv } = JSON.parse(body);
            if (!sender_id || !receiver_id || !ciphertext) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Missing fields' }));
                return;
            }
            const users = readUsers();
            if (!users.find(u => u.id === sender_id) || !users.find(u => u.id === receiver_id)) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Invalid user IDs' }));
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
            const messages = readMessages();
            messages.push(newMessage);
            writeMessages(messages);
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(newMessage));
        } catch (err) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Invalid request' }));
        }
    });
}

// ---------- API: Update user (protected) ----------
function updateUser(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
        try {
            const updates = JSON.parse(body);
            if (!updates.id) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'User ID required' }));
                return;
            }
            // Ensure user is updating themselves
            if (updates.id !== req.userId) {
                res.writeHead(403);
                res.end(JSON.stringify({ error: 'You can only update your own profile' }));
                return;
            }
            const users = readUsers();
            const index = users.findIndex(u => u.id === updates.id);
            if (index === -1) {
                res.writeHead(404);
                res.end(JSON.stringify({ error: 'User not found' }));
                return;
            }
            // Check username uniqueness if changed
            if (updates.username && updates.username !== users[index].username) {
                if (users.some(u => u.username === updates.username && u.id !== updates.id)) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Username already taken' }));
                    return;
                }
            }
            users[index] = { ...users[index], ...updates };
            // Don't allow changing password_hash or salt via this endpoint
            writeUsers(users);
            const responseUser = { ...users[index] };
            delete responseUser.password_hash;
            delete responseUser.salt;
            res.writeHead(200);
            res.end(JSON.stringify(responseUser));
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
        // Apply authentication middleware
        authenticate(req, res, () => {
            const apiPath = pathname.replace('/api/', '');

            if (apiPath === 'me' && method === 'GET') {
                getMe(req, res);
                return;
            }
            if (apiPath === 'users' && method === 'GET') {
                getUsers(req, res);
                return;
            }
            if (apiPath === 'users' && method === 'PUT') {
                updateUser(req, res);
                return;
            }
            if (apiPath === 'messages' && method === 'GET') {
                getMessages(req, res, query);
                return;
            }
            if (apiPath === 'messages' && method === 'POST') {
                postMessage(req, res);
                return;
            }
            // Fallback
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'API endpoint not found' }));
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

    res.writeHead(404);
    res.end('Not Found');
}

// ============================================================
//  START SERVER
// ============================================================
ensureDataFiles();

const server = http.createServer(router);
server.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📁 Data directory: ${DATA_DIR}`);
    console.log(`🔐 JWT secret: ${JWT_SECRET}`);
});
