/* ==========================================================================
   VideoShelf — app logic
   Data model v2: status (unwatched/watched/completed), categories with
   sub-categories + colors, timestamps for progress tracking.
   ========================================================================== */

const STORAGE_KEY   = 'videoshelf_base_v1';        // videos array
const CATS_KEY       = 'videoshelf_categories_v1'; // category registry
const THEME_KEY      = 'videoshelf_base_theme';

const $ = id => document.getElementById(id);

/* ---------- State ---------- */
let videos = loadVideos();
let categories = loadCategories();   // [{ name, color, subs:[string] }]
let editingId = null;
let pendingDeleteId = null;
let bulkDeleteMode = false;
let currentView = 'cards';
let currentSort = 'newest';
let selectMode = false;
let selectedIds = new Set();
let lastDeleted = null; // { video } snapshot for undo
let undoTimer = null;
let importMode = 'merge'; // 'merge' | 'replace'
let dashboardDate = null; // 'YYYY-MM-DD' currently selected in calendar, null = today
let dragSrcId = null;

/* ---------- Persistence ---------- */
function loadVideos(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    let migrated = false;
    list.forEach((v, i) => {
      if(v.status === undefined){
        v.status = v.watched ? 'watched' : 'unwatched';
        if(v.watched && !v.watchedAt) v.watchedAt = v.createdAt || Date.now();
        migrated = true;
      }
      if(v.subCategory === undefined){ v.subCategory = ''; migrated = true; }
      if(v.order === undefined){ v.order = i; migrated = true; }
    });
    if(migrated) localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    return list;
  }catch(e){
    console.error('Failed to load videos', e);
    return [];
  }
}
function saveVideos(){
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify(videos));
  }catch(e){
    console.error('Failed to save videos', e);
    showToast("Couldn't save — storage may be full");
  }
}
function loadCategories(){
  try{
    const raw = localStorage.getItem(CATS_KEY);
    return raw ? JSON.parse(raw) : [];
  }catch(e){
    console.error('Failed to load categories', e);
    return [];
  }
}
function saveCategories(){
  try{
    localStorage.setItem(CATS_KEY, JSON.stringify(categories));
  }catch(e){
    console.error('Failed to save categories', e);
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
function dateKey(ts){
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function todayKey(){ return dateKey(Date.now()); }
function daysAgoLabel(ts){
  const then = new Date(ts); const now = new Date();
  const a = new Date(then.getFullYear(), then.getMonth(), then.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((b - a) / 86400000);
  if(diffDays <= 0) return 'Today';
  if(diffDays === 1) return '1 day ago';
  return `${diffDays} days ago`;
}
function escapeHtml(s=''){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}
function newId(){
  return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)+Math.random().toString(36).slice(2);
}

/* ---------- Category registry ----------
   categories: [{ name, color, subs: [string,...] }]
   Videos reference category/subCategory by name (string). Legacy free-text
   categories not yet in the registry get an auto color and no subs. */
const SPINE_PALETTE = ['#E8A33D','#D9654F','#6FA8A0','#8E8FE0','#C97D9E','#7FB06B','#D4B24C','#5FA3C9'];
function autoColor(name){
  if(!name) return '#4A4F5E';
  let hash = 0;
  for(let i=0;i<name.length;i++) hash = (hash*31 + name.charCodeAt(i)) >>> 0;
  return SPINE_PALETTE[hash % SPINE_PALETTE.length];
}
function getCategory(name){ return categories.find(c => c.name === name); }
function categoryColor(name){
  const c = getCategory(name);
  return (c && c.color) ? c.color : autoColor(name);
}
function ensureCategory(name){
  if(!name) return;
  if(!getCategory(name)){
    categories.push({ name, color: autoColor(name), subs: [] });
    saveCategories();
  }
}
function ensureSubCategory(catName, subName){
  if(!catName || !subName) return;
  ensureCategory(catName);
  const c = getCategory(catName);
  if(c && !c.subs.includes(subName)){
    c.subs.push(subName);
    saveCategories();
  }
}
function allCategoryNames(){
  const fromRegistry = categories.map(c => c.name);
  const fromVideos = videos.map(v => v.category).filter(Boolean);
  return [...new Set([...fromRegistry, ...fromVideos])].sort();
}
function subCategoriesFor(catName){
  const c = getCategory(catName);
  if(c && c.subs.length) return c.subs.slice().sort();
  return [...new Set(videos.filter(v=>v.category===catName).map(v=>v.subCategory).filter(Boolean))].sort();
}
function categoryCounts(){
  const counts = {};
  videos.forEach(v => {
    if(!v.category) return;
    counts[v.category] = (counts[v.category]||0) + 1;
  });
  return counts;
}

/* ---------- Toast (supports an optional action button, e.g. Undo) ---------- */
function showToast(msg, opts={}){
  const t = $('toast');
  t.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = msg;
  t.appendChild(span);
  if(opts.actionLabel && opts.onAction){
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.type = 'button';
    btn.textContent = opts.actionLabel;
    btn.addEventListener('click', () => { opts.onAction(); t.classList.remove('show'); });
    t.appendChild(btn);
  }
  t.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(()=> t.classList.remove('show'), opts.duration || 2400);
}

/* ---------- Sorting ---------- */
function sortVideos(list){
  const arr = list.slice();
  switch(currentSort){
    case 'name-asc':  return arr.sort((a,b)=> a.name.localeCompare(b.name));
    case 'name-desc': return arr.sort((a,b)=> b.name.localeCompare(a.name));
    case 'category':  return arr.sort((a,b)=> (a.category||'').localeCompare(b.category||'') || a.name.localeCompare(b.name));
    case 'oldest':    return arr.sort((a,b)=> a.createdAt - b.createdAt);
    case 'manual':    return arr.sort((a,b)=> (a.order??0) - (b.order??0));
    case 'newest':
    default:          return arr.sort((a,b)=> b.createdAt - a.createdAt);
  }
}

/* ---------- Render: main shelf ---------- */
function render(){
  const q = $('searchInput').value.trim().toLowerCase();
  const filter = $('filterSelect').value;
  const cat = $('categoryFilter').value;
  const sub = $('subCategoryFilter') ? $('subCategoryFilter').value : 'all';

  // Populate category filter dropdown with counts
  const counts = categoryCounts();
  const catNames = allCategoryNames();
  $('categoryFilter').innerHTML = '<option value="all">All categories</option>' +
    catNames.map(c => `<option value="${escapeHtml(c)}" ${c===cat?'selected':''}>${escapeHtml(c)} (${counts[c]||0})</option>`).join('');

  // Sub-category filter depends on selected category
  const subFilterEl = $('subCategoryFilter');
  if(subFilterEl){
    if(cat !== 'all'){
      const subs = subCategoriesFor(cat);
      subFilterEl.innerHTML = '<option value="all">All sub-categories</option>' +
        subs.map(s => `<option value="${escapeHtml(s)}" ${s===sub?'selected':''}>${escapeHtml(s)}</option>`).join('');
      subFilterEl.hidden = subs.length === 0;
    } else {
      subFilterEl.innerHTML = '<option value="all">All sub-categories</option>';
      subFilterEl.hidden = true;
    }
  }

  // Category datalist for the add/edit forms
  $('categoryList').innerHTML = catNames.map(c => `<option value="${escapeHtml(c)}">`).join('');
  updateSubCategoryDatalist($('categoryInput') ? $('categoryInput').value.trim() : '');

  let list = videos.filter(v => {
    const matchesQ = !q || v.name.toLowerCase().includes(q) ||
      (v.category||'').toLowerCase().includes(q) || (v.subCategory||'').toLowerCase().includes(q) ||
      (v.notes||'').toLowerCase().includes(q);
    const matchesFilter = filter==='all' || (filter==='favorites' && v.favorite) ||
      (filter==='watched' && v.status==='watched') ||
      (filter==='completed' && v.status==='completed') ||
      (filter==='unwatched' && v.status==='unwatched');
    const matchesCat = cat==='all' || v.category === cat;
    const matchesSub = sub==='all' || v.subCategory === sub;
    return matchesQ && matchesFilter && matchesCat && matchesSub;
  });

  list = sortVideos(list);

  $('stats').innerHTML = videos.length
    ? `<span><b>${videos.length}</b> saved</span>` +
      `<span><b>${videos.filter(v=>v.status==='unwatched').length}</b> not watched</span>` +
      `<span><b>${videos.filter(v=>v.status==='watched').length}</b> watched</span>` +
      `<span><b>${videos.filter(v=>v.status==='completed').length}</b> completed</span>` +
      `<span><b>${videos.filter(v=>v.favorite).length}</b> favorites</span>`
    : '';

  const listEl = $('videoList');
  listEl.className = `video-list view-${currentView}`;

  if(list.length === 0){
    listEl.innerHTML = videos.length
      ? `<div class="empty"><div class="big">🔍</div>No videos match your filters.</div>`
      : `<div class="empty"><div class="big">📚</div>Your shelf is empty.<br>Add your first video above.</div>`;
    updateBulkBar();
    return;
  }

  const draggable = currentSort === 'manual' && !selectMode;
  listEl.innerHTML = list.map(v => cardHtml(v, draggable)).join('');

  if(draggable) wireDragHandlers();
  updateBulkBar();
}

function statusLabel(status){
  return status === 'completed' ? 'Completed' : status === 'watched' ? 'Watched' : 'Not watched';
}
function statusBadgeClass(status){
  return status === 'completed' ? 'badge-completed' : status === 'watched' ? 'badge-watched' : 'badge-unwatched';
}

function cardHtml(v, draggable){
  const color = categoryColor(v.category);
  const isSelected = selectedIds.has(v.id);
  const classes = ['video-item'];
  if(isSelected) classes.push('is-selected');
  if(selectMode) classes.push('has-select');
  if(draggable) classes.push('has-drag');
  return `
  <article class="${classes.join(' ')}" data-id="${v.id}" ${draggable?'draggable="true"':''}>
    ${draggable ? '<div class="drag-handle" aria-hidden="true">⠿</div>' : ''}
    ${selectMode ? `<div class="select-box" data-action="toggle-select">${isSelected?'☑':'☐'}</div>` : ''}
    <div class="spine ${v.status!=='unwatched'?'dimmed':''}" style="--spine-color:${color}">
      ${v.favorite ? '<div class="fav-notch">★</div>' : ''}
    </div>
    <div class="thumb-wrap">
      <img class="thumb" src="${thumbUrl(v.videoId)}" alt="" loading="lazy"
        onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'thumb-fallback',textContent:'▶'}))">
      <span class="days-badge">${daysAgoLabel(v.createdAt)}</span>
    </div>
    <div class="video-content">
      <div class="video-title-row">
        <p class="video-title">${escapeHtml(v.name)}</p>
        ${v.favorite ? '<span class="fav-star">★</span>' : ''}
      </div>
      <div class="chip-row">
        ${v.category ? `<span class="chip" style="--chip-color:${color}">${escapeHtml(v.category)}${v.subCategory?' / '+escapeHtml(v.subCategory):''}</span>` : ''}
        <span class="badge ${statusBadgeClass(v.status)}">${statusLabel(v.status)}</span>
      </div>
      <div class="meta">Added ${formatDate(v.createdAt)}</div>
      ${v.notes ? `<div class="notes">${escapeHtml(v.notes)}</div>` : ''}
      <div class="actions">
        <button class="action-btn play" data-action="open">▶ Open</button>
        <button class="action-btn ${v.favorite?'is-fav':''}" data-action="favorite">${v.favorite?'★ Favorited':'☆ Favorite'}</button>
        <button class="action-btn" data-action="cycle-status">${v.status==='unwatched'?'Mark watched':v.status==='watched'?'Mark completed':'Reset to not watched'}</button>
        <button class="action-btn" data-action="edit">Edit</button>
        <button class="action-btn is-danger" data-action="delete">Delete</button>
      </div>
    </div>
  </article>`;
}

/* ---------- Sub-category datalist (depends on typed category) ---------- */
function updateSubCategoryDatalist(catName){
  const dl = $('subCategoryList');
  if(!dl) return;
  const subs = catName ? subCategoriesFor(catName) : [];
  dl.innerHTML = subs.map(s => `<option value="${escapeHtml(s)}">`).join('');
}
$('categoryInput') && $('categoryInput').addEventListener('input', (e) => {
  updateSubCategoryDatalist(e.target.value.trim());
});

/* ---------- Card actions (event delegation) ---------- */
$('videoList').addEventListener('click', (e) => {
  if(!$('editOverlay').hidden || !$('confirmOverlay').hidden) return; // ignore taps behind an open modal
  const item = e.target.closest('.video-item');
  if(!item) return;
  const id = item.dataset.id;
  const v = videos.find(x => x.id === id);
  if(!v) return;

  const btn = e.target.closest('[data-action]');
  if(!btn) return;

  if(selectMode && btn.dataset.action !== 'toggle-select'){
    // in select mode, tapping the card body toggles selection instead of running the action
    toggleSelect(id);
    return;
  }

  switch(btn.dataset.action){
    case 'toggle-select':
      toggleSelect(id);
      break;
    case 'open':
      if(v.status === 'unwatched'){ v.status = 'watched'; v.watchedAt = Date.now(); }
      // Completed videos are never auto-changed by opening (per user decision)
      saveVideos(); render();
      window.open(v.url, '_blank', 'noopener');
      break;
    case 'favorite':
      v.favorite = !v.favorite; saveVideos(); render();
      break;
    case 'cycle-status':
      if(v.status === 'unwatched'){ v.status = 'watched'; v.watchedAt = Date.now(); }
      else if(v.status === 'watched'){ v.status = 'completed'; v.completedAt = Date.now(); }
      else { v.status = 'unwatched'; v.watchedAt = null; v.completedAt = null; }
      saveVideos(); render();
      break;
    case 'edit':
      openEdit(v);
      break;
    case 'delete':
      openConfirmDelete(v);
      break;
  }
});

/* Also allow tapping the card itself (not just buttons) to select, in select mode */
$('videoList').addEventListener('click', (e) => {
  if(!selectMode) return;
  const item = e.target.closest('.video-item');
  if(!item) return;
  if(e.target.closest('[data-action]')) return; // already handled above
});

function toggleSelect(id){
  if(selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id);
  render();
}

/* ---------- Bulk select / delete ---------- */
$('selectModeBtn').addEventListener('click', () => {
  selectMode = !selectMode;
  selectedIds.clear();
  $('selectModeBtn').textContent = selectMode ? 'Cancel selecting' : 'Select';
  $('selectModeBtn').classList.toggle('active', selectMode);
  render();
});

function updateBulkBar(){
  const bar = $('bulkBar');
  if(!bar) return;
  if(!selectMode || selectedIds.size === 0){
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  $('bulkCount').textContent = `${selectedIds.size} selected`;
}

$('bulkDeleteBtn') && $('bulkDeleteBtn').addEventListener('click', () => {
  if(selectedIds.size === 0) return;
  $('confirmBody').textContent = `Remove ${selectedIds.size} selected video${selectedIds.size===1?'':'s'}? This can't be undone from here (but a brief Undo will appear after).`;
  bulkDeleteMode = true;
  $('confirmOverlay').hidden = false;
});

$('bulkMoveBtn') && $('bulkMoveBtn').addEventListener('click', () => {
  if(selectedIds.size === 0) return;
  openBulkMove();
});

/* ---------- Drag-and-drop reordering (touch + mouse via native DnD where available,
   plus a pointer-based fallback so it behaves on mobile webviews) ---------- */
function wireDragHandlers(){
  const items = document.querySelectorAll('.video-item[draggable="true"]');
  items.forEach(item => {
    item.addEventListener('dragstart', (e) => {
      dragSrcId = item.dataset.id;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      dragSrcId = null;
    });
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      const dragging = document.querySelector('.video-item.dragging');
      if(!dragging || dragging === item) return;
      const rect = item.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height/2;
      item.parentNode.insertBefore(dragging, before ? item : item.nextSibling);
    });
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      persistManualOrder();
    });
  });

  // Touch fallback: long-press then drag using pointer events (native HTML5 DnD
  // is unreliable on many mobile webviews)
  let touchDragEl = null, touchStartY = 0, longPressTimer = null;
  items.forEach(item => {
    const handle = item.querySelector('.drag-handle');
    if(!handle) return;
    handle.addEventListener('touchstart', (e) => {
      touchDragEl = item;
      item.classList.add('dragging');
      e.preventDefault();
    }, { passive:false });
    handle.addEventListener('touchmove', (e) => {
      if(!touchDragEl) return;
      e.preventDefault();
      const touch = e.touches[0];
      const el = document.elementFromPoint(touch.clientX, touch.clientY);
      const target = el && el.closest('.video-item');
      if(target && target !== touchDragEl){
        const rect = target.getBoundingClientRect();
        const before = (touch.clientY - rect.top) < rect.height/2;
        target.parentNode.insertBefore(touchDragEl, before ? target : target.nextSibling);
      }
    }, { passive:false });
    handle.addEventListener('touchend', () => {
      if(touchDragEl){
        touchDragEl.classList.remove('dragging');
        touchDragEl = null;
        persistManualOrder();
      }
    });
  });
}
function persistManualOrder(){
  const ids = [...document.querySelectorAll('.video-item')].map(el => el.dataset.id);
  ids.forEach((id, i) => {
    const v = videos.find(x => x.id === id);
    if(v) v.order = i;
  });
  saveVideos();
  showToast('Order saved');
}

