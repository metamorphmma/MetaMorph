import os
import sqlite3
import secrets
from datetime import timedelta
from functools import wraps
from flask import Flask, request, jsonify, session, send_from_directory, g
import bcrypt
import cloudinary
import cloudinary.uploader

app = Flask(__name__, static_folder='public', static_url_path='')
app.secret_key = os.environ.get('SESSION_SECRET', secrets.token_hex(32))
app.permanent_session_lifetime = timedelta(days=7)
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50 MB — supports short video uploads

cloudinary.config(
    cloud_name = os.environ.get('CLOUDINARY_CLOUD_NAME', ''),
    api_key    = os.environ.get('CLOUDINARY_API_KEY', ''),
    api_secret = os.environ.get('CLOUDINARY_API_SECRET', '')
)

DB_PATH = os.environ.get('DB_PATH', 'metamorph.db')

# ── Database ──────────────────────────────────────────────────────────────────

def get_db():
    if 'db' not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute('PRAGMA journal_mode=WAL')
    return g.db

@app.teardown_appcontext
def close_db(_):
    db = g.pop('db', None)
    if db:
        db.close()

def needs_migration():
    """Check if the DB is missing the status column."""
    try:
        with sqlite3.connect(DB_PATH) as db:
            db.execute('SELECT status FROM users LIMIT 1')
        return False
    except sqlite3.OperationalError:
        return True

def init_db():
    if os.path.exists(DB_PATH) and needs_migration():
        os.remove(DB_PATH)   # Old schema — start fresh

    with sqlite3.connect(DB_PATH) as db:
        db.executescript('''
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS users (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                name          TEXT UNIQUE NOT NULL COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                role          TEXT DEFAULT 'student',
                status        TEXT DEFAULT 'pending',
                profile_pic   TEXT,
                height_cm     INTEGER,
                weight_kg     REAL,
                bjj_active     INTEGER DEFAULT 1,
                mt_active      INTEGER DEFAULT 1,
                boxing_active  INTEGER DEFAULT 1,
                created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS bjj_progress (
                user_id     INTEGER PRIMARY KEY,
                belt        TEXT DEFAULT 'white',
                stripes     INTEGER DEFAULT 0,
                assigned_by INTEGER,
                assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id)
            );
            CREATE TABLE IF NOT EXISTS mt_progress (
                user_id     INTEGER PRIMARY KEY,
                level       INTEGER DEFAULT 1,
                assigned_by INTEGER,
                assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id)
            );
            CREATE TABLE IF NOT EXISTS boxing_progress (
                user_id     INTEGER PRIMARY KEY,
                level       INTEGER DEFAULT 1,
                assigned_by INTEGER,
                assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id)
            );
            CREATE TABLE IF NOT EXISTS competition_records (
                user_id    INTEGER NOT NULL,
                martial_art TEXT NOT NULL,
                wins       INTEGER DEFAULT 0,
                draws      INTEGER DEFAULT 0,
                losses     INTEGER DEFAULT 0,
                PRIMARY KEY (user_id, martial_art),
                FOREIGN KEY (user_id) REFERENCES users(id)
            );
            CREATE TABLE IF NOT EXISTS weapon_assignments (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                from_user   INTEGER NOT NULL,
                to_user     INTEGER NOT NULL,
                discipline  TEXT NOT NULL,
                weapon      TEXT NOT NULL,
                assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(from_user, to_user, discipline, weapon),
                FOREIGN KEY (from_user) REFERENCES users(id),
                FOREIGN KEY (to_user)   REFERENCES users(id)
            );
            CREATE TABLE IF NOT EXISTS student_media (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                uploader_id INTEGER NOT NULL,
                subject_id  INTEGER NOT NULL,
                media_url   TEXT NOT NULL,
                media_type  TEXT NOT NULL,
                public_id   TEXT NOT NULL,
                uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (uploader_id) REFERENCES users(id),
                FOREIGN KEY (subject_id)  REFERENCES users(id)
            );
        ''')

