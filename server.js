const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files from the current directory (where server.js is)
app.use(express.static(__dirname));   // or path.join(__dirname, 'public') if you put files in a subfolder

// For any route that isn't a static file, return index.html (SPA support)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`SecureChat server running on http://localhost:${PORT}`);
});