/* ---------- Add form ---------- */
$('videoForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = $('urlInput').value.trim();
  const name = $('nameInput').value.trim();
  const category = $('categoryInput').value.trim();
  const subCategory = $('subCategoryInput') ? $('subCategoryInput').value.trim() : '';
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

  const dup = videos.find(v => v.url === url);
  if(dup){
    $('formMsg').textContent = `Already on your shelf as "${dup.name}".`;
    return;
  }

  if(category) ensureCategory(category);
  if(category && subCategory) ensureSubCategory(category, subCategory);

  videos.unshift({
    id: newId(),
    url, name, videoId, category, subCategory, notes,
    favorite:false, status:'unwatched', watchedAt:null, completedAt:null,
    createdAt:Date.now(), order:-1
  });
  // shift everyone else's manual order down so the new item can sit at 0 if manual sort is used
  videos.forEach((v,i)=>{ if(v.order===-1) v.order = 0; else v.order = i; });

  saveVideos();
  e.target.reset();
  $('formMsg').textContent = 'Saved to shelf.';
  render();
  setTimeout(()=>{ if($('formMsg').textContent==='Saved to shelf.') $('formMsg').textContent=''; }, 2000);
});

/* ---------- Edit modal ---------- */
function openEdit(v){
  closeConfirm();
  editingId = v.id;
  $('editName').value = v.name;
  $('editCategory').value = v.category || '';
  $('editSubCategory').value = v.subCategory || '';
  $('editNotes').value = v.notes || '';
  $('editStatus').value = v.status;
  updateSubCategoryDatalist(v.category || '');
  $('editOverlay').hidden = false;
}
function closeEdit(){
  $('editOverlay').hidden = true;
  editingId = null;
}
$('editCancel').addEventListener('click', closeEdit);
$('editOverlay').addEventListener('click', (e) => { if(e.target.id === 'editOverlay') closeEdit(); });
$('editCategory').addEventListener('input', (e) => updateSubCategoryDatalist(e.target.value.trim()));
$('editSave').addEventListener('click', () => {
  const v = videos.find(x => x.id === editingId);
  if(v){
    const name = $('editName').value.trim();
    if(!name){ showToast('Name cannot be empty'); return; }
    v.name = name;
    const cat = $('editCategory').value.trim();
    const sub = $('editSubCategory').value.trim();
    v.category = cat;
    v.subCategory = sub;
    v.notes = $('editNotes').value.trim();
    if(cat) ensureCategory(cat);
    if(cat && sub) ensureSubCategory(cat, sub);

    const newStatus = $('editStatus').value;
    if(newStatus !== v.status){
      v.status = newStatus;
      if(newStatus === 'watched' && !v.watchedAt) v.watchedAt = Date.now();
      if(newStatus === 'completed') v.completedAt = Date.now();
      if(newStatus === 'unwatched'){ v.watchedAt = null; v.completedAt = null; }
    }
    saveVideos(); render();
    showToast('Changes saved');
  }
  closeEdit();
});