init_db()

def add_new_columns():
    """Non-destructively add columns introduced after initial release."""
    with sqlite3.connect(DB_PATH) as db:
        for stmt in (
            'ALTER TABLE users ADD COLUMN bjj_active    INTEGER DEFAULT 1',
            'ALTER TABLE users ADD COLUMN mt_active     INTEGER DEFAULT 1',
            'ALTER TABLE users ADD COLUMN boxing_active INTEGER DEFAULT 1',
        ):
            try:
                db.execute(stmt)
            except sqlite3.OperationalError:
                pass  # column already exists
        db.commit()

add_new_columns()

def seed_boxing_for_existing():
    """Backfill boxing records for students registered before boxing was added."""
    with sqlite3.connect(DB_PATH) as db:
        rows = db.execute("SELECT id FROM users WHERE role='student'").fetchall()
        for (uid,) in rows:
            db.execute('INSERT OR IGNORE INTO boxing_progress (user_id) VALUES (?)', (uid,))
            db.execute("INSERT OR IGNORE INTO competition_records (user_id, martial_art) VALUES (?, 'boxing')", (uid,))
        db.commit()

seed_boxing_for_existing()

# ── Helpers ───────────────────────────────────────────────────────────────────

def get_profile(user_id):
    db = get_db()
    row = db.execute(
        'SELECT id, name, role, status, profile_pic, height_cm, weight_kg, bjj_active, mt_active, boxing_active, created_at FROM users WHERE id = ?',
        (user_id,)
    ).fetchone()
    if not row:
        return None
    u = dict(row)
    bjj    = db.execute('SELECT belt, stripes FROM bjj_progress    WHERE user_id = ?', (user_id,)).fetchone()
    mt     = db.execute('SELECT level FROM mt_progress             WHERE user_id = ?', (user_id,)).fetchone()
    boxing = db.execute('SELECT level FROM boxing_progress         WHERE user_id = ?', (user_id,)).fetchone()
    bc  = db.execute("SELECT wins,draws,losses FROM competition_records WHERE user_id=? AND martial_art='bjj'",    (user_id,)).fetchone()
    mc  = db.execute("SELECT wins,draws,losses FROM competition_records WHERE user_id=? AND martial_art='mt'",     (user_id,)).fetchone()
    bxc = db.execute("SELECT wins,draws,losses FROM competition_records WHERE user_id=? AND martial_art='boxing'", (user_id,)).fetchone()
    u['bjj']    = dict(bjj)    if bjj    else {'belt': 'white', 'stripes': 0}
    u['mt']     = dict(mt)     if mt     else {'level': 1}
    u['boxing'] = dict(boxing) if boxing else {'level': 1}
    u['competition'] = {
        'bjj':    dict(bc)  if bc  else {'wins': 0, 'draws': 0, 'losses': 0},
        'mt':     dict(mc)  if mc  else {'wins': 0, 'draws': 0, 'losses': 0},
        'boxing': dict(bxc) if bxc else {'wins': 0, 'draws': 0, 'losses': 0},
    }
    # Weapons assigned to this user by anyone (deduplicated)
    w_rows = db.execute(
        'SELECT DISTINCT discipline, weapon FROM weapon_assignments WHERE to_user=? ORDER BY discipline, weapon',
        (user_id,)
    ).fetchall()
    weapons = {'bjj': [], 'mt': [], 'boxing': []}
    for r in w_rows:
        if r['discipline'] in weapons:
            weapons[r['discipline']].append(r['weapon'])
    u['weapons'] = weapons
    # Clear-winner weapon per discipline (same logic as the roster card)
    sig_weapons = {}
    for disc in ('bjj', 'mt', 'boxing'):
        row = db.execute('''
            SELECT CASE WHEN COUNT(*)=1 THEN MAX(weapon) ELSE NULL END
            FROM (
                SELECT weapon FROM weapon_assignments WHERE to_user=? AND discipline=?
                GROUP BY weapon HAVING COUNT(*)=(
                    SELECT MAX(c) FROM (SELECT COUNT(*) c FROM weapon_assignments
                        WHERE to_user=? AND discipline=? GROUP BY weapon)
                )
            )
        ''', (user_id, disc, user_id, disc)).fetchone()
        sig_weapons[disc] = row[0] if row and row[0] else None
    u['sig_weapons'] = sig_weapons
    return u

