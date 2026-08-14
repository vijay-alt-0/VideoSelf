const STORAGE_KEY = 'videoshelf_base_v1';
const THEME_KEY = 'videoshelf_base_theme';

let videos = loadVideos();
let editingId = null;
let pendingDeleteId = null;
let currentView = 'cards';

const $ = id => document.getElementById(id);

function loadVideos(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  }catch(e){
    console.error('Failed to load videos', e);
    return [];
  }
}
function save(){
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify(videos));
  }catch(e){
    console.error('Failed to save videos', e);
    showToast("Couldn't save — storage may be full");
  }
}

/* ---------- URL parsing ---------- */
function getVideoId(url){
  try{
    const u = new URL(url.trim());
    const host = u.hostname.replace('www.','').replace('m.','');
    if(host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
    if(host === 'youtube.com' || host === 'music.youtube.com'){
      if(u.pathname === '/watch') return u.searchParams.get('v');
      if(u.pathname.startsWith('/shorts/')) return u.pathname.split('/')[2] || null;
      if(u.pathname.startsWith('/embed/')) return u.pathname.split('/')[2] || null;
    }
  }catch(e){}
  return null;
}
function thumbUrl(id){ return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`; }
function formatDate(ts){
  return new Date(ts).toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' });
}
function escapeHtml(s=''){
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}

/* Deterministic spine color per category — same category always gets same hue */
const SPINE_PALETTE = ['#E8A33D','#D9654F','#6FA8A0','#8E8FE0','#C97D9E','#7FB06B','#D4B24C','#5FA3C9'];
function spineColor(category){
  if(!category) return '#4A4F5E';
  let hash = 0;
  for(let i=0;i<category.length;i++) hash = (hash*31 + category.charCodeAt(i)) >>> 0;
  return SPINE_PALETTE[hash % SPINE_PALETTE.length];
}

/* ---------- Toast ---------- */
function showToast(msg){
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(()=> t.classList.remove('show'), 1800);
}

/* ---------- Render ---------- */
function render(){
  const q = $('searchInput').value.trim().toLowerCase();
  const filter = $('filterSelect').value;
  const cat = $('categoryFilter').value;

  const cats = [...new Set(videos.map(v => v.category).filter(Boolean))].sort();
  $('categoryFilter').innerHTML = '<option value="all">All categories</option>' +
    cats.map(c => `<option value="${escapeHtml(c)}" ${c===cat?'selected':''}>${escapeHtml(c)}</option>`).join('');
  $('categoryList').innerHTML = cats.map(c => `<option value="${escapeHtml(c)}">`).join('');

  let list = videos.filter(v => {
    const matchesQ = !q || v.name.toLowerCase().includes(q) ||
      (v.category||'').toLowerCase().includes(q) || (v.notes||'').toLowerCase().includes(q);
    const matchesFilter = filter==='all' || (filter==='favorites' && v.favorite) ||
      (filter==='watched' && v.watched) || (filter==='unwatched' && !v.watched);
    const matchesCat = cat==='all' || v.category === cat;
    return matchesQ && matchesFilter && matchesCat;
  });

  $('stats').innerHTML = videos.length
    ? `<span><b>${videos.length}</b> saved</span><span><b>${videos.filter(v=>v.watched).length}</b> watched</span><span><b>${videos.filter(v=>v.favorite).length}</b> favorites</span>`
    : '';

  const listEl = $('videoList');
  listEl.className = `video-list view-${currentView}`;

  if(list.length === 0){
    listEl.innerHTML = videos.length
      ? `<div class="empty"><div class="big">🔍</div>No videos match your filters.</div>`
      : `<div class="empty"><div class="big">📚</div>Your shelf is empty.<br>Add your first video above.</div>`;
    return;
  }

  listEl.innerHTML = list.map(cardHtml).join('');
}

function cardHtml(v){
  const color = spineColor(v.category);
  return `
  <article class="video-item" data-id="${v.id}">
    <div class="spine ${v.watched?'watched':''}" style="--spine-color:${color}">
      ${v.favorite ? '<div class="fav-notch">★</div>' : ''}
    </div>
    <div class="thumb-wrap">
      <img class="thumb" src="${thumbUrl(v.videoId)}" alt="" loading="lazy"
        onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'thumb-fallback',textContent:'▶'}))">
      ${v.watched ? '<span class="watched-badge">WATCHED</span>' : ''}
    </div>
    <div class="video-content">
      <div class="video-title-row">
        <p class="video-title">${escapeHtml(v.name)}</p>
        ${v.favorite ? '<span class="fav-star">★</span>' : ''}
      </div>
      ${v.category ? `<span class="chip">${escapeHtml(v.category)}</span>` : ''}
      <div class="meta">Added ${formatDate(v.createdAt)}</div>
      ${v.notes ? `<div class="notes">${escapeHtml(v.notes)}</div>` : ''}
      <div class="actions">
        <button class="action-btn play" data-action="open">▶ Open</button>
        <button class="action-btn ${v.favorite?'is-fav':''}" data-action="favorite">${v.favorite?'★ Favorited':'☆ Favorite'}</button>
        <button class="action-btn" data-action="watched">${v.watched?'Mark unwatched':'Mark watched'}</button>
        <button class="action-btn" data-action="edit">Edit</button>
        <button class="action-btn is-danger" data-action="delete">Delete</button>
      </div>
    </div>
  </article>`;
}

/* ---------- Actions (event delegation, no inline handlers except thumb fallback) ---------- */
$('videoList').addEventListener('click', (e) => {
  if(!$('editOverlay').hidden || !$('confirmOverlay').hidden) return; // ignore taps behind an open modal
  const btn = e.target.closest('[data-action]');
  if(!btn) return;
  const item = e.target.closest('.video-item');
  const id = item.dataset.id;
  const v = videos.find(x => x.id === id);
  if(!v) return;

  switch(btn.dataset.action){
    case 'open':
      v.watched = true; save(); render();
      window.open(v.url, '_blank', 'noopener');
      break;
    case 'favorite':
      v.favorite = !v.favorite; save(); render();
      break;
    case 'watched':
      v.watched = !v.watched; save(); render();
      break;
    case 'edit':
      openEdit(v);
      break;
    case 'delete':
      openConfirmDelete(v);
      break;
  }
});

/* ---------- Add form ---------- */
$('videoForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = $('urlInput').value.trim();
  const name = $('nameInput').value.trim();
  const category = $('categoryInput').value.trim();
  const notes = $('notesInput').value.trim();

  if(!url || !name){
    $('formMsg').textContent = 'Link and name are required.';
    return;
  }
  const videoId = getVideoId(url);
  if(!videoId){
    $('formMsg').textContent = "That doesn't look like a valid YouTube link.";
    return;
  }

  videos.unshift({
    id: (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)+Math.random().toString(36).slice(2)),
    url, name, videoId, category, notes,
    favorite:false, watched:false, createdAt:Date.now()
  });
  save();
  e.target.reset();
  $('formMsg').textContent = 'Saved to shelf.';
  render();
  setTimeout(()=>{ if($('formMsg').textContent==='Saved to shelf.') $('formMsg').textContent=''; }, 2000);
});

/* ---------- Edit modal (custom, not native <dialog>/confirm) ---------- */
function openEdit(v){
  closeConfirm(); // never allow both modals open at once
  editingId = v.id;
  $('editName').value = v.name;
  $('editCategory').value = v.category || '';
  $('editNotes').value = v.notes || '';
  $('editOverlay').hidden = false;
}
function closeEdit(){
  $('editOverlay').hidden = true;
  editingId = null;
}
$('editCancel').addEventListener('click', closeEdit);
$('editOverlay').addEventListener('click', (e) => { if(e.target.id === 'editOverlay') closeEdit(); });
$('editSave').addEventListener('click', () => {
  const v = videos.find(x => x.id === editingId);
  if(v){
    const name = $('editName').value.trim();
    if(!name){ showToast('Name cannot be empty'); return; }
    v.name = name;
    v.category = $('editCategory').value.trim();
    v.notes = $('editNotes').value.trim();
    save(); render();
    showToast('Changes saved');
  }
  closeEdit();
});

/* ---------- Confirm modal (replaces native confirm(), which is suppressed
   in some mobile webviews and would otherwise silently break delete) ---------- */
function openConfirmDelete(v){
  closeEdit(); // never allow both modals open at once
  pendingDeleteId = v.id;
  $('confirmBody').textContent = `Remove "${v.name}" from your shelf? This can't be undone.`;
  $('confirmOverlay').hidden = false;
}
function closeConfirm(){
  $('confirmOverlay').hidden = true;
  pendingDeleteId = null;
}
$('confirmCancel').addEventListener('click', closeConfirm);
$('confirmOverlay').addEventListener('click', (e) => { if(e.target.id === 'confirmOverlay') closeConfirm(); });
$('confirmOk').addEventListener('click', () => {
  if(pendingDeleteId){
    videos = videos.filter(v => v.id !== pendingDeleteId);
    save(); render();
    showToast('Removed');
  }
  closeConfirm();
});

