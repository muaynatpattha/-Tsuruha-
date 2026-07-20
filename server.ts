import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import fs from "fs";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '50mb' }));

  const TX_FILE = path.join(process.cwd(), 'transactions.json');
  const ACCOUNTS_FILE = path.join(process.cwd(), 'user_accounts.json');
  const ADMINS_FILE = path.join(process.cwd(), 'admin_emails.json');

  // Transactions Endpoints
  app.get("/api/transactions", (req, res) => {
    try {
      if (fs.existsSync(TX_FILE)) {
        const data = fs.readFileSync(TX_FILE, 'utf8');
        return res.json(JSON.parse(data));
      }
      return res.json([]);
    } catch (error) {
      console.error('Error reading transactions.json:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post("/api/transactions", (req, res) => {
    try {
      const data = req.body;
      if (!Array.isArray(data)) {
        return res.status(400).json({ error: 'Invalid data format' });
      }
      fs.writeFileSync(TX_FILE, JSON.stringify(data, null, 2), 'utf8');
      res.json({ success: true, count: data.length });
    } catch (error) {
      console.error('Error writing transactions.json:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // User Accounts Endpoints
  app.get("/api/user-accounts", (req, res) => {
    try {
      if (fs.existsSync(ACCOUNTS_FILE)) {
        const data = fs.readFileSync(ACCOUNTS_FILE, 'utf8');
        return res.json(JSON.parse(data));
      }
      return res.json([]);
    } catch (error) {
      console.error('Error reading user_accounts.json:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post("/api/user-accounts", (req, res) => {
    try {
      const data = req.body;
      if (!Array.isArray(data)) {
        return res.status(400).json({ error: 'Invalid data format' });
      }
      fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2), 'utf8');
      res.json({ success: true });
    } catch (error) {
      console.error('Error writing user_accounts.json:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Admin Emails Endpoints
  app.get("/api/admin-emails", (req, res) => {
    try {
      if (fs.existsSync(ADMINS_FILE)) {
        const data = fs.readFileSync(ADMINS_FILE, 'utf8');
        return res.json(JSON.parse(data));
      }
      return res.json([]);
    } catch (error) {
      console.error('Error reading admin_emails.json:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post("/api/admin-emails", (req, res) => {
    try {
      const data = req.body;
      if (!Array.isArray(data)) {
        return res.status(400).json({ error: 'Invalid data format' });
      }
      fs.writeFileSync(ADMINS_FILE, JSON.stringify(data, null, 2), 'utf8');
      res.json({ success: true });
    } catch (error) {
      console.error('Error writing admin_emails.json:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