def seed_progress(db, user_id):
    db.execute('INSERT OR IGNORE INTO bjj_progress    (user_id) VALUES (?)', (user_id,))
    db.execute('INSERT OR IGNORE INTO mt_progress     (user_id) VALUES (?)', (user_id,))
    db.execute('INSERT OR IGNORE INTO boxing_progress (user_id) VALUES (?)', (user_id,))
    db.execute("INSERT OR IGNORE INTO competition_records (user_id, martial_art) VALUES (?, 'bjj')",    (user_id,))
    db.execute("INSERT OR IGNORE INTO competition_records (user_id, martial_art) VALUES (?, 'mt')",     (user_id,))
    db.execute("INSERT OR IGNORE INTO competition_records (user_id, martial_art) VALUES (?, 'boxing')", (user_id,))
    db.commit()

def require_auth(f):
    @wraps(f)
    def wrap(*a, **kw):
        if 'user_id' not in session:
            return jsonify({'error': 'Not authenticated'}), 401
        return f(*a, **kw)
    return wrap

def require_admin(f):
    @wraps(f)
    def wrap(*a, **kw):
        if 'user_id' not in session:
            return jsonify({'error': 'Not authenticated'}), 401
        row = get_db().execute('SELECT role FROM users WHERE id = ?', (session['user_id'],)).fetchone()
        if not row or row['role'] != 'admin':
            return jsonify({'error': 'Admin access required'}), 403
        return f(*a, **kw)
    return wrap

# ── Auth ──────────────────────────────────────────────────────────────────────

@app.route('/api/auth/register', methods=['POST'])
def register():
    d    = request.get_json() or {}
    name = (d.get('name') or '').strip()
    pw   = d.get('password') or ''
    code = d.get('adminCode') or ''

    if not name or not pw:
        return jsonify({'error': 'Name and password required'}), 400
    if len(pw) < 4:
        return jsonify({'error': 'Password must be at least 4 characters'}), 400

    db = get_db()
    if db.execute('SELECT id FROM users WHERE name = ? COLLATE NOCASE', (name,)).fetchone():
        return jsonify({'error': 'That name is already taken'}), 409

    pw_hash = bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()

    if code == 'METAMORPH-ADMIN-2024':
        role, status = 'admin', 'approved'
    else:
        role, status = 'student', 'pending'

    cur = db.execute(
        'INSERT INTO users (name, password_hash, role, status) VALUES (?,?,?,?)',
        (name, pw_hash, role, status)
    )
    db.commit()
    uid = cur.lastrowid

    if role == 'student':
        seed_progress(db, uid)

    # Admin logs straight in; pending students do not get a session
    if status == 'approved':
        session.permanent = True
        session['user_id'] = uid
        return jsonify({'user': get_profile(uid)})
    else:
        return jsonify({'code': 'pending', 'message': 'Registration submitted. Awaiting admin approval.'})

@app.route('/api/auth/login', methods=['POST'])
def login():
    d    = request.get_json() or {}
    name = (d.get('name') or '').strip()
    pw   = d.get('password') or ''

    row = get_db().execute(
        'SELECT id, password_hash, status FROM users WHERE name = ? COLLATE NOCASE', (name,)
    ).fetchone()

    if not row or not bcrypt.checkpw(pw.encode(), row['password_hash'].encode()):
        return jsonify({'error': 'Invalid name or password'}), 401

    if row['status'] == 'pending':
        return jsonify({'code': 'pending', 'error': 'Your account is awaiting admin approval'}), 403
    if row['status'] == 'rejected':
        return jsonify({'error': 'Your registration was not approved. Contact the gym.'}), 403

    session.permanent = True
    session['user_id'] = row['id']
    return jsonify({'user': get_profile(row['id'])})