/* ---------- Search / filter / view ---------- */
['searchInput','filterSelect','categoryFilter'].forEach(id => $(id).addEventListener('input', render));

document.querySelectorAll('.view-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentView = btn.dataset.view;
    render();
  });
});

/* ---------- Theme ---------- */
function applyTheme(light){
  document.body.classList.toggle('light', light);
  $('themeBtn').textContent = light ? '☾' : '☀';
  $('themeBtn').setAttribute('aria-label', light ? 'Toggle dark mode' : 'Toggle light mode');
}
$('themeBtn').addEventListener('click', () => {
  const isLight = !document.body.classList.contains('light');
  applyTheme(isLight);
  localStorage.setItem(THEME_KEY, isLight ? 'light' : 'dark');
});
applyTheme(localStorage.getItem(THEME_KEY) === 'light');

/* ---------- PWA launch/share/file integrations ---------- */
function validYouTubeUrl(url){
  return typeof url === 'string' && !!getVideoId(url);
}

function handleIncomingLaunch(){
  const params = new URLSearchParams(location.search);
  const action = params.get('action');
  const filter = params.get('filter');
  const sharedUrl = params.get('url');
  const sharedName = params.get('name') || params.get('title') || '';
  const sharedText = params.get('text') || '';
  const protocolValue = params.get('videoshelf');

  if (filter && ['all','favorites','watched','unwatched'].includes(filter)) {
    $('filterSelect').value = filter;
  }

  let protocolUrl = '';
  try { protocolUrl = protocolValue ? decodeURIComponent(protocolValue) : ''; } catch (_) {}
  const incomingUrl = sharedUrl || protocolUrl;
  if (validYouTubeUrl(incomingUrl)) {
    $('urlInput').value = incomingUrl;
    $('nameInput').value = sharedName || '';
    if (sharedText && !$('notesInput').value) $('notesInput').value = sharedText.slice(0, 500);
    $('formMsg').textContent = 'Shared video loaded — review it and tap Add to shelf.';
  }

  if (action === 'add') {
    setTimeout(() => $('urlInput').scrollIntoView({behavior:'smooth', block:'center'}), 50);
    setTimeout(() => $('urlInput').focus(), 300);
  }
}

