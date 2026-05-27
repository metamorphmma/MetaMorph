const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// DB setup
const db = new Database('fightco.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'student',
    profile_pic TEXT,
    height_cm INTEGER,
    weight_kg REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS bjj_progress (
    user_id INTEGER PRIMARY KEY,
    belt TEXT DEFAULT 'white',
    stripes INTEGER DEFAULT 0,
    assigned_by INTEGER,
    assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS mt_progress (
    user_id INTEGER PRIMARY KEY,
    level INTEGER DEFAULT 1,
    assigned_by INTEGER,
    assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS competition_records (
    user_id INTEGER NOT NULL,
    martial_art TEXT NOT NULL,
    wins INTEGER DEFAULT 0,
    draws INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, martial_art),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// File uploads
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `user_${req.session.userId}_${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Images only'));
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'fightco-s3cr3t-k3y-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// Middleware
const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
};

const requireCoach = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const u = db.prepare('SELECT role FROM users WHERE id = ?').get(req.session.userId);
  if (!u || u.role !== 'coach') return res.status(403).json({ error: 'Coach access required' });
  next();
};

function getProfile(userId) {
  const user = db.prepare(
    'SELECT id, name, email, role, profile_pic, height_cm, weight_kg, created_at FROM users WHERE id = ?'
  ).get(userId);
  if (!user) return null;

  const bjj = db.prepare('SELECT belt, stripes, assigned_at FROM bjj_progress WHERE user_id = ?').get(userId);
  const mt = db.prepare('SELECT level, assigned_at FROM mt_progress WHERE user_id = ?').get(userId);
  const bjjComp = db.prepare('SELECT wins, draws, losses FROM competition_records WHERE user_id = ? AND martial_art = ?').get(userId, 'bjj');
  const mtComp = db.prepare('SELECT wins, draws, losses FROM competition_records WHERE user_id = ? AND martial_art = ?').get(userId, 'mt');

  return {
    ...user,
    bjj: bjj || { belt: 'white', stripes: 0 },
    mt: mt || { level: 1 },
    competition: {
      bjj: bjjComp || { wins: 0, draws: 0, losses: 0 },
      mt: mtComp || { wins: 0, draws: 0, losses: 0 }
    }
  };
}

function initUserProgress(userId) {
  db.prepare('INSERT OR IGNORE INTO bjj_progress (user_id) VALUES (?)').run(userId);
  db.prepare('INSERT OR IGNORE INTO mt_progress (user_id) VALUES (?)').run(userId);
  db.prepare('INSERT OR IGNORE INTO competition_records (user_id, martial_art) VALUES (?, ?)').run(userId, 'bjj');
  db.prepare('INSERT OR IGNORE INTO competition_records (user_id, martial_art) VALUES (?, ?)').run(userId, 'mt');
}

// Auth routes
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password, coachCode } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password required' });

  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'Email already registered' });
  }

  const hash = await bcrypt.hash(password, 10);
  const role = coachCode === 'FIGHTCO-COACH-2024' ? 'coach' : 'student';

  const { lastInsertRowid: userId } = db.prepare(
    'INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)'
  ).run(name, email, hash, role);

  initUserProgress(userId);
  req.session.userId = userId;
  res.json({ user: getProfile(userId) });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  req.session.userId = user.id;
  res.json({ user: getProfile(user.id) });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const profile = getProfile(req.session.userId);
  if (!profile) return res.status(404).json({ error: 'Not found' });
  res.json(profile);
});

// Users
app.get('/api/users', (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.name, u.role, u.profile_pic,
           COALESCE(b.belt,'white') AS belt, COALESCE(b.stripes,0) AS stripes,
           COALESCE(m.level,1) AS mt_level
    FROM users u
    LEFT JOIN bjj_progress b ON u.id = b.user_id
    LEFT JOIN mt_progress m ON u.id = m.user_id
    ORDER BY u.name
  `).all();
  res.json(users);
});

