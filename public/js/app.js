/* ── State ── */
let me             = null;   // logged-in user
let viewingId      = null;   // profile currently being viewed
let prevView       = null;
let coachTargetId  = null;
let pendingBelt         = null;
let pendingStripes      = null;
let pendingLevel        = null;
let pendingBoxingLevel  = null;
let pendingAvatarFile   = null;
let weaponsTargetId     = null;
let selectedWeapons     = { bjj: [], mt: [], boxing: [] };
let adminEditTargetId   = null;

/* ── Weapon lists (20 per discipline) ── */
const WEAPONS = {
  bjj: [
    'Single Leg',     'Double Leg',      'Osoto Gari',     'Sweep from Guard',
    'Rear Naked Choke','Triangle',        'Kimura',         'Armbar',
    'Guillotine',     'Omoplata',        "D'Arce Choke",   'Heel Hook',
    'Bow & Arrow',    'Ezekiel Choke',   'Half Guard Sweep','Berimbolo',
    'X-Guard',        'Back Take',       'Hip Bump Sweep', 'Ankle Lock'
  ],
  mt: [
    'Jab',            'Cross',           'Hook',           'Feints',
    'Push Kick',      'Low Kick',        'Middle Kick',    'High Kick',
    'Clinch',         'Knee Strike',     'Elbow Strike',   'Switch Kick',
    'Spinning Back Kick','Diagonal Kick','Roundhouse',     'Body Kick',
    'Rear Teep',      'Overhand',        'Uppercut',       'Counter Right'
  ],
  boxing: [
    'Footwork',       'Jab',             'Cross',          'Hook',
    'Uppercut',       'Body Shot',       'Liver Shot',     'Slips',
    'Weaves',         'Cutting Angles',  'Overhand',       'Check Hook',
    'Double Jab',     'Body Jab',        'Philly Shell',   'Peek-a-boo',
    'Shoulder Roll',  'Counter Punching','Jab Step',       'Pivot'
  ]
};

/* ── Boot ── */
async function init() {
  try {
    const data = await api('GET', '/api/auth/me');
    me = data;
    showApp();
    if (me.role === 'admin') showPendingApprovals();
    else showRoster();
  } catch {
    showView('auth', false);
  }
}

function showApp() {
  document.getElementById('app-header').hidden = false;
  document.getElementById('bottom-nav').hidden = false;
  renderHeaderAvatar();

  const isAdmin = me && me.role === 'admin';
  document.getElementById('nav-profile').hidden  = isAdmin;
  document.getElementById('nav-pending').hidden  = !isAdmin;

  if (isAdmin) refreshPendingBadge();
}

/* ── API ── */
async function api(method, path, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body && !(body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (body) {
    opts.body = body;
  }
  const res  = await fetch(path, opts);
  const json = await res.json();
  if (!res.ok) {
    const err = new Error(json.error || 'Request failed');
    err.code  = json.code;
    throw err;
  }
  return json;
}

/* ── Views ── */
function showView(name, trackPrev = true) {
  if (trackPrev) prevView = currentView();
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`${name}-view`).classList.add('active');

  const backBtn  = document.getElementById('back-btn');
  backBtn.hidden = !(name === 'profile' || name === 'edit');

  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  if (name === 'roster')  document.getElementById('nav-home')?.classList.add('active');
  if (name === 'admin')   document.getElementById('nav-pending')?.classList.add('active');
  if (name === 'profile' && viewingId === me?.id) document.getElementById('nav-profile')?.classList.add('active');
}

function currentView() {
  const a = document.querySelector('.view.active');
  return a ? a.id.replace('-view', '') : null;
}

function goBack() {
  const cv = currentView();
  if (cv === 'edit')    { showProfile(viewingId, false); return; }
  if (cv === 'profile') { showRoster(); return; }
  showRoster();
}

/* ── Auth ── */
function switchTab(tab) {
  document.getElementById('login-form').hidden    = tab !== 'login';
  document.getElementById('register-form').hidden = tab !== 'register';
  document.getElementById('tab-login').classList.toggle('active',    tab === 'login');
  document.getElementById('tab-register').classList.toggle('active', tab === 'register');
}

async function handleLogin(e) {
  e.preventDefault();
  const name     = document.getElementById('login-name').value;
  const password = document.getElementById('login-password').value;
  try {
    const data = await api('POST', '/api/auth/login', { name, password });
    me = data.user;
    showApp();
    if (me.role === 'admin') showPendingApprovals();
    else showRoster();
  } catch (err) {
    if (err.code === 'pending') {
      showView('pending', false);
      document.getElementById('app-header').hidden = false;
      document.getElementById('bottom-nav').hidden = true;
    } else {
      toast(err.message, 'error');
    }
  }
}

