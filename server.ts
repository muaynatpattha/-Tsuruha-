import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import fs from "fs";
import { initializeApp } from "firebase/app";
import { initializeFirestore, collection, getDocs, getDocsFromServer, doc, setDoc, deleteDoc, writeBatch, terminate, setLogLevel } from "firebase/firestore";

setLogLevel("silent");

// Helper function to enforce a timeout on Firestore promises to prevent hanging
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error("Firestore operation timed out"));
    }, timeoutMs);
    promise.then(
      (res) => {
        clearTimeout(timeoutId);
        resolve(res);
      },
      (err) => {
        clearTimeout(timeoutId);
        reject(err);
      }
    );
  });
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '50mb' }));

  const TX_FILE = path.join(process.cwd(), 'transactions.json');
  const ACCOUNTS_FILE = path.join(process.cwd(), 'user_accounts.json');
  const ADMINS_FILE = path.join(process.cwd(), 'admin_emails.json');

  // Load Firebase configuration and initialize Firestore with safe fallback
  const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
  let firebaseApp: any;
  let db: any = null;

  if (fs.existsSync(configPath)) {
    let testDb: any = null;
    try {
      const firebaseConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      firebaseApp = initializeApp(firebaseConfig);
      const dbId = firebaseConfig.firestoreDatabaseId || undefined;
      
      console.log("Initializing Firestore with long-polling enabled for robust server-side connections...");
      testDb = dbId 
        ? initializeFirestore(firebaseApp, { experimentalForceLongPolling: true }, dbId)
        : initializeFirestore(firebaseApp, { experimentalForceLongPolling: true });
      
      console.log("Testing Firestore connection to prevent hanging...");
      // Try to read a test collection with getDocsFromServer to force fail-fast online check (3 seconds timeout)
      const testColRef = collection(testDb, "admin_emails");
      await withTimeout(getDocsFromServer(testColRef), 3000);
      
      db = testDb;
      console.log("Firestore initialized and connected successfully on server-side!");
    } catch (error: any) {
      console.warn("Firestore database not found, offline, or inaccessible. Falling back to local files. Error:", error.message || error);
      db = null;
      if (testDb) {
        try {
          console.log("Terminating pending Firestore connection streams...");
          await terminate(testDb);
          console.log("Firestore connection streams terminated successfully.");
        } catch (termErr: any) {
          console.error("Failed to terminate Firestore instance:", termErr.message || termErr);
        }
      }
    }
  } else {
    console.warn("firebase-applet-config.json not found. Firestore will not be initialized.");
  }

  // Helper to dynamically disable Firestore on any query/write failure or timeout
  async function disableFirestore(reason: string) {
    if (!db) return;
    console.warn(`[Firestore Circuit Breaker] Disabling Firestore on server due to: ${reason}`);
    const dbToTerminate = db;
    db = null; // Instantly fall back all routing to local files
    try {
      console.log("[Firestore Circuit Breaker] Terminating pending Firestore streams...");
      await terminate(dbToTerminate);
      console.log("[Firestore Circuit Breaker] Firestore streams terminated successfully.");
    } catch (err: any) {
      console.error("[Firestore Circuit Breaker] Error terminating Firestore instance:", err.message || err);
    }
  }

  // Seeding local data to Firestore if Firestore is empty on startup
  async function seedFirestore() {
    if (!db) return;
    try {
      // 1. Seed transactions if empty
      const txColRef = collection(db, "transactions");
      const txSnap = await withTimeout(getDocs(txColRef), 10000);
      if (txSnap.empty && fs.existsSync(TX_FILE)) {
        const localData = JSON.parse(fs.readFileSync(TX_FILE, 'utf8'));
        if (Array.isArray(localData) && localData.length > 0) {
          console.log(`Seeding ${localData.length} transactions to Firestore...`);
          let batch = writeBatch(db);
          let count = 0;
          for (const tx of localData) {
            const docRef = doc(db, "transactions", tx.id);
            batch.set(docRef, tx);
            count++;
            if (count === 500) {
              await withTimeout(batch.commit(), 10000);
              batch = writeBatch(db);
              count = 0;
            }
          }
          if (count > 0) {
            await withTimeout(batch.commit(), 10000);
          }
          console.log("Transactions seeding completed!");
        }
      }

      // 2. Seed user accounts if empty
      const accountsColRef = collection(db, "user_accounts");
      const accountsSnap = await withTimeout(getDocs(accountsColRef), 10000);
      if (accountsSnap.empty && fs.existsSync(ACCOUNTS_FILE)) {
        const localData = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
        if (Array.isArray(localData) && localData.length > 0) {
          console.log(`Seeding ${localData.length} user accounts to Firestore...`);
          let batch = writeBatch(db);
          let count = 0;
          for (const account of localData) {
            const docRef = doc(db, "user_accounts", account.userCode);
            batch.set(docRef, account);
            count++;
            if (count === 500) {
              await withTimeout(batch.commit(), 10000);
              batch = writeBatch(db);
              count = 0;
            }
          }
          if (count > 0) {
            await withTimeout(batch.commit(), 10000);
          }
          console.log("User accounts seeding completed!");
        }
      }

      // 3. Seed admin emails if empty
      const adminsColRef = collection(db, "admin_emails");
      const adminsSnap = await withTimeout(getDocs(adminsColRef), 10000);
      if (adminsSnap.empty && fs.existsSync(ADMINS_FILE)) {
        const localData = JSON.parse(fs.readFileSync(ADMINS_FILE, 'utf8'));
        if (Array.isArray(localData) && localData.length > 0) {
          console.log(`Seeding ${localData.length} admin emails to Firestore...`);
          let batch = writeBatch(db);
          let count = 0;
          for (const email of localData) {
            const docId = email.replace(/[@.]/g, "_");
            const docRef = doc(db, "admin_emails", docId);
            batch.set(docRef, { email });
            count++;
            if (count === 500) {
              await withTimeout(batch.commit(), 10000);
              batch = writeBatch(db);
              count = 0;
            }
          }
          if (count > 0) {
            await withTimeout(batch.commit(), 10000);
          }
          console.log("Admin emails seeding completed!");
        }
      }
    } catch (error: any) {
      console.warn("Error seeding Firestore on startup:", error);
      await disableFirestore(error.message || String(error));
    }
  }

  // Seed data asynchronously without blocking the main server thread or startup
  seedFirestore().catch((err) => {
    console.warn("Background Firestore seeding error:", err);
  });

  // Transactions Endpoints
  app.get("/api/transactions", async (req, res) => {
    try {
      if (db) {
        try {
          const txColRef = collection(db, "transactions");
          const querySnapshot = await withTimeout(getDocs(txColRef), 10000);
          const serverTxs: any[] = [];
          querySnapshot.forEach((doc) => {
            serverTxs.push(doc.data());
          });
          // Sort: latest date first, then latest timestamp or id
          serverTxs.sort((a, b) => {
            if (b.date !== a.date) return b.date.localeCompare(a.date);
            const timeA = a.timestamp || '';
            const timeB = b.timestamp || '';
            if (timeB !== timeA) return timeB.localeCompare(timeA);
            return b.id.localeCompare(a.id);
          });
          return res.json(serverTxs);
        } catch (dbErr: any) {
          console.warn("Firestore read failed for transactions, falling back to local file:", dbErr);
          await disableFirestore(dbErr.message || String(dbErr));
        }
      }
      
      // Fallback
      if (fs.existsSync(TX_FILE)) {
        const data = fs.readFileSync(TX_FILE, 'utf8');
        return res.json(JSON.parse(data));
      }
      return res.json([]);
    } catch (error) {
      console.error('Error getting transactions:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post("/api/transactions", async (req, res) => {
    try {
      const data = req.body;
      if (!Array.isArray(data)) {
        return res.status(400).json({ error: 'Invalid data format' });
      }

      // Sync to Firestore
      if (db) {
        try {
          const txColRef = collection(db, "transactions");
          const querySnapshot = await withTimeout(getDocs(txColRef), 10000);
          const existingIds = new Set<string>();
          querySnapshot.forEach((doc) => {
            existingIds.add(doc.id);
          });

          const incomingIds = new Set(data.map(tx => tx.id));

          // 1. Write incoming transactions (batches of 500)
          let batch = writeBatch(db);
          let count = 0;
          for (const tx of data) {
            const docRef = doc(db, "transactions", tx.id);
            batch.set(docRef, tx);
            count++;
            if (count === 500) {
              await withTimeout(batch.commit(), 10000);
              batch = writeBatch(db);
              count = 0;
            }
          }
          if (count > 0) {
            await withTimeout(batch.commit(), 10000);
          }

          // 2. Delete transactions that are not in incoming
          let deleteBatch = writeBatch(db);
          let deleteCount = 0;
          for (const id of existingIds) {
            if (!incomingIds.has(id)) {
              const docRef = doc(db, "transactions", id);
              deleteBatch.delete(docRef);
              deleteCount++;
              if (deleteCount === 500) {
                await withTimeout(deleteBatch.commit(), 10000);
                deleteBatch = writeBatch(db);
                deleteCount = 0;
              }
            }
          }
          if (deleteCount > 0) {
            await withTimeout(deleteBatch.commit(), 10000);
          }
        } catch (dbErr: any) {
          console.warn("Firestore write failed for transactions, falling back to local only:", dbErr);
          await disableFirestore(dbErr.message || String(dbErr));
        }
      }

      // Fallback local save
      fs.writeFileSync(TX_FILE, JSON.stringify(data, null, 2), 'utf8');
      res.json({ success: true, count: data.length });
    } catch (error) {
      console.error('Error updating transactions:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // User Accounts Endpoints
  app.get("/api/user-accounts", async (req, res) => {
    try {
      if (db) {
        try {
          const accountsColRef = collection(db, "user_accounts");
          const querySnapshot = await withTimeout(getDocs(accountsColRef), 10000);
          const serverAccounts: any[] = [];
          querySnapshot.forEach((doc) => {
            serverAccounts.push(doc.data());
          });
          return res.json(serverAccounts);
        } catch (dbErr: any) {
          console.warn("Firestore read failed for user-accounts, falling back to local file:", dbErr);
          await disableFirestore(dbErr.message || String(dbErr));
        }
      }
      
      if (fs.existsSync(ACCOUNTS_FILE)) {
        const data = fs.readFileSync(ACCOUNTS_FILE, 'utf8');
        return res.json(JSON.parse(data));
      }
      return res.json([]);
    } catch (error) {
      console.error('Error getting user-accounts:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post("/api/user-accounts", async (req, res) => {
    try {
      const data = req.body;
      if (!Array.isArray(data)) {
        return res.status(400).json({ error: 'Invalid data format' });
      }

      if (db) {
        try {
          const accountsColRef = collection(db, "user_accounts");
          const querySnapshot = await withTimeout(getDocs(accountsColRef), 10000);
          const existingIds = new Set<string>();
          querySnapshot.forEach((doc) => {
            existingIds.add(doc.id);
          });

          const incomingIds = new Set(data.map(account => account.userCode));

          // Write incoming
          let batch = writeBatch(db);
          let count = 0;
          for (const account of data) {
            const docRef = doc(db, "user_accounts", account.userCode);
            batch.set(docRef, account);
            count++;
            if (count === 500) {
              await withTimeout(batch.commit(), 10000);
              batch = writeBatch(db);
              count = 0;
            }
          }
          if (count > 0) {
            await withTimeout(batch.commit(), 10000);
          }

          // Delete removed
          let deleteBatch = writeBatch(db);
          let deleteCount = 0;
          for (const id of existingIds) {
            if (!incomingIds.has(id)) {
              const docRef = doc(db, "user_accounts", id);
              deleteBatch.delete(docRef);
              deleteCount++;
              if (deleteCount === 500) {
                await withTimeout(deleteBatch.commit(), 10000);
                deleteBatch = writeBatch(db);
                deleteCount = 0;
              }
            }
          }
          if (deleteCount > 0) {
            await withTimeout(deleteBatch.commit(), 10000);
          }
        } catch (dbErr: any) {
          console.warn("Firestore write failed for user-accounts, falling back to local only:", dbErr);
          await disableFirestore(dbErr.message || String(dbErr));
        }
      }

      fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2), 'utf8');
      res.json({ success: true });
    } catch (error) {
      console.error('Error updating user-accounts:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Admin Emails Endpoints
  app.get("/api/admin-emails", async (req, res) => {
    try {
      if (db) {
        try {
          const adminsColRef = collection(db, "admin_emails");
          const querySnapshot = await withTimeout(getDocs(adminsColRef), 10000);
          const serverAdmins: string[] = [];
          querySnapshot.forEach((doc) => {
            const docData = doc.data();
            if (docData && typeof docData.email === 'string') {
              serverAdmins.push(docData.email);
            }
          });
          return res.json(serverAdmins);
        } catch (dbErr: any) {
          console.warn("Firestore read failed for admin-emails, falling back to local file:", dbErr);
          await disableFirestore(dbErr.message || String(dbErr));
        }
      }
      
      if (fs.existsSync(ADMINS_FILE)) {
        const data = fs.readFileSync(ADMINS_FILE, 'utf8');
        return res.json(JSON.parse(data));
      }
      return res.json([]);
    } catch (error) {
      console.error('Error getting admin-emails:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post("/api/admin-emails", async (req, res) => {
    try {
      const data = req.body;
      if (!Array.isArray(data)) {
        return res.status(400).json({ error: 'Invalid data format' });
      }

      if (db) {
        try {
          const adminsColRef = collection(db, "admin_emails");
          const querySnapshot = await withTimeout(getDocs(adminsColRef), 10000);
          const existingIds = new Set<string>();
          querySnapshot.forEach((doc) => {
            existingIds.add(doc.id);
          });

          const incomingIds = new Set(data.map(email => email.replace(/[@.]/g, "_")));

          // Write incoming
          let batch = writeBatch(db);
          let count = 0;
          for (const email of data) {
            const docId = email.replace(/[@.]/g, "_");
            const docRef = doc(db, "admin_emails", docId);
            batch.set(docRef, { email });
            count++;
            if (count === 500) {
              await withTimeout(batch.commit(), 10000);
              batch = writeBatch(db);
              count = 0;
            }
          }
          if (count > 0) {
            await withTimeout(batch.commit(), 10000);
          }

          // Delete removed
          let deleteBatch = writeBatch(db);
          let deleteCount = 0;
          for (const id of existingIds) {
            if (!incomingIds.has(id)) {
              const docRef = doc(db, "admin_emails", id);
              deleteBatch.delete(docRef);
              deleteCount++;
              if (deleteCount === 500) {
                await withTimeout(deleteBatch.commit(), 10000);
                deleteBatch = writeBatch(db);
                deleteCount = 0;
              }
            }
          }
          if (deleteCount > 0) {
            await withTimeout(deleteBatch.commit(), 10000);
          }
        } catch (dbErr: any) {
          console.warn("Firestore write failed for admin-emails, falling back to local only:", dbErr);
          await disableFirestore(dbErr.message || String(dbErr));
        }
      }

      fs.writeFileSync(ADMINS_FILE, JSON.stringify(data, null, 2), 'utf8');
      res.json({ success: true });
    } catch (error) {
      console.error('Error updating admin-emails:', error);
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
