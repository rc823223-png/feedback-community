require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL connection pool
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'feedback_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
});

// Test DB connection and create visitors table if not exists
pool.connect(async (err, client, release) => {
  if (err) {
    console.error('❌ Database connection error:', err.message);
    console.log('⚠️  Make sure PostgreSQL is running and .env is configured.');
  } else {
    console.log('✅ Database connected successfully');
    await client.query(`
      CREATE TABLE IF NOT EXISTS visitors (
        id SERIAL PRIMARY KEY,
        visited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ip_address VARCHAR(200),
        user_agent TEXT
      );
    `);
    console.log('✅ Visitors table ready');
    release();
  }
});

// ─── MIDDLEWARE ──────────────────────────────────────────────────
app.set('trust proxy', true); // Trust devtunnel / proxy headers
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// ─── VISITOR TRACKER MIDDLEWARE ──────────────────────────────────
// Runs for ALL requests to '/' — works for localhost AND devtunnel
app.use(async (req, res, next) => {
  if (req.path === '/' && req.method === 'GET') {
    try {
      const ip = req.headers['x-forwarded-for']?.split(',')[0].trim()
               || req.headers['x-real-ip']
               || req.ip
               || req.connection.remoteAddress
               || 'unknown';
      const ua = req.headers['user-agent'] || 'unknown';
      await pool.query(
        'INSERT INTO visitors (ip_address, user_agent) VALUES ($1, $2)',
        [ip, ua]
      );
      console.log('👁️  Visitor tracked from:', ip);
    } catch (e) {
      console.log('❌ Visitor tracking error:', e.message);
    }
  }
  next();
});

// ─── STATIC FILES ────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── ADMIN AUTH MIDDLEWARE ───────────────────────────────────────
const requireAuth = (req, res, next) => {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: 'Unauthorized' });
};

// ─── PUBLIC ROUTES ───────────────────────────────────────────────

// Serve main form page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Submit feedback
app.post('/api/submit', async (req, res) => {
  try {
    const { name, village, mobile, class_reading, interests, opinion } = req.body;

    if (!village || !mobile || !class_reading || !interests || interests.length === 0) {
      return res.status(400).json({
        error: 'Village, Mobile, Class, and at least one Interest are required.'
      });
    }

    const mobileRegex = /^[6-9]\d{9}$/;
    if (!mobileRegex.test(mobile.replace(/\s/g, ''))) {
      return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number.' });
    }

    const interestsArray = Array.isArray(interests) ? interests : [interests];
    const ipAddress = req.headers['x-forwarded-for']?.split(',')[0].trim()
                    || req.ip || req.connection.remoteAddress;

    const result = await pool.query(
      `INSERT INTO submissions (name, village, mobile, class_reading, interests, opinion, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [name || null, village, mobile, class_reading, interestsArray, opinion || null, ipAddress]
    );

    res.json({
      success: true,
      message: 'Thank you! Your feedback has been submitted successfully.',
      id: result.rows[0].id
    });
  } catch (err) {
    console.error('Submit error:', err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ─── ADMIN ROUTES ────────────────────────────────────────────────

// Admin login page
app.get('/admin', (req, res) => {
  if (req.session && req.session.isAdmin) return res.redirect('/admin/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
});

// Admin login POST
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  const adminUser = process.env.ADMIN_USERNAME || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
  if (username === adminUser && password === adminPass) {
    req.session.isAdmin = true;
    req.session.username = username;
    return res.json({ success: true });
  }
  return res.status(401).json({ error: 'Invalid credentials.' });
});

// Admin logout
app.post('/api/admin/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Admin dashboard page
app.get('/admin/dashboard', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-dashboard.html'));
});

// Get all submissions (admin)
app.get('/api/admin/submissions', requireAuth, async (req, res) => {
  try {
    const { page = 1, limit = 20, village, class_reading, search } = req.query;
    const offset = (page - 1) * limit;
    let whereConditions = [];
    let params = [];
    let paramCount = 1;

    if (village) {
      whereConditions.push(`village ILIKE $${paramCount}`);
      params.push(`%${village}%`); paramCount++;
    }
    if (class_reading) {
      whereConditions.push(`class_reading = $${paramCount}`);
      params.push(class_reading); paramCount++;
    }
    if (search) {
      whereConditions.push(`(name ILIKE $${paramCount} OR mobile ILIKE $${paramCount} OR village ILIKE $${paramCount})`);
      params.push(`%${search}%`); paramCount++;
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
    const countResult = await pool.query(`SELECT COUNT(*) FROM submissions ${whereClause}`, params);
    params.push(limit, offset);
    const result = await pool.query(
      `SELECT * FROM submissions ${whereClause} ORDER BY submitted_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`,
      params
    );

    res.json({
      submissions: result.rows,
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page),
      pages: Math.ceil(countResult.rows[0].count / limit)
    });
  } catch (err) {
    console.error('Admin fetch error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// Get stats (admin)
app.get('/api/admin/stats', requireAuth, async (req, res) => {
  try {
    const total         = await pool.query('SELECT COUNT(*) FROM submissions');
    const villages      = await pool.query('SELECT COUNT(DISTINCT village) FROM submissions');
    const classes       = await pool.query('SELECT class_reading, COUNT(*) as count FROM submissions GROUP BY class_reading ORDER BY count DESC');
    const interests     = await pool.query(`SELECT unnest(interests) as interest, COUNT(*) as count FROM submissions GROUP BY interest ORDER BY count DESC LIMIT 10`);
    const recent        = await pool.query(`SELECT DATE(submitted_at) as date, COUNT(*) as count FROM submissions WHERE submitted_at >= NOW() - INTERVAL '7 days' GROUP BY DATE(submitted_at) ORDER BY date`);
    const totalVisitors = await pool.query('SELECT COUNT(*) FROM visitors');
    const todayVisitors = await pool.query(`SELECT COUNT(*) FROM visitors WHERE DATE(visited_at) = CURRENT_DATE`);
    const uniqueVisitors= await pool.query(`SELECT COUNT(DISTINCT ip_address) FROM visitors WHERE ip_address != 'test'`);

    res.json({
      total: parseInt(total.rows[0].count),
      uniqueVillages: parseInt(villages.rows[0].count),
      byClass: classes.rows,
      topInterests: interests.rows,
      recentActivity: recent.rows,
      totalVisitors: parseInt(totalVisitors.rows[0].count),
      todayVisitors: parseInt(todayVisitors.rows[0].count),
      uniqueVisitors: parseInt(uniqueVisitors.rows[0].count),
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// Delete a submission (admin)
app.delete('/api/admin/submissions/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM submissions WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Delete failed.' });
  }
});

// Export as CSV (admin)
app.get('/api/admin/export', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM submissions ORDER BY submitted_at DESC');
    const headers = ['ID', 'Name', 'Village', 'Mobile', 'Class', 'Interests', 'Opinion', 'Submitted At'];
    const csv = [
      headers.join(','),
      ...result.rows.map(row => [
        row.id,
        `"${row.name || ''}"`,
        `"${row.village}"`,
        row.mobile,
        row.class_reading,
        `"${(row.interests || []).join('; ')}"`,
        `"${(row.opinion || '').replace(/"/g, '""')}"`,
        row.submitted_at
      ].join(','))
    ].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="submissions.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: 'Export failed.' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`\n🚀 Server running at http://localhost:${PORT}`);
  console.log(`📋 Admin panel at http://localhost:${PORT}/admin`);
  console.log(`\nDefault admin: admin / admin123 (change in .env)\n`);
});
