import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import nodemailer from 'nodemailer';
import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';

import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Firebase Admin
// PRORITIZED: 1. Environment Variable (Safe for Deployment) 2. Local JSON file
let firebaseApp;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('Firebase Admin initialized via Environment Variable');
  } catch (err) {
    console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT env var:', err);
  }
}

if (!firebaseApp) {
  const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
  if (fs.existsSync(serviceAccountPath)) {
    const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('Firebase Admin initialized with serviceAccountKey.json');
  } else {
    firebaseApp = admin.initializeApp({
      projectId: "best-time-all-mix"
    });
    console.warn('WARNING: No Firebase credentials found. Password reset on Firebase Auth will fail.');
  }
}
const dbAdmin = admin.firestore();

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
  }
});

// Configure NodeMailer transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'noreply.servicebrahvex@gmail.com',
    pass: 'aqurunqpnbxtjttd' // Provided: aqur unqp nbxt jttd
  }
});

// Temporary in-memory storage for verification codes
const verificationCodes = new Map();

app.post('/api/send-verification-code', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  // Generate a 6-digit verification code
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  verificationCodes.set(email, { code, expires: Date.now() + 600000 }); // Valid for 10 mins

  const mailOptions = {
    from: '"brahveX" <noreply.servicebrahvex@gmail.com>',
    to: email,
    subject: 'Verification Code for brahveX',
    text: `Your verification code for brahveX is: ${code}. It will expire in 10 minutes.`,
    html: `
      <div style="font-family: sans-serif; padding: 20px; text-align: center; background-color: #f7f9fc; border-radius: 12px; border: 1px solid #e4e6eb;">
        <h2 style="color: #0084ff; font-weight: 700; font-size: 24px; margin-bottom: 8px;">brahveX</h2>
        <p style="color: #65676b; font-size: 16px;">Secure your account today.</p>
        <p>Please enter the following 6-digit code to complete your registration:</p>
        <div style="font-size: 36px; font-weight: bold; color: #050505; letter-spacing: 6px; margin: 24px 0; padding: 16px; background: white; display: inline-block; border-radius: 8px; border: 1px solid #e4e6eb;">${code}</div>
        <p style="color: #8a8d91; font-size: 13px;">This code is valid for 10 minutes. If you did not request this, please ignore it.</p>
      </div>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    res.json({ message: 'Verification code sent successfully' });
  } catch (error) {
    console.error('Failed to send email:', error);
    res.status(500).json({ error: 'Failed to send verification code. Please try again.' });
  }
});

app.post('/api/verify-code', (req, res) => {
  const { email, code } = req.body;
  const storedData = verificationCodes.get(email);

  if (!storedData) return res.status(400).json({ valid: false, message: 'No code requested for this email' });
  if (Date.now() > storedData.expires) {
    verificationCodes.delete(email);
    return res.status(400).json({ valid: false, message: 'Code has expired' });
  }
  if (storedData.code === code) {
    res.json({ valid: true });
  } else {
    res.status(400).json({ valid: false, message: 'Invalid verification code' });
  }
});

app.post('/api/reset-password', async (req, res) => {
  const { email, code, newPassword } = req.body;
  
  if (!email || !code || !newPassword) {
    return res.status(400).json({ error: 'Email, code, and new password are required' });
  }

  const storedData = verificationCodes.get(email);
  if (!storedData || storedData.code !== code || Date.now() > storedData.expires) {
    return res.status(400).json({ error: 'Invalid or expired verification code' });
  }

  try {
    // 1. Update password in Firebase Auth
    const userRecord = await admin.auth().getUserByEmail(email);
    await admin.auth().updateUser(userRecord.uid, {
      password: newPassword
    });

    // 2. Update password in "user_details" collection
    // We find by email since the doc ID is username
    const userDetailsSnapshot = await dbAdmin.collection('user_details').where('email', '==', email).get();
    
    if (!userDetailsSnapshot.empty) {
      const batch = dbAdmin.batch();
      userDetailsSnapshot.forEach(doc => {
        batch.update(doc.ref, { password: newPassword });
      });
      await batch.commit();
    }

    // Clear the code after successful reset
    verificationCodes.delete(email);
    
    res.json({ message: 'Password reset successfully' });
  } catch (error) {
    console.error('Password reset error:', error);
    res.status(500).json({ error: 'Failed to reset password: ' + error.message });
  }
});

io.on('connection', (socket) => {
  console.log('a user connected', socket.id);

  // When a user logs in, link their socket to their Firebase UID
  socket.on('register', (uid) => {
    socket.join(uid);
    socket.uid = uid; // Store UID on the socket object
    console.log(`Socket ${socket.id} registered to user ${uid}`);
  });

  socket.on('private message', ({ to, msg }) => {
    // Emit only to the recipient's room
    io.to(to).emit('private message', msg);
  });

  // Relay typing status natively through the same room system
  socket.on('typing', ({ to, isTyping }) => {
    if (socket.uid) {
      io.to(to).emit('typing', { from: socket.uid, isTyping });
    }
  });

  socket.on('disconnect', () => {
    console.log('user disconnected', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
