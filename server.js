const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { v4: uuidv4 } = require('uuid');

// ============================================================
//  CONFIGURATION
// ============================================================
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

// ============================================================
//  ENSURE DATA DIRECTORY & FILES EXIST
// ============================================================
function ensureDataFiles() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    if (!fs.existsSync(MESSAGES_FILE)) {
        fs.writeFileSync(MESSAGES_FILE, JSON.stringify([]), 'utf8');
    }

    if (!fs.existsSync(USERS_FILE)) {
        // Seed with some default users
        const defaultUsers = [
            { id: 'u1', username: 'alice', full_name: 'Alice Wonder', phone: null, avatar_url: null },
            { id: 'u2', username: 'bob', full_name: 'Bob Builder', phone: null, avatar_url: null },
            { id: 'u3', username: 'charlie', full_name: 'Charlie Brown', phone: null, avatar_url: null },
            { id: 'me', username: 'JohnDoe', full_name: 'John Doe', phone: '+1 234 567 890', avatar_url: null }
        ];
        fs.writeFileSync(USERS_FILE, JSON.stringify(defaultUsers, null, 2), 'utf8');
    }
}

// ============================================================
//  DATA HELPERS
// ============================================================
function readMessages() {
    try {
        const data = fs.readFileSync(MESSAGES_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        return [];
    }
}

function writeMessages(messages) {
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2), 'utf8');
}

function readUsers() {
    try {
        const data = fs.readFileSync(USERS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        return [];
    }
}

function writeUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
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

// ---------- API: Get all users ----------
function getUsers(req, res) {
    const users = readUsers();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(users));
}

// ---------- API: Get messages for a user ----------
function getMessages(req, res, query) {
    const userId = query.userId || query.user_id;
    if (!userId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'userId query parameter is required' }));
        return;
    }

    const allMessages = readMessages();
    // Get messages where userId is either sender or receiver
    const userMessages = allMessages.filter(m =>
        m.sender_id === userId || m.receiver_id === userId
    );
    // Sort by created_at ascending
    userMessages.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(userMessages));
}

// ---------- API: Send a message ----------
function postMessage(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
        try {
            const { sender_id, receiver_id, ciphertext, iv } = JSON.parse(body);

            if (!sender_id || !receiver_id || !ciphertext) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'sender_id, receiver_id, and ciphertext are required' }));
                return;
            }

            // Validate users exist
            const users = readUsers();
            const senderExists = users.some(u => u.id === sender_id);
            const receiverExists = users.some(u => u.id === receiver_id);
            if (!senderExists || !receiverExists) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid sender or receiver ID' }));
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
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
        }
    });
}

// ---------- API: Create or update a user ----------
function upsertUser(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
        try {
            const userData = JSON.parse(body);
            if (!userData.id || !userData.username) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'id and username are required' }));
                return;
            }

            const users = readUsers();
            const existingIndex = users.findIndex(u => u.id === userData.id);

            if (existingIndex >= 0) {
                // Update existing user
                users[existingIndex] = { ...users[existingIndex], ...userData };
            } else {
                // Create new user
                users.push({
                    id: userData.id,
                    username: userData.username,
                    full_name: userData.full_name || '',
                    phone: userData.phone || null,
                    avatar_url: userData.avatar_url || null
                });
            }
            writeUsers(users);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(users.find(u => u.id === userData.id)));
        } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
        }
    });
}

// ---------- API: Delete a message ----------
function deleteMessage(req, res, query) {
    const messageId = query.id;
    if (!messageId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'id query parameter is required' }));
        return;
    }

    const messages = readMessages();
    const filtered = messages.filter(m => m.id !== messageId);
    if (filtered.length === messages.length) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Message not found' }));
        return;
    }
    writeMessages(filtered);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, id: messageId }));
}

// ============================================================
//  ROUTER
// ============================================================
function router(req, res) {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    const method = req.method;
    const query = parsedUrl.query;

    // Enable CORS for local development
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // API routes
    if (pathname.startsWith('/api/')) {
        const apiPath = pathname.replace('/api/', '');

        if (apiPath === 'users' && method === 'GET') {
            getUsers(req, res);
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

        if (apiPath === 'messages' && method === 'DELETE') {
            deleteMessage(req, res, query);
            return;
        }

        if (apiPath === 'users' && (method === 'POST' || method === 'PUT')) {
            upsertUser(req, res);
            return;
        }

        // 404 for unknown API
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'API endpoint not found' }));
        return;
    }

    // Serve index.html for root
    if (pathname === '/' || pathname === '/index.html') {
        serveIndex(req, res);
        return;
    }

    // Serve static files from the same directory (optional)
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

    // 404
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
    console.log(`📨 Messages: ${MESSAGES_FILE}`);
    console.log(`👤 Users: ${USERS_FILE}`);
});