/* ---------- Confirm modal (single delete + bulk delete, both routed here) ---------- */
function openConfirmDelete(v){
  closeEdit();
  bulkDeleteMode = false;
  pendingDeleteId = v.id;
  $('confirmBody').textContent = `Remove "${v.name}" from your shelf?`;
  $('confirmOverlay').hidden = false;
}
function closeConfirm(){
  $('confirmOverlay').hidden = true;
  pendingDeleteId = null;
  bulkDeleteMode = false;
}
$('confirmCancel').addEventListener('click', closeConfirm);
$('confirmOverlay').addEventListener('click', (e) => { if(e.target.id === 'confirmOverlay') closeConfirm(); });
$('confirmOk').addEventListener('click', () => {
  if(bulkDeleteMode && selectedIds.size){
    const removed = videos.filter(v => selectedIds.has(v.id));
    videos = videos.filter(v => !selectedIds.has(v.id));
    saveVideos();
    offerUndo(removed, `Removed ${removed.length} videos`);
    selectMode = false; selectedIds.clear();
    render();
  } else if(pendingDeleteId){
    const removed = videos.filter(v => v.id === pendingDeleteId);
    videos = videos.filter(v => v.id !== pendingDeleteId);
    saveVideos();
    offerUndo(removed, 'Removed');
    render();
  }
  closeConfirm();
});