@app.route('/api/auth/logout', methods=['POST'])
def logout():
    session.clear()
    return jsonify({'ok': True})

@app.route('/api/auth/me')
@require_auth
def get_me():
    p = get_profile(session['user_id'])
    return (jsonify(p) if p else (jsonify({'error': 'Not found'}), 404))

# ── Students (public roster — approved only) ──────────────────────────────────

@app.route('/api/users')
def list_users():
    # Signature weapon per discipline: the single weapon with the highest
    # assignment count. Returns NULL when two weapons tie for the top.
    rows = get_db().execute('''
        SELECT u.id, u.name, u.role, u.profile_pic,
               u.height_cm, u.weight_kg,
               u.bjj_active, u.mt_active, u.boxing_active,
               COALESCE(b.belt,'white') AS belt, COALESCE(b.stripes,0) AS stripes,
               COALESCE(m.level,1) AS mt_level,
               COALESCE(bx.level,1) AS boxing_level,
               (SELECT GROUP_CONCAT(media_url,'||') FROM (
                   SELECT media_url FROM student_media
                   WHERE subject_id=u.id ORDER BY uploaded_at DESC LIMIT 4
               )) AS media_urls,
               (SELECT CASE WHEN COUNT(*)=1 THEN MAX(weapon) ELSE NULL END FROM (
                    SELECT weapon FROM weapon_assignments WHERE to_user=u.id AND discipline='bjj'
                    GROUP BY weapon HAVING COUNT(*)=(
                        SELECT MAX(c) FROM (SELECT COUNT(*) c FROM weapon_assignments
                            WHERE to_user=u.id AND discipline='bjj' GROUP BY weapon)
                    ))) AS bjj_sig,
               (SELECT CASE WHEN COUNT(*)=1 THEN MAX(weapon) ELSE NULL END FROM (
                    SELECT weapon FROM weapon_assignments WHERE to_user=u.id AND discipline='mt'
                    GROUP BY weapon HAVING COUNT(*)=(
                        SELECT MAX(c) FROM (SELECT COUNT(*) c FROM weapon_assignments
                            WHERE to_user=u.id AND discipline='mt' GROUP BY weapon)
                    ))) AS mt_sig,
               (SELECT CASE WHEN COUNT(*)=1 THEN MAX(weapon) ELSE NULL END FROM (
                    SELECT weapon FROM weapon_assignments WHERE to_user=u.id AND discipline='boxing'
                    GROUP BY weapon HAVING COUNT(*)=(
                        SELECT MAX(c) FROM (SELECT COUNT(*) c FROM weapon_assignments
                            WHERE to_user=u.id AND discipline='boxing' GROUP BY weapon)
                    ))) AS boxing_sig
        FROM users u
        LEFT JOIN bjj_progress    b  ON u.id = b.user_id
        LEFT JOIN mt_progress     m  ON u.id = m.user_id
        LEFT JOIN boxing_progress bx ON u.id = bx.user_id
        WHERE u.role = 'student' AND u.status = 'approved'
        ORDER BY (u.profile_pic IS NULL), u.name
    ''').fetchall()
    return jsonify([dict(r) for r in rows])

@app.route('/api/users/<int:uid>')
def get_user(uid):
    p = get_profile(uid)
    # Don't expose admin profiles
    if not p or p.get('role') == 'admin':
        return jsonify({'error': 'Not found'}), 404
    return jsonify(p)

