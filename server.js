const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files from the current directory (where server.js is)
// This will serve index.html, CSS, JS, images, etc.
app.use(express.static(.));

// For any route that isn't a static file, return index.html
// This supports client‑side routing if you later add it.
app.get('*', (req, res) => {
  res.sendFile(path.join('index.html'));
});

app.listen(PORT, () => {
  console.log(`SecureChat server running on http://localhost:${PORT}`);
});