/* ---------- Undo-on-delete ---------- */
function offerUndo(removedVideos, message){
  clearTimeout(undoTimer);
  lastDeleted = removedVideos;
  showToast(message, {
    actionLabel: 'Undo',
    duration: 5000,
    onAction: () => {
      if(!lastDeleted) return;
      videos = videos.concat(lastDeleted);
      saveVideos();
      lastDeleted = null;
      render();
      showToast('Restored');
    }
  });
  undoTimer = setTimeout(()=>{ lastDeleted = null; }, 5000);
}

/* ---------- Search / filter / sort / view ---------- */
['searchInput','filterSelect'].forEach(id => $(id) && $(id).addEventListener('input', render));
$('categoryFilter').addEventListener('change', () => { render(); });
$('subCategoryFilter') && $('subCategoryFilter').addEventListener('change', render);
$('sortSelect') && $('sortSelect').addEventListener('change', (e) => { currentSort = e.target.value; render(); });

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

/* ---------- Category color manager ---------- */
function openCategoryManager(){
  const names = allCategoryNames();
  names.forEach(ensureCategory); // make sure legacy free-text cats are registered
  const wrap = $('categoryManagerList');
  wrap.innerHTML = names.length ? names.map(name => {
    const c = getCategory(name);
    const color = c ? c.color : autoColor(name);
    return `
    <div class="cat-row" data-cat="${escapeHtml(name)}">
      <input type="color" class="cat-color-input" value="${color}" data-cat="${escapeHtml(name)}">
      <span class="cat-row-name">${escapeHtml(name)}</span>
      <span class="cat-row-count">${categoryCounts()[name]||0}</span>
    </div>`;
  }).join('') : '<p class="empty-note">No categories yet — add a video with a category first.</p>';
  $('categoryManagerOverlay').hidden = false;
}
$('manageCategoriesBtn') && $('manageCategoriesBtn').addEventListener('click', openCategoryManager);
$('categoryManagerClose') && $('categoryManagerClose').addEventListener('click', () => { $('categoryManagerOverlay').hidden = true; });
$('categoryManagerOverlay') && $('categoryManagerOverlay').addEventListener('click', (e) => {
  if(e.target.id === 'categoryManagerOverlay') $('categoryManagerOverlay').hidden = true;
});
$('categoryManagerList') && $('categoryManagerList').addEventListener('input', (e) => {
  if(e.target.classList.contains('cat-color-input')){
    const name = e.target.dataset.cat;
    ensureCategory(name);
    const c = getCategory(name);
    c.color = e.target.value;
    saveCategories();
    render();
  }
});