@app.route('/api/users/<int:uid>/profile', methods=['PUT'])
@require_auth
def update_profile(uid):
    if session['user_id'] != uid:
        return jsonify({'error': "Cannot edit another user's profile"}), 403
    d    = request.get_json() or {}
    name = (d.get('name') or '').strip()
    if not name:
        return jsonify({'error': 'Name required'}), 400
    db = get_db()
    if db.execute('SELECT id FROM users WHERE name = ? COLLATE NOCASE AND id != ?', (name, uid)).fetchone():
        return jsonify({'error': 'That name is already taken'}), 409
    db.execute('UPDATE users SET name=?, height_cm=?, weight_kg=? WHERE id=?',
               (name, d.get('height_cm'), d.get('weight_kg'), uid))
    db.commit()
    return jsonify(get_profile(uid))

@app.route('/api/users/<int:uid>/avatar/url', methods=['POST'])
@require_auth
def save_avatar_url(uid):
    """Store avatar URL after browser has uploaded directly to Cloudinary."""
    if session['user_id'] != uid:
        return jsonify({'error': "Cannot edit another user's profile"}), 403
    d   = request.get_json() or {}
    url = (d.get('url') or '').strip()
    if not url.startswith('https://'):
        return jsonify({'error': 'Invalid URL'}), 400
    db = get_db()
    db.execute('UPDATE users SET profile_pic=? WHERE id=?', (url, uid))
    db.commit()
    return jsonify({'profile_pic': url})

@app.route('/api/users/<int:uid>/avatar', methods=['POST'])
@require_auth
def upload_avatar(uid):
    if session['user_id'] != uid:
        return jsonify({'error': "Cannot edit another user's profile"}), 403
    d = request.get_json() or {}
    img_data = d.get('data', '')
    if not img_data.startswith('data:image/'):
        return jsonify({'error': 'Invalid image data'}), 400
    try:
        result = cloudinary.uploader.upload(
            img_data,
            folder       = 'metamorph/avatars',
            public_id    = f'user_{uid}',
            overwrite    = True,
            transformation = [{'width': 400, 'height': 400, 'crop': 'fill', 'gravity': 'face'}]
        )
        url = result['secure_url']
    except Exception as e:
        return jsonify({'error': f'Upload failed: {str(e)}'}), 500
    db = get_db()
    db.execute('UPDATE users SET profile_pic=? WHERE id=?', (url, uid))
    db.commit()
    return jsonify({'profile_pic': url})

# ── Student media (action photos / videos) ───────────────────────────────────

@app.route('/api/users/<int:uid>/media', methods=['GET'])
def get_media(uid):
    rows = get_db().execute(
        '''SELECT m.id, m.media_url, m.media_type, m.public_id,
                  m.uploaded_at, u.name AS uploader_name
           FROM student_media m
           JOIN users u ON u.id = m.uploader_id
           WHERE m.subject_id = ?
           ORDER BY m.uploaded_at DESC''',
        (uid,)
    ).fetchall()
    return jsonify([dict(r) for r in rows])

@app.route('/api/users/<int:uid>/media/save', methods=['POST'])
@require_auth
def save_media(uid):
    """Store a media URL after the browser has uploaded directly to Cloudinary."""
    d          = request.get_json() or {}
    url        = (d.get('url')       or '').strip()
    public_id  = (d.get('public_id') or '').strip()
    media_type = d.get('media_type', 'image')
    if not url or not public_id:
        return jsonify({'error': 'Missing url or public_id'}), 400
    if media_type not in ('image', 'video'):
        media_type = 'image'
    db = get_db()
    db.execute(
        'INSERT INTO student_media (uploader_id, subject_id, media_url, media_type, public_id) VALUES (?,?,?,?,?)',
        (session['user_id'], uid, url, media_type, public_id)
    )
    db.commit()
    return jsonify({'ok': True})