async function registerBackgroundCapabilities(){
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    if ('sync' in registration) {
      try { await registration.sync.register('videoshelf-background-sync'); } catch (_) {}
    }
    if ('periodicSync' in registration) {
      try {
        const permission = await registration.periodicSync.permissionState({
          tag: 'videoshelf-periodic-sync'
        });
        if (permission === 'granted') {
          await registration.periodicSync.register('videoshelf-periodic-sync', {
            minInterval: 24 * 60 * 60 * 1000
          });
        }
      } catch (_) {}
    }
  } catch (_) {}
}

function setupLaunchQueue(){
  if (!('launchQueue' in window) || typeof window.launchQueue.setConsumer !== 'function') return;
  window.launchQueue.setConsumer(async (launchParams) => {
    const files = launchParams.files || [];
    for (const fileHandle of files) {
      try {
        const file = await fileHandle.getFile();
        if (file.type === 'application/json' || file.name.toLowerCase().endsWith('.json')) {
          await importBackupFile(file);
        }
      } catch (error) {
        console.error('File handler failed', error);
      }
    }
  });
}

/* ---------- Export / Import ---------- */
$('exportBtn').addEventListener('click', () => {
  if(videos.length === 0){ showToast('Nothing to export yet'); return; }
  const payload = {
    app: 'VideoShelf',
    version: 1,
    exportedAt: new Date().toISOString(),
    videos
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type:'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0,10);
  a.href = url;
  a.download = `videoshelf-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
  showToast('Backup downloaded');
});

async function importBackupFile(file){
  const text = await file.text();
  const data = JSON.parse(text);
  const incoming = Array.isArray(data) ? data : data.videos;
  if(!Array.isArray(incoming)) throw new Error('No videos array found in file');

  const existingIds = new Set(videos.map(v => v.id));
  const existingUrls = new Set(videos.map(v => v.url));
  let added = 0, skipped = 0;

  incoming.forEach(raw => {
    if(!raw || typeof raw !== 'object' || !raw.url || !raw.name){ skipped++; return; }
    const videoId = raw.videoId || getVideoId(raw.url);
    if(!videoId){ skipped++; return; }
    if(existingUrls.has(raw.url)){ skipped++; return; }

    const id = (raw.id && !existingIds.has(raw.id)) ? raw.id :
      (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)+Math.random().toString(36).slice(2));
    existingIds.add(id);
    existingUrls.add(raw.url);

    videos.push({
      id,
      url: String(raw.url),
      name: String(raw.name).slice(0,120),
      videoId,
      category: raw.category ? String(raw.category).slice(0,40) : '',
      notes: raw.notes ? String(raw.notes).slice(0,500) : '',
      favorite: !!raw.favorite,
      watched: !!raw.watched,
      createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now()
    });
    added++;
  });

  save();
  render();
  showToast(`Imported ${added} video${added===1?'':'s'}${skipped ? `, skipped ${skipped}` : ''}`);
}

$('importInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if(!file) return;
  try {
    await importBackupFile(file);
  } catch(err) {
    console.error('Import failed', err);
    showToast("Couldn't read that file — is it a VideoShelf backup?");
  } finally {
    e.target.value = '';
  }
});

/* ---------- Service worker / PWA integrations ---------- */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.ready
    .then(() => registerBackgroundCapabilities())
    .catch(err => console.error('Service worker readiness failed', err));
}

setupLaunchQueue();
handleIncomingLaunch();
render();