/* ---------- Bulk move to category ---------- */
function openBulkMove(){
  const names = allCategoryNames();
  $('bulkMoveCategorySelect').innerHTML = '<option value="">— Choose category —</option>' +
    names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  $('bulkMoveSubInput').value = '';
  $('bulkMoveOverlay').hidden = false;
}
$('bulkMoveCancel') && $('bulkMoveCancel').addEventListener('click', () => { $('bulkMoveOverlay').hidden = true; });
$('bulkMoveOverlay') && $('bulkMoveOverlay').addEventListener('click', (e) => {
  if(e.target.id === 'bulkMoveOverlay') $('bulkMoveOverlay').hidden = true;
});
$('bulkMoveConfirm') && $('bulkMoveConfirm').addEventListener('click', () => {
  const cat = $('bulkMoveCategorySelect').value;
  const sub = $('bulkMoveSubInput').value.trim();
  if(!cat){ showToast('Choose a category first'); return; }
  ensureCategory(cat);
  if(sub) ensureSubCategory(cat, sub);
  let moved = 0;
  videos.forEach(v => {
    if(selectedIds.has(v.id)){ v.category = cat; v.subCategory = sub; moved++; }
  });
  saveVideos();
  selectMode = false; selectedIds.clear();
  $('bulkMoveOverlay').hidden = true;
  render();
  showToast(`Moved ${moved} video${moved===1?'':'s'} to ${cat}`);
});

