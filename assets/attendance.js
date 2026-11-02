(() => {
  'use strict';
  const root = document.getElementById('attendance');
  if (!root) return;
  const get = id => document.getElementById(id);
  const status = get('att-status'), connect = get('att-connect'), checkin = get('att-checkin');
  let state = null, adminData = null, loading = false, actionPending = false, adminRequest = 0, sessionVersion = 0;
  const dateLabel = (day, options = {}) => new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric', ...options });
  const timeLabel = (time, zone) => new Date(time).toLocaleTimeString(undefined, { timeZone: zone, hour: '2-digit', minute: '2-digit' });
  function message(text, error = false) { status.textContent = text; status.classList.toggle('error', error); }
  async function request(path, options = {}) {
    const response = await fetch(path, { ...options, credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json', ...options.headers } });
    let data;
    const setupError = 'Attendance is not connected yet. Ask a clan admin to finish the website setup.';
    try { data = await response.json(); } catch { throw new Error(setupError); }
    if (!response.ok || data?.error) {
      const detail = [data?.error, data?.error?.message, data?.message].find(value => typeof value === 'string' && value.trim());
      const error = new Error(detail || (response.status === 404 ? setupError : `Attendance could not be loaded (HTTP ${response.status}). Please try again.`));
      error.status = response.status;
      throw error;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(setupError);
    if (['/api/attendance/session', '/api/attendance/checkin'].includes(path) &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(data.today || '') || typeof data.timeZone !== 'string' || !Object.hasOwn(data, 'user'))) throw new Error(setupError);
    return data;
  }
  function paintHistory(data) {
    const days = new Set((data.history || []).map(row => row.day));
    const grid = get('att-history'); grid.replaceChildren();
    for (let offset = 13; offset >= 0; offset--) {
      const day = new Date(Date.parse(`${data.today}T12:00:00Z`) - offset * 86400000).toISOString().slice(0, 10);
      const item = document.createElement('div');
      const present = days.has(day);
      item.className = `att-history-day${present ? ' present' : ''}${offset === 0 ? ' today' : ''}`;
      item.title = `${dateLabel(day)}: ${present ? 'Checked in' : 'No check-in'}`;
      item.setAttribute('aria-label', item.title);
      const label = document.createElement('span'); label.textContent = dateLabel(day, { weekday: 'short', month: undefined, day: undefined });
      const number = document.createElement('b'); number.textContent = day.slice(-2);
      item.append(label, number); grid.append(item);
    }
    get('att-history-note').textContent = data.user ? 'Your last 14 days. Each day resets at midnight in the clan timezone.' : 'Sign in to see your check-ins here.';
  }
  function render(data) {
    state = data;
    get('att-today').textContent = dateLabel(data.today, { year: 'numeric' });
    get('att-timezone').textContent = `Daily reset · ${data.timeZone}`;
    get('att-guest').hidden = Boolean(data.user);
    get('att-member').hidden = !data.user;
    get('att-admin').hidden = !data.user?.isAdmin;
    connect.removeAttribute('aria-disabled'); connect.tabIndex = 0;
    paintHistory(data);
    if (!data.user) { adminData = null; get('att-admin-rows').replaceChildren(); return; }
    get('att-name').textContent = data.user.displayName;
    get('att-username').textContent = `@${data.user.username}`;
    const avatar = get('att-avatar'); avatar.replaceChildren();
    if (data.user.avatar && /^https:\/\/cdn\.discordapp\.com\/avatars\//.test(data.user.avatar)) {
      const img = document.createElement('img'); img.src = data.user.avatar; img.alt = ''; img.referrerPolicy = 'no-referrer'; avatar.append(img);
    } else avatar.textContent = data.user.displayName.slice(0, 1).toUpperCase();
    get('att-total').textContent = data.totalDays;
    get('att-streak').textContent = data.streak;
    checkin.disabled = Boolean(data.checkedIn);
    checkin.classList.toggle('done', Boolean(data.checkedIn));
    checkin.querySelector('span').textContent = data.checkedIn ? 'Checked in today ✓' : 'Check in for today';
    get('att-checkin-note').textContent = data.checkedIn ? `Recorded at ${timeLabel(data.checkedIn.checked_in_at, data.timeZone)} · ${data.timeZone}. See you tomorrow.` : 'One check-in per day, connected to your Discord account.';
    if (data.user.isAdmin) {
      const date = get('att-admin-date'); date.max = data.today;
      if (!date.value) date.value = data.today;
    }
  }
  async function refresh() {
    if (loading || actionPending) return;
    const version = sessionVersion;
    loading = true; get('att-retry').disabled = true;
    try {
      const data = await request('/api/attendance/session');
      if (version !== sessionVersion) return;
      render(data);
      message('');
      if (state.user?.isAdmin) await loadAdmin();
    } catch (error) {
      if (version !== sessionVersion) return;
      connect.setAttribute('aria-disabled', 'true'); connect.tabIndex = -1;
      checkin.disabled = true;
      message(error.message, true);
    } finally { loading = false; get('att-retry').disabled = false; }
  }
  checkin.addEventListener('click', async () => {
    if (actionPending) return;
    actionPending = true;
    sessionVersion++;
    get('att-logout').disabled = true;
    checkin.disabled = true; message('Recording your check-in…');
    try {
      const data = await request('/api/attendance/checkin', { method: 'POST' });
      render(data);
      message(data.alreadyCheckedIn ? 'You already checked in today. Your original check-in is saved.' : 'You’re on the list. Thanks for showing up!');
      if (state.user?.isAdmin) await loadAdmin();
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        render({ configured: true, user: null, today: state.today, timeZone: state.timeZone });
      } else checkin.disabled = Boolean(state?.checkedIn);
      message(error.message, true);
    } finally { actionPending = false; get('att-logout').disabled = false; }
  });
  get('att-logout').addEventListener('click', async event => {
    if (actionPending) return;
    actionPending = true;
    sessionVersion++;
    event.currentTarget.disabled = true;
    checkin.disabled = true;
    try {
      await request('/auth/logout', { method: 'POST' });
      adminRequest++; adminData = null;
      render({ configured: true, user: null, today: state.today, timeZone: state.timeZone });
      message('You’ve signed out. Your attendance history is saved.');
    } catch (error) { checkin.disabled = Boolean(state?.checkedIn); message(error.message, true); }
    finally { actionPending = false; get('att-logout').disabled = false; }
  });
  async function loadAdmin() {
    const requestId = ++adminRequest;
    const day = get('att-admin-date').value;
    adminData = null; get('att-export').disabled = true;
    get('att-admin-summary').textContent = 'Loading attendance…';
    get('att-admin-rows').replaceChildren();
    try {
      const data = await request(`/api/attendance/admin?day=${encodeURIComponent(day)}`);
      if (requestId !== adminRequest || !state?.user?.isAdmin) return;
      adminData = data;
      const present = data.members.filter(member => member.checked_in_at).length;
      get('att-admin-summary').textContent = `${present} checked in · ${data.members.length - present} without a check-in · ${data.members.length} registered members`;
      const body = get('att-admin-rows');
      for (const member of data.members) {
        const row = document.createElement('tr');
        const name = document.createElement('td'); name.textContent = member.display_name;
        const username = document.createElement('small'); username.textContent = `@${member.username}`; name.append(username);
        const attendance = document.createElement('td'); attendance.textContent = member.checked_in_at ? 'Present' : 'No check-in';
        if (member.checked_in_at) attendance.className = 'present';
        const time = document.createElement('td'); time.textContent = member.checked_in_at ? timeLabel(member.checked_in_at, data.timeZone) : '—';
        row.append(name, attendance, time); body.append(row);
      }
      get('att-export').disabled = false;
    } catch (error) {
      if (requestId === adminRequest) get('att-admin-summary').textContent = error.message;
    }
  }
  // Prevent spreadsheet formula execution in exported, user-controlled names.
  const csvCell = value => {
    let text = String(value ?? '');
    if (/^[\s]*[=+@\-\t\r\n]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  get('att-export').addEventListener('click', () => {
    if (!adminData) return;
    const rows = [['Date', 'Discord ID', 'Display name', 'Username', 'Status', 'Check-in (UTC)', 'Clan timezone']];
    for (const member of adminData.members) rows.push([adminData.day, `'${member.discord_id}`, member.display_name, member.username, member.checked_in_at ? 'Present' : 'No check-in', member.checked_in_at || '', adminData.timeZone]);
    const url = URL.createObjectURL(new Blob(['\uFEFF', rows.map(row => row.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `synchronized-attendance-${adminData.day}.csv`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  get('att-admin-date').addEventListener('change', loadAdmin);
  get('att-admin-refresh').addEventListener('click', loadAdmin);
  get('att-retry').addEventListener('click', refresh);
  connect.addEventListener('click', event => { if (connect.getAttribute('aria-disabled') === 'true') event.preventDefault(); });
  // Refresh server date/session after a background tab returns or a clan day rolls over.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden) refresh(); }, 60000);
  const query = new URL(location.href);
  const authError = query.searchParams.get('attendance_error');
  if (authError) {
    query.searchParams.delete('attendance_error'); window.history.replaceState(null, '', query);
  }
  refresh().then(() => {
    if (authError) message(({ cancelled: 'Discord sign-in was cancelled. You can try again whenever you’re ready.', membership: 'Sign in with an approved member account from the clan Discord server.', failed: 'Discord sign-in did not finish. Please try again.' })[authError] || 'Discord sign-in did not finish. Please try again.', true);
  });
})();