app.get('/api/users/:id', (req, res) => {
  const profile = getProfile(parseInt(req.params.id));
  if (!profile) return res.status(404).json({ error: 'Not found' });
  res.json(profile);
});

app.put('/api/users/:id/profile', requireAuth, (req, res) => {
  const targetId = parseInt(req.params.id);
  if (req.session.userId !== targetId) return res.status(403).json({ error: 'Cannot edit another user\'s profile' });

  const { name, height_cm, weight_kg } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });

  db.prepare('UPDATE users SET name = ?, height_cm = ?, weight_kg = ? WHERE id = ?')
    .run(name, height_cm || null, weight_kg || null, targetId);
  res.json(getProfile(targetId));
});

app.post('/api/users/:id/avatar', requireAuth, upload.single('avatar'), (req, res) => {
  const targetId = parseInt(req.params.id);
  if (req.session.userId !== targetId) return res.status(403).json({ error: 'Cannot edit another user\'s profile' });
  if (!req.file) return res.status(400).json({ error: 'No file' });

  // Delete old avatar
  const old = db.prepare('SELECT profile_pic FROM users WHERE id = ?').get(targetId);
  if (old && old.profile_pic) {
    const oldPath = path.join(__dirname, 'public', old.profile_pic);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }

  const picPath = `/uploads/${req.file.filename}`;
  db.prepare('UPDATE users SET profile_pic = ? WHERE id = ?').run(picPath, targetId);
  res.json({ profile_pic: picPath });
});

app.put('/api/users/:id/bjj', requireCoach, (req, res) => {
  const targetId = parseInt(req.params.id);
  const { belt, stripes } = req.body;
  const validBelts = ['white', 'blue', 'purple', 'brown', 'black'];
  if (!validBelts.includes(belt)) return res.status(400).json({ error: 'Invalid belt' });
  if (stripes < 0 || stripes > 4) return res.status(400).json({ error: 'Stripes must be 0-4' });

  db.prepare(`
    INSERT INTO bjj_progress (user_id, belt, stripes, assigned_by, assigned_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      belt = excluded.belt, stripes = excluded.stripes,
      assigned_by = excluded.assigned_by, assigned_at = excluded.assigned_at
  `).run(targetId, belt, stripes, req.session.userId);

  res.json(getProfile(targetId));
});

app.put('/api/users/:id/mt', requireCoach, (req, res) => {
  const targetId = parseInt(req.params.id);
  const { level } = req.body;
  if (level < 1 || level > 5) return res.status(400).json({ error: 'Level must be 1-5' });

  db.prepare(`
    INSERT INTO mt_progress (user_id, level, assigned_by, assigned_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      level = excluded.level, assigned_by = excluded.assigned_by, assigned_at = excluded.assigned_at
  `).run(targetId, level, req.session.userId);

  res.json(getProfile(targetId));
});

app.put('/api/users/:id/competition', requireAuth, (req, res) => {
  const targetId = parseInt(req.params.id);
  if (req.session.userId !== targetId) return res.status(403).json({ error: 'Cannot edit another user\'s records' });

  const { bjj, mt } = req.body;

  if (bjj) {
    db.prepare(`
      INSERT INTO competition_records (user_id, martial_art, wins, draws, losses) VALUES (?, 'bjj', ?, ?, ?)
      ON CONFLICT(user_id, martial_art) DO UPDATE SET wins = excluded.wins, draws = excluded.draws, losses = excluded.losses
    `).run(targetId, bjj.wins || 0, bjj.draws || 0, bjj.losses || 0);
  }
  if (mt) {
    db.prepare(`
      INSERT INTO competition_records (user_id, martial_art, wins, draws, losses) VALUES (?, 'mt', ?, ?, ?)
      ON CONFLICT(user_id, martial_art) DO UPDATE SET wins = excluded.wins, draws = excluded.draws, losses = excluded.losses
    `).run(targetId, mt.wins || 0, mt.draws || 0, mt.losses || 0);
  }

  res.json(getProfile(targetId));
});

app.listen(PORT, () => console.log(`FightCo running → http://localhost:${PORT}`));