/* ---------- Export / Import ---------- */
$('exportBtn').addEventListener('click', () => {
  if(videos.length === 0){ showToast('Nothing to export yet'); return; }
  const payload = {
    app: 'VideoShelf',
    version: 2,
    exportedAt: new Date().toISOString(),
    categories,
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

$('importModeSelect') && $('importModeSelect').addEventListener('change', (e) => {
  importMode = e.target.value;
});

$('importInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try{
      const data = JSON.parse(reader.result);
      const incoming = Array.isArray(data) ? data : data.videos;
      if(!Array.isArray(incoming)) throw new Error('No videos array found in file');
      const incomingCats = Array.isArray(data.categories) ? data.categories : [];

      if(importMode === 'replace'){
        videos = [];
        categories = [];
      }

      const existingIds = new Set(videos.map(v => v.id));
      const existingUrls = new Set(videos.map(v => v.url));
      let added = 0, skipped = 0;

      // bring in category registry (color/subs) first so videos can reference it
      incomingCats.forEach(c => {
        if(!c || typeof c !== 'object' || !c.name) return;
        if(!getCategory(c.name)){
          categories.push({
            name: String(c.name).slice(0,40),
            color: /^#[0-9a-fA-F]{6}$/.test(c.color) ? c.color : autoColor(c.name),
            subs: Array.isArray(c.subs) ? c.subs.map(s=>String(s).slice(0,40)).slice(0,50) : []
          });
        }
      });

      incoming.forEach(raw => {
        if(!raw || typeof raw !== 'object' || !raw.url || !raw.name){ skipped++; return; }
        const videoId = raw.videoId || getVideoId(raw.url);
        if(!videoId){ skipped++; return; }
        if(existingUrls.has(raw.url)){ skipped++; return; }

        const id = (raw.id && !existingIds.has(raw.id)) ? raw.id : newId();
        existingIds.add(id);
        existingUrls.add(raw.url);

        let status = 'unwatched';
        if(raw.status === 'watched' || raw.status === 'completed') status = raw.status;
        else if(raw.watched) status = 'watched'; // legacy boolean field

        const category = raw.category ? String(raw.category).slice(0,40) : '';
        const subCategory = raw.subCategory ? String(raw.subCategory).slice(0,40) : '';
        if(category) ensureCategory(category);
        if(category && subCategory) ensureSubCategory(category, subCategory);

        videos.push({
          id, url:String(raw.url), name:String(raw.name).slice(0,120), videoId,
          category, subCategory,
          notes: raw.notes ? String(raw.notes).slice(0,500) : '',
          favorite: !!raw.favorite,
          status,
          watchedAt: Number.isFinite(raw.watchedAt) ? raw.watchedAt : (status!=='unwatched' ? Date.now() : null),
          completedAt: Number.isFinite(raw.completedAt) ? raw.completedAt : (status==='completed' ? Date.now() : null),
          createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
          order: videos.length
        });
        added++;
      });

      saveVideos();
      saveCategories();
      render();
      const modeNote = importMode === 'replace' ? ' (replaced everything)' : '';
      showToast(`Imported ${added} video${added===1?'':'s'}${skipped ? `, skipped ${skipped}` : ''}${modeNote}`);
    }catch(err){
      console.error('Import failed', err);
      showToast("Couldn't read that file — is it a VideoShelf backup?");
    }
    e.target.value = '';
  };
  reader.onerror = () => {
    showToast('Failed to read file');
    e.target.value = '';
  };
  reader.readAsText(file);
});