@app.route('/api/users/<int:uid>/media', methods=['POST'])
@require_auth
def upload_media(uid):
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400
    file = request.files['file']
    mime = file.content_type or ''
    if mime.startswith('video/'):
        resource_type = 'video'
    elif mime.startswith('image/'):
        resource_type = 'image'
    else:
        return jsonify({'error': 'Only images and videos are allowed'}), 400
    try:
        opts = {'folder': 'metamorph/media', 'resource_type': resource_type}
        if resource_type == 'video':
            opts['eager'] = [{'duration': 10}]   # trim to 10 s max
        result = cloudinary.uploader.upload(file, **opts)
    except Exception as e:
        return jsonify({'error': f'Upload failed: {str(e)}'}), 500
    db = get_db()
    db.execute(
        'INSERT INTO student_media (uploader_id, subject_id, media_url, media_type, public_id) VALUES (?,?,?,?,?)',
        (session['user_id'], uid, result['secure_url'], resource_type, result['public_id'])
    )
    db.commit()
    return jsonify({'url': result['secure_url'], 'type': resource_type})

@app.route('/api/media/<int:mid>', methods=['DELETE'])
@require_auth
def delete_media(mid):
    db  = get_db()
    row = db.execute('SELECT * FROM student_media WHERE id=?', (mid,)).fetchone()
    if not row:
        return jsonify({'error': 'Not found'}), 404
    u = db.execute('SELECT role FROM users WHERE id=?', (session['user_id'],)).fetchone()
    is_uploader = row['uploader_id'] == session['user_id']
    is_subject  = row['subject_id']  == session['user_id']
    is_admin    = u and u['role'] == 'admin'
    if not (is_uploader or is_subject or is_admin):
        return jsonify({'error': 'Not allowed'}), 403
    try:
        cloudinary.uploader.destroy(row['public_id'], resource_type=row['media_type'])
    except Exception:
        pass
    db.execute('DELETE FROM student_media WHERE id=?', (mid,))
    db.commit()
    return jsonify({'ok': True})

@app.route('/api/users/<int:uid>/competition', methods=['PUT'])
@require_auth
def update_competition(uid):
    if session['user_id'] != uid:
        return jsonify({'error': "Cannot edit another user's records"}), 403
    d  = request.get_json() or {}
    db = get_db()
    for art in ('bjj', 'mt', 'boxing'):
        rec = d.get(art)
        if rec:
            db.execute('''
                INSERT INTO competition_records (user_id, martial_art, wins, draws, losses)
                VALUES (?,?,?,?,?)
                ON CONFLICT(user_id, martial_art) DO UPDATE SET
                    wins=excluded.wins, draws=excluded.draws, losses=excluded.losses
            ''', (uid, art, int(rec.get('wins',0)), int(rec.get('draws',0)), int(rec.get('losses',0))))
    db.commit()
    return jsonify(get_profile(uid))

@app.route('/api/users/<int:uid>/password', methods=['PUT'])
@require_auth
def update_password(uid):
    if session['user_id'] != uid:
        return jsonify({'error': "Cannot change another user's password"}), 403
    d        = request.get_json() or {}
    password = (d.get('password') or '').strip()
    if not password:
        return jsonify({'error': 'Password required'}), 400
    if len(password) < 4:
        return jsonify({'error': 'Password must be at least 4 characters'}), 400
    if not password.isalnum():
        return jsonify({'error': 'Password must contain letters and numbers only'}), 400
    pw_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    db = get_db()
    db.execute('UPDATE users SET password_hash=? WHERE id=?', (pw_hash, uid))
    db.commit()
    return jsonify({'ok': True})

@app.route('/api/users/<int:uid>/disciplines', methods=['PUT'])
@require_auth
def update_disciplines(uid):
    if session['user_id'] != uid:
        return jsonify({'error': "Cannot edit another user's profile"}), 403
    d          = request.get_json() or {}
    bjj_active    = 1 if d.get('bjj_active',    True) else 0
    mt_active     = 1 if d.get('mt_active',     True) else 0
    boxing_active = 1 if d.get('boxing_active', True) else 0
    db = get_db()
    db.execute('UPDATE users SET bjj_active=?, mt_active=?, boxing_active=? WHERE id=?',
               (bjj_active, mt_active, boxing_active, uid))
    db.commit()
    return jsonify(get_profile(uid))