async function handleRegister(e) {
  e.preventDefault();
  const name      = document.getElementById('reg-name').value;
  const password  = document.getElementById('reg-password').value;
  const adminCode = document.getElementById('reg-admin-code').value;
  try {
    const data = await api('POST', '/api/auth/register', { name, password, adminCode });
    if (data.code === 'pending') {
      // Show pending screen — student not yet logged in
      showView('pending', false);
      document.getElementById('app-header').hidden = false;
      document.getElementById('bottom-nav').hidden = true;
      toast('Registration submitted!');
    } else {
      // Admin registered and auto-logged in
      me = data.user;
      showApp();
      showPendingApprovals();
      toast(`Welcome, ${me.name}!`);
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function handleLogout() {
  await api('POST', '/api/auth/logout');
  me = null;
  document.getElementById('app-header').hidden = true;
  document.getElementById('bottom-nav').hidden = true;
  showView('auth', false);
}

/* ── Roster ── */
async function showRoster() {
  showView('roster', false);
  if (me?.role === 'admin') refreshPendingBadge();
  const grid = document.getElementById('roster-grid');
  grid.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try {
    const users = await api('GET', '/api/users');
    if (!users.length) {
      grid.innerHTML = '<div class="empty-state"><p>No approved athletes yet.</p></div>';
      return;
    }
    grid.innerHTML = users.map(renderRosterCard).join('');
  } catch {
    grid.innerHTML = '<div class="empty-state"><p>Could not load athletes.</p></div>';
  }
}

function renderRosterCard(u) {
  const belt         = u.belt || 'white';
  const stripes      = u.stripes || 0;
  const mtLevel      = u.mt_level      || 1;
  const boxingLevel  = u.boxing_level  || 1;
  const bjjActive    = u.bjj_active    !== 0;
  const mtActive     = u.mt_active     !== 0;
  const boxingActive = u.boxing_active !== 0;

  const stripesHtml = Array(stripes).fill('<span class="belt-stripe"></span>').join('');

  // Stars: filled ★ (yellow) for earned levels, outline ☆ (dim) for remaining
  const starsHtml = lvl => [1,2,3,4,5].map(i =>
    `<span class="lvl-star ${i <= lvl ? 'on' : 'off'}">${i <= lvl ? '★' : '☆'}</span>`
  ).join('');

  const photoStyle   = u.profile_pic ? 'background:none' : `background:${avatarColor(u)};color:#fff`;
  const photoContent = u.profile_pic
    ? `<img src="${u.profile_pic}" alt="${esc(u.name)}">`
    : `<span>${initials(u.name)}</span>`;

  // Row order: Muay Thai → Boxing → Jiu-Jitsu (no inline sig weapon)
  const mtBadge = mtActive
    ? `<div class="mt-badge"><div class="mt-label-wrap"><span class="mt-label">🥊 Muay Thai</span></div><div class="mt-dots">${starsHtml(mtLevel)}</div></div>`
    : '';
  const boxingBadge = boxingActive
    ? `<div class="mt-badge"><div class="mt-label-wrap"><span class="mt-label">🥊 Boxing</span></div><div class="mt-dots">${starsHtml(boxingLevel)}</div></div>`
    : '';
  const bjjBadge = bjjActive
    ? `<div class="mt-badge"><div class="mt-label-wrap"><span class="mt-label">🥋 Jiu-Jitsu</span></div><span class="belt-badge ${belt}">${belt.toUpperCase()}<span class="belt-stripes">${stripesHtml}</span></span></div>`
    : '';

  const badgesHtml = (mtBadge || boxingBadge || bjjBadge)
    ? `<div class="card-badges">${mtBadge}${boxingBadge}${bjjBadge}</div>`
    : '';

  // Watch Out For — always shown; sig weapons if a clear winner exists, else placeholder
  const sigWeapons = [u.mt_sig, u.boxing_sig, u.bjj_sig].filter(Boolean);
  const watchoutText = sigWeapons.length ? sigWeapons.map(esc).join(' · ') : "I'm still a WIP...";
  const watchoutHtml = `<div class="card-watchout">
      <span class="card-watchout-label">Watch Out For</span>
      <span class="card-watchout-weapons${sigWeapons.length ? '' : ' card-watchout-placeholder'}">${watchoutText}</span>
     </div>`;

  const statParts = [u.height_cm ? `${u.height_cm} cm` : '', u.weight_kg ? `${u.weight_kg} kg` : ''].filter(Boolean);
  const statsLine = statParts.length ? `<div class="card-stats">${statParts.join(' · ')}</div>` : '';

  return `
    <div class="student-card" onclick="showProfile(${u.id})">
      <div class="card-photo" style="${photoStyle}">${photoContent}</div>
      <div class="card-overlay">
        <div class="card-name">${esc(u.name)}</div>
        ${statsLine}
        ${badgesHtml}
        ${watchoutHtml}
      </div>
    </div>`;
}

/* ── Profile ── */
async function showProfile(userId, track = true) {
  viewingId = userId;
  showView('profile', track);
  document.getElementById('profile-content').innerHTML =
    '<div class="loading"><div class="spinner"></div></div>';
  try {
    const user = await api('GET', `/api/users/${userId}`);
    renderProfile(user);
  } catch {
    document.getElementById('profile-content').innerHTML =
      '<div class="empty-state"><p>Could not load profile.</p></div>';
  }
}

function renderProfile(user) {
  const isAdmin          = me && me.role === 'admin';
  const isOwn            = me && !isAdmin && me.id === user.id;
  const canAssign        = isAdmin;
  const canAssignWeapons = !!me && !isOwn;
  const bjjActive    = user.bjj_active    !== 0;
  const mtActive     = user.mt_active     !== 0;
  const boxingActive = user.boxing_active !== 0;

  const belt        = user.bjj?.belt     || 'white';
  const stripes     = user.bjj?.stripes  || 0;
  const mtLevel     = user.mt?.level     || 1;
  const boxingLevel = user.boxing?.level || 1;
  const stripesHtml    = Array(stripes).fill('<span class="belt-stripe"></span>').join('');
  const mtDotsHtml     = [1,2,3,4,5].map(i => `<span class="mt-dot ${i<=mtLevel    ?'on':''}"></span>`).join('');
  const boxingDotsHtml = [1,2,3,4,5].map(i => `<span class="mt-dot ${i<=boxingLevel?'on':''}"></span>`).join('');
  const bjjComp    = user.competition?.bjj    || {};
  const mtComp     = user.competition?.mt     || {};
  const boxingComp = user.competition?.boxing || {};
  const hStr = user.height_cm ? `${user.height_cm} cm` : '—';
  const wStr = user.weight_kg ? `${user.weight_kg} kg` : '—';

  const bjjSection = bjjActive ? `
      <div class="profile-section">
        <div class="profile-section-title">🥋 Brazilian Jiu-Jitsu</div>
        <div class="progress-row">
          <span class="progress-label">Belt &amp; Rank</span>
          <span class="belt-badge ${belt}">${belt.toUpperCase()} <span class="belt-stripes">${stripesHtml}</span></span>
        </div>
        <div class="divider"></div>
        <div class="profile-section-title">Competition</div>
        <div class="comp-row">
          <div class="comp-stat comp-win"><div class="comp-value">${bjjComp.wins??0}</div><div class="comp-label">Wins</div></div>
          <div class="comp-stat comp-draw"><div class="comp-value">${bjjComp.draws??0}</div><div class="comp-label">Draws</div></div>
          <div class="comp-stat comp-loss"><div class="comp-value">${bjjComp.losses??0}</div><div class="comp-label">Losses</div></div>
        </div>
      </div>` : '';

  const mtSection = mtActive ? `
      <div class="profile-section">
        <div class="profile-section-title">🥊 Muay Thai</div>
        <div class="progress-row">
          <span class="progress-label">Level</span>
          <div class="mt-badge"><span class="mt-label">LVL ${mtLevel}</span><div class="mt-dots">${mtDotsHtml}</div></div>
        </div>
        <div class="divider"></div>
        <div class="profile-section-title">Competition</div>
        <div class="comp-row">
          <div class="comp-stat comp-win"><div class="comp-value">${mtComp.wins??0}</div><div class="comp-label">Wins</div></div>
          <div class="comp-stat comp-draw"><div class="comp-value">${mtComp.draws??0}</div><div class="comp-label">Draws</div></div>
          <div class="comp-stat comp-loss"><div class="comp-value">${mtComp.losses??0}</div><div class="comp-label">Losses</div></div>
        </div>
      </div>` : '';

  const boxingSection = boxingActive ? `
      <div class="profile-section">
        <div class="profile-section-title">🥊 Boxing</div>
        <div class="progress-row">
          <span class="progress-label">Level</span>
          <div class="mt-badge"><span class="mt-label">LVL ${boxingLevel}</span><div class="mt-dots">${boxingDotsHtml}</div></div>
        </div>
        <div class="divider"></div>
        <div class="profile-section-title">Competition</div>
        <div class="comp-row">
          <div class="comp-stat comp-win"><div class="comp-value">${boxingComp.wins??0}</div><div class="comp-label">Wins</div></div>
          <div class="comp-stat comp-draw"><div class="comp-value">${boxingComp.draws??0}</div><div class="comp-label">Draws</div></div>
          <div class="comp-stat comp-loss"><div class="comp-value">${boxingComp.losses??0}</div><div class="comp-label">Losses</div></div>
        </div>
      </div>` : '';

  // ── All weapons received (full list) ──
  const w = user.weapons || {};
  const wBjj = w.bjj || [], wMt = w.mt || [], wBox = w.boxing || [];
  const weaponChips = arr => arr.map(x => `<span class="weapon-tag">${esc(x)}</span>`).join('');
  const wGrp = (lbl, arr) => arr.length
    ? `<div class="weapons-group"><div class="weapons-group-label">${lbl}</div><div class="weapons-chips">${weaponChips(arr)}</div></div>`
    : '';
  const weaponsSection = (wBjj.length || wMt.length || wBox.length)
    ? `<div class="profile-section">
        <div class="profile-section-title">⚔ Weapons</div>
        ${wGrp('🥊 Muay Thai', wMt)}
        ${wGrp('🥊 Boxing',    wBox)}
        ${wGrp('🥋 Jiu-Jitsu', wBjj)}
      </div>`
    : '';

  document.getElementById('profile-content').innerHTML = `
    <div class="profile-wrap">
      <div class="profile-hero">
        <div class="avatar avatar-lg" style="${avatarStyle(user)}">${avatarContent(user)}</div>
        <div style="display:flex;flex-direction:column;align-items:center;gap:8px">
          <div class="profile-name">${esc(user.name)}</div>
          <div class="profile-stats">
            <div class="stat-item"><div class="stat-value">${hStr}</div><div class="stat-label">Height</div></div>
            <div class="stat-item"><div class="stat-value">${wStr}</div><div class="stat-label">Weight</div></div>
          </div>
        </div>
      </div>
      ${bjjSection}
      ${mtSection}
      ${boxingSection}
      ${weaponsSection}
      <div class="profile-section" id="media-section">
        <div class="profile-section-title" style="display:flex;align-items:center;justify-content:space-between">
          <span>📸 In Action</span>
          ${!isOwn && me ? `<button class="btn-upload-media" onclick="triggerMediaUpload(${user.id})">+ Add</button>` : ''}
        </div>
        <div class="media-gallery" id="media-gallery-${user.id}">
          <div class="loading"><div class="spinner"></div></div>
        </div>
      </div>
      <div class="profile-actions">
        ${isOwn            ? '<button class="btn btn-ghost btn-full" onclick="showEditProfile()">Edit My Profile</button>' : ''}
        ${canAssignWeapons ? `<button class="btn btn-ghost btn-full" onclick="openWeaponsModal(${user.id},'${esc(user.name)}',${user.mt_active?1:0},${user.boxing_active?1:0},${user.bjj_active?1:0})">⚔ Assign Weapons</button>` : ''}
        ${canAssign        ? `<button class="btn btn-primary btn-full" onclick="openAssignModal(${user.id},'${esc(user.name)}')">Assign Progress</button>` : ''}
        ${isAdmin          ? `<button class="btn btn-ghost btn-full" onclick="openAdminEditModal(${user.id},'${esc(user.name)}')">Edit Name / Password</button>` : ''}
      </div>
    </div>`;
  loadMediaGallery(user.id);
}

function showMyProfile() {
  if (me && me.role !== 'admin') showProfile(me.id);
}

/* ── Edit profile ── */
async function showEditProfile() {
  showView('edit');
  try {
    const user = await api('GET', `/api/users/${me.id}`);
    document.getElementById('edit-name').value    = user.name;
    document.getElementById('edit-height').value  = user.height_cm || '';
    document.getElementById('edit-weight').value  = user.weight_kg || '';
    document.getElementById('bjj-wins').value     = user.competition?.bjj?.wins   ?? 0;
    document.getElementById('bjj-draws').value    = user.competition?.bjj?.draws  ?? 0;
    document.getElementById('bjj-losses').value   = user.competition?.bjj?.losses ?? 0;
    document.getElementById('mt-wins').value      = user.competition?.mt?.wins    ?? 0;
    document.getElementById('mt-draws').value     = user.competition?.mt?.draws   ?? 0;
    document.getElementById('mt-losses').value    = user.competition?.mt?.losses  ?? 0;
    const el = document.getElementById('edit-avatar-display');
    el.className    = 'avatar avatar-xl';
    el.style.cssText = avatarStyle(user);
    el.innerHTML    = avatarContent(user);
    pendingAvatarFile = null;
    document.getElementById('edit-new-password').value     = '';
    document.getElementById('edit-confirm-password').value = '';

    // Discipline toggles
    const bjjOn    = user.bjj_active    !== 0;
    const mtOn     = user.mt_active     !== 0;
    const boxingOn = user.boxing_active !== 0;
    document.getElementById('toggle-bjj').checked    = bjjOn;
    document.getElementById('toggle-mt').checked     = mtOn;
    document.getElementById('toggle-boxing').checked = boxingOn;
    toggleDisciplineSection('bjj',    bjjOn);
    toggleDisciplineSection('mt',     mtOn);
    toggleDisciplineSection('boxing', boxingOn);

    // Boxing competition fields
    document.getElementById('boxing-wins').value   = user.competition?.boxing?.wins   ?? 0;
    document.getElementById('boxing-draws').value  = user.competition?.boxing?.draws  ?? 0;
    document.getElementById('boxing-losses').value = user.competition?.boxing?.losses ?? 0;
  } catch (err) { toast(err.message, 'error'); }
}

/* Show/hide competition record blocks when discipline is toggled */
function toggleDisciplineSection(disc, active) {
  const el = document.getElementById(`${disc}-comp-section`);
  if (el) el.hidden = !active;
}

/* Resize + square-crop an image to a compact base64 JPEG for storage */
function resizeImage(file, size = 260, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = ev => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d');
        // Centre-crop to square
        const dim = Math.min(img.width, img.height);
        const sx  = (img.width  - dim) / 2;
        const sy  = (img.height - dim) / 2;
        ctx.drawImage(img, sx, sy, dim, dim, 0, 0, size, size);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function previewAvatar(e) {
  const file = e.target.files[0];
  if (!file) return;
  pendingAvatarFile = file;
  const reader = new FileReader();
  reader.onload = ev => {
    const el = document.getElementById('edit-avatar-display');
    el.style.cssText = 'background:none;border-color:var(--border2)';
    el.innerHTML = `<img src="${ev.target.result}" alt="preview">`;
  };
  reader.readAsDataURL(file);
}

async function handleSaveProfile(e) {
  e.preventDefault();

  // Validate password before locking the button
  const newPw  = document.getElementById('edit-new-password').value;
  const confPw = document.getElementById('edit-confirm-password').value;
  if (newPw) {
    if (!/^[a-zA-Z0-9]{4,}$/.test(newPw)) {
      toast('Password must be at least 4 letters/numbers only', 'error'); return;
    }
    if (newPw !== confPw) {
      toast('Passwords do not match', 'error'); return;
    }
  }

  const btn = e.target.querySelector('[type=submit]');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    if (pendingAvatarFile) {
      const base64 = await resizeImage(pendingAvatarFile);
      const res    = await api('POST', `/api/users/${me.id}/avatar`, { data: base64 });
      me.profile_pic = res.profile_pic;
      renderHeaderAvatar();
      pendingAvatarFile = null;
    }
    const updated = await api('PUT', `/api/users/${me.id}/profile`, {
      name: document.getElementById('edit-name').value,
      height_cm: parseInt(document.getElementById('edit-height').value) || null,
      weight_kg: parseFloat(document.getElementById('edit-weight').value) || null,
    });
    me.name = updated.name;
    await api('PUT', `/api/users/${me.id}/disciplines`, {
      bjj_active:    document.getElementById('toggle-bjj').checked,
      mt_active:     document.getElementById('toggle-mt').checked,
      boxing_active: document.getElementById('toggle-boxing').checked,
    });
    await api('PUT', `/api/users/${me.id}/competition`, {
      bjj:    { wins: +document.getElementById('bjj-wins').value||0,    draws: +document.getElementById('bjj-draws').value||0,    losses: +document.getElementById('bjj-losses').value||0    },
      mt:     { wins: +document.getElementById('mt-wins').value||0,     draws: +document.getElementById('mt-draws').value||0,     losses: +document.getElementById('mt-losses').value||0     },
      boxing: { wins: +document.getElementById('boxing-wins').value||0, draws: +document.getElementById('boxing-draws').value||0, losses: +document.getElementById('boxing-losses').value||0 },
    });
    if (newPw) {
      await api('PUT', `/api/users/${me.id}/password`, { password: newPw });
    }
    toast('Profile saved!');
    showProfile(me.id);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Save Changes';
  }
}

/* ── Admin — pending approvals ── */
async function showPendingApprovals() {
  showView('admin', false);
  const list = document.getElementById('pending-list');
  list.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try {
    const users = await api('GET', '/api/admin/pending');
    updatePendingBadge(users.length);
    if (!users.length) {
      list.innerHTML = '<div class="empty-state"><p>No pending registrations.</p></div>';
      return;
    }
    list.innerHTML = users.map(u => `
      <div class="pending-card" id="pcard-${u.id}">
        <div class="avatar avatar-sm" style="${avatarStyle(u)}">${avatarContent(u)}</div>
        <div class="pending-card-info">
          <div class="pending-card-name">${esc(u.name)}</div>
          <div class="pending-card-sub">Pending registration</div>
        </div>
        <div class="pending-actions">
          <button class="btn btn-ghost btn-sm" onclick="rejectUser(${u.id})">Reject</button>
          <button class="btn btn-primary btn-sm" onclick="approveUser(${u.id})">Approve</button>
        </div>
      </div>`).join('');
  } catch {
    list.innerHTML = '<div class="empty-state"><p>Could not load.</p></div>';
  }
}

async function approveUser(uid) {
  try {
    await api('POST', `/api/admin/users/${uid}/approve`);
    document.getElementById(`pcard-${uid}`)?.remove();
    toast('Student approved');
    await refreshPendingBadge();
    // If list is now empty, show empty state
    const list = document.getElementById('pending-list');
    if (list && !list.querySelector('.pending-card')) {
      list.innerHTML = '<div class="empty-state"><p>No pending registrations.</p></div>';
    }
  } catch (err) { toast(err.message, 'error'); }
}

async function rejectUser(uid) {
  try {
    await api('DELETE', `/api/admin/users/${uid}`);
    document.getElementById(`pcard-${uid}`)?.remove();
    toast('Registration removed');
    await refreshPendingBadge();
    const list = document.getElementById('pending-list');
    if (list && !list.querySelector('.pending-card')) {
      list.innerHTML = '<div class="empty-state"><p>No pending registrations.</p></div>';
    }
  } catch (err) { toast(err.message, 'error'); }
}

async function refreshPendingBadge() {
  try {
    const users = await api('GET', '/api/admin/pending');
    updatePendingBadge(users.length);
  } catch { /* silent */ }
}

function updatePendingBadge(count) {
  const badge = document.getElementById('pending-badge');
  if (!badge) return;
  badge.hidden    = count === 0;
  badge.textContent = count;
}

/* ── Assign modal (admin) ── */
function openAssignModal(userId, name) {
  coachTargetId    = userId;
  pendingBelt      = null;
  pendingStripes   = null;
  pendingLevel     = null;
  pendingBoxingLevel = null;
  document.getElementById('modal-athlete-name').textContent = name;
  document.querySelectorAll('.belt-opt,.stripe-opt,.level-opt').forEach(b => b.classList.remove('selected'));
  api('GET', `/api/users/${userId}`).then(user => {
    selectBelt(user.bjj?.belt || 'white');
    selectStripes(user.bjj?.stripes ?? 0);
    selectLevel(user.mt?.level ?? 1);
    selectBoxingLevel(user.boxing?.level ?? 1);
  });
  document.getElementById('coach-modal').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeCoachModal(e) {
  if (e.target === document.getElementById('coach-modal')) {
    document.getElementById('coach-modal').hidden = true;
    document.body.style.overflow = '';
  }
}

function selectBelt(belt) {
  pendingBelt = belt;
  document.querySelectorAll('.belt-opt').forEach(b => b.classList.toggle('selected', b.dataset.belt === belt));
}

function selectStripes(n) {
  pendingStripes = n;
  document.querySelectorAll('.stripe-opt').forEach(b => b.classList.toggle('selected', +b.dataset.stripes === n));
}

function selectLevel(n) {
  pendingLevel = n;
  document.querySelectorAll('#mt-level-selector .level-opt').forEach(b => b.classList.toggle('selected', +b.dataset.level === n));
}

function selectBoxingLevel(n) {
  pendingBoxingLevel = n;
  document.querySelectorAll('#boxing-level-selector .level-opt').forEach(b => b.classList.toggle('selected', +b.dataset.level === n));
}

async function saveCoachAssignment() {
  if (pendingBelt === null || pendingStripes === null || pendingLevel === null || pendingBoxingLevel === null) {
    toast('Select belt, stripes, MT level and boxing level', 'error'); return;
  }
  try {
    await api('PUT', `/api/users/${coachTargetId}/bjj`,    { belt: pendingBelt, stripes: pendingStripes });
    await api('PUT', `/api/users/${coachTargetId}/mt`,     { level: pendingLevel });
    await api('PUT', `/api/users/${coachTargetId}/boxing`, { level: pendingBoxingLevel });
    document.getElementById('coach-modal').hidden = true;
    document.body.style.overflow = '';
    toast('Progress assigned!');
    showProfile(coachTargetId);
  } catch (err) { toast(err.message, 'error'); }
}

/* ── Weapons modal ── */
async function openWeaponsModal(userId, name, mtActive, boxingActive, bjjActive) {
  weaponsTargetId = userId;
  selectedWeapons = { bjj: [], mt: [], boxing: [] };
  document.getElementById('weapons-modal-name').textContent = name;
  // Show/hide sections based on which disciplines are active for this student
  document.getElementById('mt-weapon-section').hidden     = !mtActive;
  document.getElementById('boxing-weapon-section').hidden = !boxingActive;
  document.getElementById('bjj-weapon-section').hidden    = !bjjActive;
  // Render grids for active disciplines only — MT → Boxing → BJJ
  if (mtActive)     renderWeaponGrid('mt');
  if (boxingActive) renderWeaponGrid('boxing');
  if (bjjActive)    renderWeaponGrid('bjj');
  document.getElementById('weapons-modal').hidden = false;
  document.body.style.overflow = 'hidden';
  // Pre-load whatever this user previously assigned
  try {
    const mine = await api('GET', `/api/users/${userId}/weapons/mine`);
    selectedWeapons = mine;
    if (mtActive)     renderWeaponGrid('mt');
    if (boxingActive) renderWeaponGrid('boxing');
    if (bjjActive)    renderWeaponGrid('bjj');
  } catch { /* first time — nothing pre-selected */ }
}

function renderWeaponGrid(disc) {
  const grid    = document.getElementById(`${disc}-weapon-grid`);
  const counter = document.getElementById(`${disc}-wcount`);
  const sel     = selectedWeapons[disc] || [];
  const atMax   = sel.length >= 3;
  grid.innerHTML = WEAPONS[disc].map(w => {
    const on  = sel.includes(w);
    const off = !on && atMax;
    // escape single quotes for the onclick attribute
    const safe = w.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `<button class="weapon-chip${on ? ' selected' : ''}${off ? ' dim' : ''}"
      onclick="toggleWeapon('${disc}','${safe}')"
      ${off ? 'disabled' : ''}>${esc(w)}</button>`;
  }).join('');
  counter.textContent = `${sel.length} / 3`;
}

function toggleWeapon(disc, weapon) {
  const list = selectedWeapons[disc];
  const idx  = list.indexOf(weapon);
  if (idx >= 0) list.splice(idx, 1);
  else if (list.length < 3) list.push(weapon);
  renderWeaponGrid(disc);
}

function closeWeaponsModal(e) {
  if (e.target === document.getElementById('weapons-modal')) {
    document.getElementById('weapons-modal').hidden = true;
    document.body.style.overflow = '';
  }
}

async function saveWeaponAssignment() {
  try {
    await api('POST', `/api/users/${weaponsTargetId}/weapons`, selectedWeapons);
    document.getElementById('weapons-modal').hidden = true;
    document.body.style.overflow = '';
    toast('Weapons assigned!');
    showProfile(weaponsTargetId);
  } catch (err) { toast(err.message, 'error'); }
}

/* ── Admin: edit user ── */
function openAdminEditModal(userId, name) {
  adminEditTargetId = userId;
  document.getElementById('admin-edit-modal-name').textContent = name;
  document.getElementById('admin-edit-name').value     = name;
  document.getElementById('admin-edit-password').value = '';
  document.getElementById('admin-edit-modal').hidden   = false;
  document.body.style.overflow = 'hidden';
}

function closeAdminEditModal(e) {
  if (e.target === document.getElementById('admin-edit-modal')) {
    document.getElementById('admin-edit-modal').hidden = true;
    document.body.style.overflow = '';
  }
}

async function saveAdminEdit() {
  const name     = document.getElementById('admin-edit-name').value.trim();
  const password = document.getElementById('admin-edit-password').value;
  if (!name && !password) { toast('Enter a name or password to update', 'error'); return; }
  try {
    await api('PUT', `/api/admin/users/${adminEditTargetId}/edit`, {
      name:     name     || undefined,
      password: password || undefined,
    });
    document.getElementById('admin-edit-modal').hidden = true;
    document.body.style.overflow = '';
    toast('User updated!');
    showProfile(adminEditTargetId);
  } catch (err) { toast(err.message, 'error'); }
}

/* ── Media gallery ── */
let mediaUploadTargetId = null;

async function loadMediaGallery(userId) {
  const el = document.getElementById(`media-gallery-${userId}`);
  if (!el) return;
  try {
    const items = await api('GET', `/api/users/${userId}/media`);
    if (!items.length) {
      el.innerHTML = '<div class="media-empty">No photos or videos yet.</div>';
      return;
    }
    el.innerHTML = items.map(item => {
      const canDelete = me && (me.id === item.uploader_id || me.role === 'admin');
      const del = canDelete ? `<button class="media-delete" onclick="deleteMedia(${item.id},${userId})" title="Delete">✕</button>` : '';
      if (item.media_type === 'video') {
        return `<div class="media-item">
          <video src="${item.media_url}" controls playsinline class="media-thumb"></video>
          <div class="media-uploader">by ${esc(item.uploader_name)}</div>
          ${del}
        </div>`;
      }
      return `<div class="media-item">
        <img src="${item.media_url}" class="media-thumb" loading="lazy" alt="">
        <div class="media-uploader">by ${esc(item.uploader_name)}</div>
        ${del}
      </div>`;
    }).join('');
  } catch {
    el.innerHTML = '<div class="media-empty">Could not load media.</div>';
  }
}

function triggerMediaUpload(userId) {
  mediaUploadTargetId = userId;
  const input = document.getElementById('media-file-input');
  input.value = '';
  input.click();
}

async function handleMediaFileSelected(event) {
  const file = event.target.files[0];
  if (!file || !mediaUploadTargetId) return;
  const isVideo = file.type.startsWith('video/');
  const maxMB = isVideo ? 40 : 10;
  if (file.size > maxMB * 1024 * 1024) {
    toast(`File too large — max ${maxMB} MB`, 'error'); return;
  }
  const btn = document.querySelector(`[onclick="triggerMediaUpload(${mediaUploadTargetId})"]`);
  if (btn) btn.textContent = 'Uploading…';
  try {
    const formData = new FormData();
    formData.append('file', file);
    const resp = await fetch(`/api/users/${mediaUploadTargetId}/media`, {
      method: 'POST',
      body: formData,
      credentials: 'same-origin'
    });
    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(err.error || 'Upload failed');
    }
    toast('Media uploaded!');
    loadMediaGallery(mediaUploadTargetId);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    if (btn) btn.textContent = '+ Add';
  }
}

async function deleteMedia(mediaId, userId) {
  if (!confirm('Delete this photo/video?')) return;
  try {
    await api('DELETE', `/api/media/${mediaId}`);
    toast('Deleted');
    loadMediaGallery(userId);
  } catch (err) { toast(err.message, 'error'); }
}

/* ── Avatar helpers ── */
const AVATAR_COLORS = ['#C0392B','#8E44AD','#2980B9','#16A085','#D35400','#27AE60'];
const avatarColor   = u => AVATAR_COLORS[(u.id||0) % AVATAR_COLORS.length];
const initials      = name => (name||'?').trim().split(/\s+/).map(w=>w[0]).slice(0,2).join('').toUpperCase();

function avatarStyle(user) {
  if (user.profile_pic) return 'background:none;border-color:var(--border2)';
  return `background:${avatarColor(user)};border-color:${avatarColor(user)};color:#fff`;
}
function avatarContent(user) {
  return user.profile_pic ? `<img src="${user.profile_pic}" alt="${esc(user.name)}">` : initials(user.name);
}
function renderHeaderAvatar() {
  const el = document.getElementById('header-avatar');
  if (!me || !el) return;
  el.style.background  = me.profile_pic ? 'none' : avatarColor(me);
  el.style.borderColor = me.profile_pic ? 'var(--border2)' : avatarColor(me);
  el.style.color       = '#fff';
  el.innerHTML         = avatarContent(me);
}

/* ── Toast ── */
function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className   = `toast toast-${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3100);
}

/* ── XSS escape ── */
function esc(str) {
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}

/* ── Start ── */
init();