/* ---------- Live-updating "days ago" badges ----------
   Recomputed periodically so a card left open overnight updates without
   needing a manual refresh. Runs a lightweight re-render of just the badges,
   not the full list, to avoid disrupting scroll position or open menus. */
setInterval(() => {
  document.querySelectorAll('.video-item').forEach(item => {
    const v = videos.find(x => x.id === item.dataset.id);
    if(!v) return;
    const badge = item.querySelector('.days-badge');
    if(badge) badge.textContent = daysAgoLabel(v.createdAt);
  });
}, 60000); // check every minute; label itself only changes at day boundaries

/* ==========================================================================
   Dashboard / Progress tracking
   ========================================================================== */

/* Tab switching */
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.hidden = true);
    btn.classList.add('active');
    $(btn.dataset.tab).hidden = false;
    if(btn.dataset.tab === 'dashboardTab') renderDashboard();
  });
});

function addedOnDay(key){
  return videos.filter(v => dateKey(v.createdAt) === key);
}
function watchedOnDay(key){
  return videos.filter(v => v.watchedAt && dateKey(v.watchedAt) === key);
}
function completedOnDay(key){
  return videos.filter(v => v.completedAt && dateKey(v.completedAt) === key);
}

function renderDashboard(){
  const key = dashboardDate || todayKey();
  $('dashboardDateLabel').textContent = key === todayKey()
    ? 'Today'
    : new Date(key + 'T00:00:00').toLocaleDateString(undefined, { weekday:'long', year:'numeric', month:'short', day:'numeric' });

  // Overall totals
  const total = videos.length;
  const unwatched = videos.filter(v=>v.status==='unwatched').length;
  const watched = videos.filter(v=>v.status==='watched').length;
  const completed = videos.filter(v=>v.status==='completed').length;

  $('dashOverall').innerHTML = `
    <div class="dash-stat"><span class="dash-num">${total}</span><span class="dash-label">Total videos</span></div>
    <div class="dash-stat"><span class="dash-num">${unwatched}</span><span class="dash-label">Not watched</span></div>
    <div class="dash-stat"><span class="dash-num">${watched}</span><span class="dash-label">Watched</span></div>
    <div class="dash-stat"><span class="dash-num">${completed}</span><span class="dash-label">Completed</span></div>
  `;

  // Selected-day breakdown
  const added = addedOnDay(key);
  const wOnDay = watchedOnDay(key);
  const cOnDay = completedOnDay(key);

  $('dashDayStats').innerHTML = `
    <div class="dash-stat"><span class="dash-num">${added.length}</span><span class="dash-label">Added</span></div>
    <div class="dash-stat"><span class="dash-num">${wOnDay.length}</span><span class="dash-label">Watched</span></div>
    <div class="dash-stat"><span class="dash-num">${cOnDay.length}</span><span class="dash-label">Completed</span></div>
  `;

  const dayList = [...added.map(v=>({v,tag:'Added'})), ...wOnDay.map(v=>({v,tag:'Watched'})), ...cOnDay.map(v=>({v,tag:'Completed'}))];
  $('dashDayList').innerHTML = dayList.length
    ? dayList.map(({v,tag}) => `
      <div class="dash-day-item">
        <span class="dash-day-tag tag-${tag.toLowerCase()}">${tag}</span>
        <span class="dash-day-name">${escapeHtml(v.name)}</span>
        ${v.category ? `<span class="chip" style="--chip-color:${categoryColor(v.category)}">${escapeHtml(v.category)}</span>` : ''}
      </div>`).join('')
    : `<p class="empty-note">Nothing on this day.</p>`;

  // Per-category breakdown
  const names = allCategoryNames();
  $('dashCategoryBreakdown').innerHTML = names.length ? names.map(name => {
    const vids = videos.filter(v => v.category === name);
    const u = vids.filter(v=>v.status==='unwatched').length;
    const w = vids.filter(v=>v.status==='watched').length;
    const c = vids.filter(v=>v.status==='completed').length;
    const color = categoryColor(name);
    return `
    <div class="dash-cat-row">
      <div class="dash-cat-name"><span class="dash-cat-dot" style="background:${color}"></span>${escapeHtml(name)}</div>
      <div class="dash-cat-bar">
        ${u>0?`<span class="bar-seg bar-unwatched" style="flex:${u}"></span>`:''}
        ${w>0?`<span class="bar-seg bar-watched" style="flex:${w}"></span>`:''}
        ${c>0?`<span class="bar-seg bar-completed" style="flex:${c}"></span>`:''}
      </div>
      <div class="dash-cat-counts">${u} · ${w} · ${c}</div>
    </div>`;
  }).join('') : `<p class="empty-note">No categories yet.</p>`;

  renderCalendar(key);
}