# ── Weapons ───────────────────────────────────────────────────────────────────

@app.route('/api/users/<int:uid>/weapons/mine', methods=['GET'])
@require_auth
def get_my_weapons_for(uid):
    """Return the weapons the current user has previously assigned to uid."""
    db = get_db()
    rows = db.execute(
        'SELECT discipline, weapon FROM weapon_assignments WHERE from_user=? AND to_user=? ORDER BY discipline, weapon',
        (session['user_id'], uid)
    ).fetchall()
    result = {'bjj': [], 'mt': [], 'boxing': []}
    for r in rows:
        if r['discipline'] in result:
            result[r['discipline']].append(r['weapon'])
    return jsonify(result)

@app.route('/api/users/<int:uid>/weapons', methods=['POST'])
@require_auth
def assign_weapons(uid):
    """Replace the current user's weapon assignments to uid (max 3 per discipline)."""
    if session['user_id'] == uid:
        return jsonify({'error': 'Cannot assign weapons to yourself'}), 400
    d         = request.get_json() or {}
    from_user = session['user_id']
    db        = get_db()
    db.execute('DELETE FROM weapon_assignments WHERE from_user=? AND to_user=?', (from_user, uid))
    for disc in ('bjj', 'mt', 'boxing'):
        for weapon in (d.get(disc) or [])[:3]:
            if weapon and isinstance(weapon, str):
                db.execute(
                    'INSERT OR IGNORE INTO weapon_assignments (from_user, to_user, discipline, weapon) VALUES (?,?,?,?)',
                    (from_user, uid, disc, str(weapon)[:120])
                )
    db.commit()
    return jsonify({'ok': True})

# ── Admin — progress assignment ───────────────────────────────────────────────

@app.route('/api/users/<int:uid>/bjj', methods=['PUT'])
@require_admin
def assign_bjj(uid):
    d       = request.get_json() or {}
    belt    = d.get('belt')
    stripes = int(d.get('stripes', 0))
    if belt not in ('white','blue','purple','brown','black'):
        return jsonify({'error': 'Invalid belt'}), 400
    if not 0 <= stripes <= 4:
        return jsonify({'error': 'Stripes must be 0-4'}), 400
    db = get_db()
    db.execute('''
        INSERT INTO bjj_progress (user_id, belt, stripes, assigned_by, assigned_at)
        VALUES (?,?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET
            belt=excluded.belt, stripes=excluded.stripes,
            assigned_by=excluded.assigned_by, assigned_at=excluded.assigned_at
    ''', (uid, belt, stripes, session['user_id']))
    db.commit()
    return jsonify(get_profile(uid))

@app.route('/api/users/<int:uid>/mt', methods=['PUT'])
@require_admin
def assign_mt(uid):
    d     = request.get_json() or {}
    level = round(float(d.get('level', 1)) * 2) / 2   # round to nearest 0.5
    if not 0.5 <= level <= 5:
        return jsonify({'error': 'Level must be 0.5-5'}), 400
    db = get_db()
    db.execute('''
        INSERT INTO mt_progress (user_id, level, assigned_by, assigned_at)
        VALUES (?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET
            level=excluded.level, assigned_by=excluded.assigned_by, assigned_at=excluded.assigned_at
    ''', (uid, level, session['user_id']))
    db.commit()
    return jsonify(get_profile(uid))

@app.route('/api/users/<int:uid>/boxing', methods=['PUT'])
@require_admin
def assign_boxing(uid):
    d     = request.get_json() or {}
    level = round(float(d.get('level', 1)) * 2) / 2   # round to nearest 0.5
    if not 0.5 <= level <= 5:
        return jsonify({'error': 'Level must be 0.5-5'}), 400
    db = get_db()
    db.execute('''
        INSERT INTO boxing_progress (user_id, level, assigned_by, assigned_at)
        VALUES (?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET
            level=excluded.level, assigned_by=excluded.assigned_by, assigned_at=excluded.assigned_at
    ''', (uid, level, session['user_id']))
    db.commit()
    return jsonify(get_profile(uid))