/* Simple month calendar with dots marking activity (added/watched/completed) */
let calendarMonth = new Date();
function renderCalendar(selectedKey){
  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  $('calendarLabel').textContent = calendarMonth.toLocaleDateString(undefined, { month:'long', year:'numeric' });

  const firstDay = new Date(year, month, 1);
  const startOffset = firstDay.getDay();
  const daysInMonth = new Date(year, month+1, 0).getDate();

  let html = '';
  const dayNames = ['S','M','T','W','T','F','S'];
  html += dayNames.map(d => `<div class="cal-dow">${d}</div>`).join('');
  for(let i=0;i<startOffset;i++) html += `<div class="cal-cell empty"></div>`;

  for(let d=1; d<=daysInMonth; d++){
    const key = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const hasAdded = addedOnDay(key).length > 0;
    const hasActivity = watchedOnDay(key).length > 0 || completedOnDay(key).length > 0;
    const isToday = key === todayKey();
    const isSelected = key === selectedKey;
    html += `<button type="button" class="cal-cell ${isToday?'is-today':''} ${isSelected?'is-selected':''}" data-key="${key}">
      <span class="cal-daynum">${d}</span>
      <span class="cal-dots">${hasAdded?'<i class="dot-added"></i>':''}${hasActivity?'<i class="dot-activity"></i>':''}</span>
    </button>`;
  }
  $('calendarGrid').innerHTML = html;
}

$('calendarGrid') && $('calendarGrid').addEventListener('click', (e) => {
  const cell = e.target.closest('.cal-cell[data-key]');
  if(!cell) return;
  dashboardDate = cell.dataset.key;
  renderDashboard();
});
$('calPrevBtn') && $('calPrevBtn').addEventListener('click', () => {
  calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth()-1, 1);
  renderCalendar(dashboardDate || todayKey());
});
$('calNextBtn') && $('calNextBtn').addEventListener('click', () => {
  calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth()+1, 1);
  renderCalendar(dashboardDate || todayKey());
});
$('dashTodayBtn') && $('dashTodayBtn').addEventListener('click', () => {
  dashboardDate = null;
  calendarMonth = new Date();
  renderDashboard();
});

render();