# ── Admin — user management ───────────────────────────────────────────────────

@app.route('/api/admin/users/<int:uid>/edit', methods=['PUT'])
@require_admin
def admin_edit_user(uid):
    """Admin: edit any aspect of a student's profile."""
    d        = request.get_json() or {}
    name     = (d.get('name') or '').strip()
    password = (d.get('password') or '')
    db = get_db()
    if name:
        clash = db.execute(
            'SELECT id FROM users WHERE name=? COLLATE NOCASE AND id!=?', (name, uid)
        ).fetchone()
        if clash:
            return jsonify({'error': 'That name is already taken'}), 409
        db.execute('UPDATE users SET name=? WHERE id=?', (name, uid))
    if password:
        if len(password) < 4:
            return jsonify({'error': 'Password must be at least 4 characters'}), 400
        pw_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
        db.execute('UPDATE users SET password_hash=? WHERE id=?', (pw_hash, uid))
    if 'height_cm' in d:
        db.execute('UPDATE users SET height_cm=? WHERE id=?', (d['height_cm'], uid))
    if 'weight_kg' in d:
        db.execute('UPDATE users SET weight_kg=? WHERE id=?', (d['weight_kg'], uid))
    if 'mt_active' in d:
        db.execute('UPDATE users SET mt_active=? WHERE id=?', (int(d['mt_active']), uid))
    if 'boxing_active' in d:
        db.execute('UPDATE users SET boxing_active=? WHERE id=?', (int(d['boxing_active']), uid))
    if 'bjj_active' in d:
        db.execute('UPDATE users SET bjj_active=? WHERE id=?', (int(d['bjj_active']), uid))
    db.commit()
    p = get_profile(uid)
    return jsonify(p) if p else (jsonify({'error': 'User not found'}), 404)

# ── Admin — registration management ──────────────────────────────────────────

@app.route('/api/admin/pending')
@require_admin
def list_pending():
    rows = get_db().execute(
        "SELECT id, name, profile_pic, created_at FROM users WHERE status='pending' ORDER BY created_at"
    ).fetchall()
    return jsonify([dict(r) for r in rows])

@app.route('/api/admin/users/<int:uid>/approve', methods=['POST'])
@require_admin
def approve_user(uid):
    db = get_db()
    db.execute("UPDATE users SET status='approved' WHERE id=? AND role='student'", (uid,))
    db.commit()
    return jsonify({'ok': True})

@app.route('/api/admin/users/<int:uid>', methods=['DELETE'])
@require_admin
def delete_user(uid):
    db = get_db()
    for tbl in ('bjj_progress', 'mt_progress', 'competition_records'):
        db.execute(f'DELETE FROM {tbl} WHERE user_id=?', (uid,))
    db.execute('DELETE FROM users WHERE id=?', (uid,))
    db.commit()
    return jsonify({'ok': True})

# ── Error handlers (always return JSON for /api routes) ───────────────────────

@app.errorhandler(404)
def not_found(e):
    if request.path.startswith('/api/'):
        return jsonify({'error': 'Not found'}), 404
    return send_from_directory('public', 'index.html')

@app.errorhandler(405)
def method_not_allowed(e):
    return jsonify({'error': 'Method not allowed'}), 405

@app.errorhandler(500)
def server_error(e):
    return jsonify({'error': 'Internal server error'}), 500

# ── Serve static / SPA ────────────────────────────────────────────────────────

@app.route('/', defaults={'path': ''})
@app.route('/<path:path>', methods=['GET'])
def catch_all(path):
    if path.startswith('api/'):
        return jsonify({'error': 'Not found'}), 404
    return send_from_directory('public', 'index.html')

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 3000))
    print(f'\n  METAMORPH running at http://localhost:{port}\n')
    app.run(host='0.0.0.0', port=port, debug=False)
