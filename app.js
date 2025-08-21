/* app.js — v29 */

const VERSION = "29"; // キャッシュ更新用（service-worker の ASSETS も 29 に合わせてください）

/* ======== モード設定（必要に応じて変更） ======== */
/* 男性モードは 1〜11、女性モードは 12〜21 を対象にする例 */
const MODE_RANGE = {
  male:   { min: 1,  max: 11 },
  female: { min: 12, max: 21 }
};
let currentMode = "male";

/* ======== 固定割り当て（プログラム側でロックする席） ========
   ここに書いた席は「常にこの人」で確定：
   - ルーレット対象から除外
   - 名前セレクトにも出さない（設定で切替）
   - 幹事モードでも編集・解除できない
   例：
   const FIXED_ASSIGNMENTS = { "1": "幹事A", "21": "幹事B" };
*/
const FIXED_ASSIGNMENTS = {
  "22": "池田さん",
  "23": "長尾君",
  "24": "平川さん",
  "25": "西川",
  "26": "内藤君",
  "27": "舘林さん",
  "28": "田村さん",
  "29": "佐藤真希さん"
};

/* 固定した人を名前セレクトから隠すか？ */
const HIDE_FIXED_FROM_SELECT = true;

/* ======== fetch data (names / seat layout / preset / names_by_mode) ======== */
async function loadData() {
  const [namesRes, layoutRes, presetRes, namesByModeRes] = await Promise.all([
    fetch(`./data/names.json?v=${VERSION}`).catch(()=>null),
    fetch(`./data/seat_layout.json?v=${VERSION}`),
    fetch(`./data/seat_preset.json?v=${VERSION}`).catch(() => null),
    fetch(`./data/names_by_mode.json?v=${VERSION}`).catch(() => null)
  ]);
  if (!layoutRes || !layoutRes.ok) throw new Error("seat_layout.json の読み込みに失敗しました");

  // 後方互換：names_by_mode.json があればそれを優先。なければ従来の names.json を使う
  let names = [];
  let namesByMode = null;

  if (namesByModeRes && namesByModeRes.ok) {
    try {
      namesByMode = await namesByModeRes.json(); // { male: [], female: [] }
      const maleList = Array.isArray(namesByMode.male) ? namesByMode.male : [];
      const femaleList = Array.isArray(namesByMode.female) ? namesByMode.female : [];
      names = Array.from(new Set([...maleList, ...femaleList])); // 全体集合
    } catch (_) {
      namesByMode = null;
    }
  }

  if (!namesByMode) {
    if (!namesRes || !namesRes.ok) throw new Error("names.json の読み込みに失敗しました");
    names = await namesRes.json();
  }

  const seatLayout = await layoutRes.json();
  let preset = {};
  if (presetRes && presetRes.ok) {
    try { preset = await presetRes.json(); } catch(_) {}
  }
  return { names, seatLayout, preset, namesByMode };
}

/* ======== DOM refs ======== */
const startBtn = document.getElementById('startBtn');
const stopBtn  = document.getElementById('stopBtn');
const resetBtn = document.getElementById('resetBtn');
const muteBtn  = document.getElementById('muteBtn');
const updateBtn= document.getElementById('updateBtn');
const managerBtn = document.getElementById('managerBtn');
const currentNameSel = document.getElementById('currentName');

const modeMaleBtn = document.getElementById('modeMaleBtn');
const modeFemaleBtn = document.getElementById('modeFemaleBtn');

const numberDisplay = document.getElementById('numberDisplay');
const statusDiv = document.getElementById('status');
const chipsDiv = document.getElementById('chips');
const resultsDiv = document.getElementById('results');

const drum = document.getElementById('drum');
const fanfare = document.getElementById('fanfare');

const confettiCanvas = document.getElementById('confettiCanvas');
const ctx = confettiCanvas.getContext('2d');

const revealOverlay = document.getElementById('revealOverlay');
const revealTitleEl = document.getElementById('revealTitle');
const revealNumberEl = document.getElementById('revealNumber');

const seatGrid = document.getElementById('seatGrid');

/* 幹事モードUI */
const managerOverlay = document.getElementById('managerOverlay');
const managerSeatTitle = document.getElementById('managerSeatTitle');
const managerNameSelect = document.getElementById('managerNameSelect');
const managerApplyBtn = document.getElementById('managerApplyBtn');
const managerClearBtn = document.getElementById('managerClearBtn');
const managerCloseBtn = document.getElementById('managerCloseBtn');
const managerExportBtn = document.getElementById('managerExportBtn');
const managerImportInput = document.getElementById('managerImportInput');

/* ======== state ======== */
let names = [];
let namesByMode = null;                 // { male:[], female:[] } があれば利用
let seatLayout = [];
let seatPreset = {};

let namesAssignedDraw = new Set();      // 抽選で確定済み（編集不可）
let namesAssignedPreset = new Set();    // 事前割り当てで確定済み（編集可）
let namesAssignedFixed = new Set();     // 固定で確定済み（編集不可）

let seats = [];                         // 未確定席番号（全体）
let intervalId = null;
let currentNumber = null;
let finished = false;
let muted = false;
let totalCount = 0;
let initialCount = 0;
let currentPlayer = null;
let managerMode = false;
let managerSeatNo = null;

const seatCellByNo = new Map();
const seatNameByNo = new Map();

function unionAssigned(){
  // 固定・プリセット・抽選をまとめた「確定済み集合」
  return new Set([...namesAssignedDraw, ...namesAssignedPreset, ...namesAssignedFixed]);
}

/* ======== helpers ======== */
function getAllSeatNumbers(layout){
  const nums = [];
  for (const row of layout) for (const v of row) if (typeof v === 'number') nums.push(v);
  return nums;
}
function maxCols(layout){ return Math.max(...layout.map(r => r.length)); }
function resizeCanvas(){ confettiCanvas.width = innerWidth; confettiCanvas.height = innerHeight; }
addEventListener('resize', resizeCanvas);

function isAllowedByMode(n){
  const r = MODE_RANGE[currentMode];
  return n >= r.min && n <= r.max;
}
function seatsForMode(){
  return seats.filter(isAllowedByMode);
}

/* ======== render ======== */
function renderSeatMap(layout){
  seatGrid.style.setProperty('--cols', String(maxCols(layout)));
  seatGrid.innerHTML = '';
  seatCellByNo.clear();

  for (const row of layout){
    for (let i=0; i<maxCols(layout); i++){
      const v = row[i] ?? null;
      const cell = document.createElement('div');
      cell.className = 'seat';
      if (v === null){
        cell.classList.add('is-aisle');
        cell.innerHTML = `<div class="no">—</div>`;
      } else {
        cell.dataset.no = String(v);
        cell.innerHTML = `<div class="no">${v}</div><div class="name"></div>`;
        seatCellByNo.set(v, cell);
      }
      seatGrid.appendChild(cell);
    }
  }
}

function candidatesByMode(){
  if (namesByMode && namesByMode[currentMode]) return namesByMode[currentMode];
  return names; // 従来互換：モード分け未設定なら全員
}

function renderNameSelect(){
  const assigned = unionAssigned();
  const candidates = candidatesByMode();
  let remaining = candidates.filter(n => !assigned.has(n));

  if (HIDE_FIXED_FROM_SELECT) {
    remaining = remaining.filter(n => !namesAssignedFixed.has(n)); // 固定は出さない
  }

  const prev = currentNameSel.value;
  currentNameSel.innerHTML = '';

  if (!remaining.length) {
    const opt = document.createElement('option'); opt.value=''; opt.text='（このモードは全員決定済み）';
    currentNameSel.appendChild(opt);
    return;
  }
  remaining.forEach(n => {
    const opt = document.createElement('option'); opt.value=n; opt.text=n;
    currentNameSel.appendChild(opt);
  });

  if (prev && remaining.includes(prev)) currentNameSel.value = prev;
}

function renderChips() {
  const classes = ['chip--rose','chip--pink','chip--violet','chip--sky','chip--mint','chip--amber'];
  const pool = seatsForMode();
  chipsDiv.innerHTML = pool.map((n,i) => `<span class="chip ${classes[i%classes.length]}">${n}</span>`).join('');
}

function updateStatus(){
  const poolCount = seatsForMode().length;
  const modeRemaining = candidatesByMode().filter(n=>!unionAssigned().has(n)).length;
  statusDiv.textContent = finished
    ? 'ルーレットが終了しました'
    : `残り座席 ${seats.length}（${currentMode === 'male' ? '男性' : '女性'}モード: ${poolCount}） / モード未決定の人 ${modeRemaining}`;
  renderChips();
}

/* ======== init/reset ======== */
function initFromLayout(){
  const nums = getAllSeatNumbers(seatLayout);
  seats = [...nums];
  totalCount = nums.length;
  initialCount = nums.length;
  finished = false;
  resultsDiv.innerHTML = '';
  numberDisplay.textContent = '---';
  seatNameByNo.clear();
  namesAssignedFixed.clear();

  // 全席リセット
  for (const [no, el] of seatCellByNo.entries()){
    el.classList.remove('is-taken','is-draw','is-preset','is-fixed');
    el.querySelector('.name').textContent = '';
  }

  // ★ 固定割り当てを最優先で適用（編集不可／ルーレット対象外）
  for (const [k, name] of Object.entries(FIXED_ASSIGNMENTS)){
    const no = parseInt(k,10);
    const el = seatCellByNo.get(no);
    if (!Number.isFinite(no) || !el) continue;

    seatNameByNo.set(no, name);
    el.classList.add('is-taken','is-fixed'); // 見た目：固定
    el.querySelector('.name').textContent = name;

    seats = seats.filter(n => n !== no);
    namesAssignedFixed.add(name);

    // namesリストに未登録なら補完（幹事名など）
    if (!names.includes(name)) names.push(name);
  }

  // 事前割り当て（プリセット）を適用（固定がある席はスキップ）
  namesAssignedPreset.clear();
  for (const value of Object.values(seatPreset)) {
    if (!names.includes(value)) names.push(value);
  }
  for (const [key, name] of Object.entries(seatPreset)) {
    const no = parseInt(key, 10);
    const el = seatCellByNo.get(no);
    if (!Number.isFinite(no) || !el) continue;

    if (el.classList.contains('is-fixed')) continue; // 固定優先

    seatNameByNo.set(no, name);
    el.classList.add('is-taken','is-preset');
    el.querySelector('.name').textContent = name;

    seats = seats.filter(n => n !== no);
    namesAssignedPreset.add(name);
  }

  renderNameSelect();
  updateStatus();
}

/* ======== effects ======== */
function launchConfetti(duration=1600, count=260, gold=false){
  const particles = [];
  const w = confettiCanvas.width, h = confettiCanvas.height;
  for(let i=0;i<count;i++){
    const hue = gold ? (45 + Math.random()*30) : Math.floor(Math.random()*360);
    particles.push({ x:Math.random()*w, y:-20 - Math.random()*h*0.4, r:4+Math.random()*6, vx:-1+Math.random()*2, vy:2+Math.random()*3,
      rot:Math.random()*Math.PI*2, vr:-0.3+Math.random()*0.6, color: gold ? `hsl(${hue},90%,55%)` : `hsl(${hue},85%,55%)` });
  }
  const start = performance.now(); confettiCanvas.style.display='block';
  function tick(now){
    const t = now - start;
    ctx.clearRect(0,0,w,h);
    particles.forEach(p=>{ p.x+=p.vx; p.y+=p.vy; p.rot+=p.vr; p.vy+=0.02;
      ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(p.rot); ctx.fillStyle=p.color; ctx.fillRect(-p.r,-p.r*0.6,p.r*2,p.r*1.2); ctx.restore(); });
    if (t<duration) requestAnimationFrame(tick); else { confettiCanvas.style.display='none'; }
  }
  requestAnimationFrame(tick);
}

/* ======== draw（モードに応じた席のみ対象 & 名前もモードで出し分け） ======== */
function startDraw(){
  const sel = currentNameSel.value;
  if (!sel) { alert('今回回す人を選んでください'); return; }
  if (unionAssigned().has(sel)) { alert('その方はすでに決定済みです。別の方を選んでください。'); return; }

  // 念のため：選択された名前が現モードの候補に含まれているか検証
  const modeCandidates = candidatesByMode();
  if (!modeCandidates.includes(sel)) {
    alert('この名前は現在のモードでは選択できません。モードを切り替えるか、別の方を選んでください。');
    return;
  }

  currentPlayer = sel;

  if (!seats.length && !finished) initFromLayout();
  if (finished) return;

  const pool = seatsForMode();
  if (!pool.length){
    alert(`${currentMode === 'male' ? '男性' : '女性'}モードで抽選可能な席が残っていません。`);
    return;
  }

  stopBtn.style.display='block'; startBtn.disabled=true; startBtn.style.opacity=.6; resetBtn.disabled=true; currentNameSel.disabled=true;

  if (!muted) { try { drum.currentTime=0; drum.play(); } catch(e){} }

  intervalId = setInterval(()=>{
    const p = seatsForMode(); // 抽選中に確定が進む可能性に備えて都度取り直す
    currentNumber = p[Math.floor(Math.random() * p.length)];
    numberDisplay.textContent = currentNumber ?? '---';
  }, 50);
}

function stopDraw(){
  if (!intervalId) return;
  clearInterval(intervalId); intervalId=null; drum.pause();
  if (!currentPlayer) currentPlayer = currentNameSel.value || '（名無し）';

  seats = seats.filter(n=> n!==currentNumber);     // 全体残席から除外（他モードにも効く）
  revealTitleEl.textContent = `${currentPlayer} さんは…`;
  revealNumberEl.textContent = currentNumber;
  revealOverlay.style.display='grid';
  if (!muted) { try { fanfare.currentTime=0; fanfare.play(); } catch(e){} }
  launchConfetti(1600, 260, false);
}

/* ======== overlay close ======== */
revealOverlay.addEventListener('click', ()=>{
  revealOverlay.style.display='none';
  resultsDiv.innerHTML += `<div class="result-item">→ <strong>${currentPlayer}</strong> は <strong>席番号 ${currentNumber}</strong> に決定しました。</div>`;
  numberDisplay.textContent='---';
  commitSeat(currentNumber, currentPlayer);
  finishOne();
});

/* ======== seat commit ======== */
function commitSeat(seatNo, name){
  seatNameByNo.set(seatNo, name);
  const el = seatCellByNo.get(seatNo);
  if (el){
    el.classList.add('is-taken','is-draw');
    const nameEl = el.querySelector('.name');
    if (nameEl) nameEl.textContent = name;
  }
}

/* ======== finish & reset ======== */
function finishOne(){
  stopBtn.style.display='none'; startBtn.disabled=false; startBtn.style.opacity=1; resetBtn.disabled=false;

  namesAssignedDraw.add(currentPlayer);
  currentPlayer=null; currentNameSel.disabled=false;

  renderNameSelect();
  if (seats.length===0){ finished=true; startBtn.disabled=true; stopBtn.disabled=true; }
  updateStatus();
}

function resetAll(){
  if (intervalId){ clearInterval(intervalId); intervalId=null; }
  drum.pause(); fanfare.pause();
  seats=[]; currentNumber=null; finished=false; resultsDiv.innerHTML=''; numberDisplay.textContent='---';
  startBtn.disabled=false; startBtn.style.opacity=1; stopBtn.disabled=false; stopBtn.style.display='none';

  namesAssignedDraw.clear();
  initFromLayout();
  renderNameSelect();

  revealOverlay.style.display='none';
  confettiCanvas.style.display='none';
  updateStatus();
}

function toggleMute(){ muted=!muted; muteBtn.textContent = muted ? '🔇 ミュート解除' : '🔊 サウンド'; muteBtn.setAttribute('aria-pressed', String(muted)); if (muted){ drum.pause(); fanfare.pause(); } }
async function checkUpdate(){
  if (!('serviceWorker' in navigator)) return;
  const reg = await navigator.serviceWorker.getRegistration(); if (!reg) return;
  await reg.update();
  if (reg.waiting) reg.waiting.postMessage({type:'SKIP_WAITING'});
  else if (reg.installing) reg.installing.addEventListener('statechange', ()=>{ if (reg.waiting) reg.waiting.postMessage({type:'SKIP_WAITING'}); });
}
navigator.serviceWorker.addEventListener('controllerchange', ()=> location.reload());

/* ======== 幹事モード ======== */
function setManagerMode(on){
  managerMode = on;
  document.body.classList.toggle('manager-mode', managerMode);
  managerBtn.textContent = managerMode ? '🛠 幹事モード（ON）' : '🛠 幹事モード';
}
managerBtn?.addEventListener('click', ()=> setManagerMode(!managerMode));

seatGrid.addEventListener('click', (e)=>{
  if (!managerMode) return;
  const seatEl = e.target.closest('.seat');
  if (!seatEl || seatEl.classList.contains('is-aisle')) return;

  if (seatEl.classList.contains('is-draw')) {
    alert('この席は抽選で確定済みのため編集できません。');
    return;
  }
  if (seatEl.classList.contains('is-fixed')) {
    alert('この席はプログラムで固定されています（編集不可）。');
    return;
  }
  managerSeatNo = parseInt(seatEl.dataset.no, 10);
  openManagerModal(managerSeatNo);
});

function openManagerModal(seatNo){
  managerSeatTitle.textContent = `席 ${seatNo}`;
  const assigned = unionAssigned();
  const currentName = seatPreset[seatNo] || null;

  // 幹事モード：全名簿から未決定の人を候補に（必要ならモード連動にも変更可）
  const options = [];
  if (currentName) options.push(currentName);
  names.forEach(n => {
    if (n === currentName) return;
    if (!assigned.has(n)) options.push(n);
  });

  managerNameSelect.innerHTML = '';
  if (!options.length) {
    const opt = document.createElement('option');
    opt.value = ''; opt.textContent = '（選択可能な人がいません）';
    managerNameSelect.appendChild(opt);
    managerApplyBtn.disabled = true;
  } else {
    options.forEach(n=>{
      const opt = document.createElement('option');
      opt.value = n; opt.textContent = n;
      managerNameSelect.appendChild(opt);
    });
    managerApplyBtn.disabled = false;
  }

  managerOverlay.style.display = 'grid';
}
function closeManagerModal(){
  managerOverlay.style.display = 'none';
  managerSeatNo = null;
}
managerCloseBtn?.addEventListener('click', closeManagerModal);
managerOverlay.addEventListener('click', (e)=>{ if (e.target === managerOverlay) closeManagerModal(); });

managerApplyBtn?.addEventListener('click', ()=>{
  if (managerSeatNo == null) return;
  const name = managerNameSelect.value;
  if (!name) return;

  if (namesAssignedDraw.has(name)) { alert('その方は抽選で確定済みです。'); return; }

  applyPreset(managerSeatNo, name);
  closeManagerModal();
});
managerClearBtn?.addEventListener('click', ()=>{
  if (managerSeatNo == null) return;
  clearPreset(managerSeatNo);
  closeManagerModal();
});

// 書き出し（固定席は出力しない）
managerExportBtn?.addEventListener('click', ()=>{
  const exportObj = {};
  for (const [no, name] of Object.entries(seatPreset)) {
    const el = seatCellByNo.get(parseInt(no,10));
    if (el?.classList.contains('is-fixed')) continue; // 念のため除外
    exportObj[no] = name;
  }
  const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'seat_preset.json';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
});

// 読み込み（固定 or 抽選確定の席は弾く）
managerImportInput?.addEventListener('change', async (e)=>{
  const file = e.target.files?.[0];
  if (!file) return;
  try{
    const text = await file.text();
    const json = JSON.parse(text);

    for (const [k,_v] of Object.entries(json)){
      const no = parseInt(k,10);
      const el = seatCellByNo.get(no);
      if (!el) continue;
      if (el.classList.contains('is-draw') || el.classList.contains('is-fixed')) {
        alert(`席${no}は変更できません（抽選確定 or 固定席）。`);
        return;
      }
    }

    seatPreset = json || {};
    initFromLayout();
    renderNameSelect();
    alert('プリセットを読み込みました。必要なら書き出して保存してください。');
  }catch(err){
    alert('JSONの読み込みに失敗しました。ファイル内容をご確認ください。');
    console.error(err);
  } finally {
    e.target.value = '';
  }
});

/* 幹事モード：適用/解除ロジック */
function applyPreset(seatNo, name){
  const el = seatCellByNo.get(seatNo);
  if (!el) return;
  if (el.classList.contains('is-draw') || el.classList.contains('is-fixed')) return; // 固定/抽選確定は不可

  const prev = seatPreset[seatNo];
  if (prev) namesAssignedPreset.delete(prev);

  seats = seats.filter(n => n !== seatNo);

  el.classList.add('is-taken','is-preset');
  el.querySelector('.name').textContent = name;

  seatPreset[seatNo] = name;
  seatNameByNo.set(seatNo, name);
  namesAssignedPreset.add(name);

  renderNameSelect();
  updateStatus();
}
function clearPreset(seatNo){
  const el = seatCellByNo.get(seatNo);
  if (!el) return;
  if (el.classList.contains('is-draw') || el.classList.contains('is-fixed')) return; // 固定/抽選確定は不可

  const prev = seatPreset[seatNo];
  if (prev){
    namesAssignedPreset.delete(prev);
    delete seatPreset[seatNo];
  }

  el.classList.remove('is-taken','is-preset');
  el.querySelector('.name').textContent = '';

  if (!seats.includes(seatNo)) seats.push(seatNo);
  seats.sort((a,b)=>a-b);
  seatNameByNo.delete(seatNo);

  renderNameSelect();
  updateStatus();
}

/* ======== モード切替 UI ======== */
function setMode(mode){
  if (!['male','female'].includes(mode)) return;
  currentMode = mode;

  // ボタンの見た目（選択中はghostを外す）—存在しない場合に備えてoptional chain
  modeMaleBtn?.classList.toggle('ghost', mode !== 'male');
  modeMaleBtn?.setAttribute('aria-pressed', String(mode === 'male'));
  modeFemaleBtn?.classList.toggle('ghost', mode !== 'female');
  modeFemaleBtn?.setAttribute('aria-pressed', String(mode === 'female'));

  renderNameSelect();
  updateStatus();
}
modeMaleBtn?.addEventListener('click', ()=> setMode('male'));
modeFemaleBtn?.addEventListener('click', ()=> setMode('female'));

/* ======== boot ======== */
(async function boot(){
  try{
    const data = await loadData();
    names = Array.isArray(data.names) ? data.names : [];
    namesByMode = data.namesByMode || null;
    seatLayout = Array.isArray(data.seatLayout) ? data.seatLayout : data.seat_layout || [];
    seatPreset = data.preset || {};

    renderSeatMap(seatLayout);
    renderNameSelect();
    resizeCanvas();
    initFromLayout();
    setMode('male'); // 初期は男性モード

    startBtn?.addEventListener('click', startDraw);
    stopBtn?.addEventListener('click', stopDraw);
    resetBtn?.addEventListener('click', resetAll);
    muteBtn?.addEventListener('click', toggleMute);
    updateBtn?.addEventListener('click', checkUpdate);

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./service-worker.js', { scope: './' }).then(()=> console.log('SW registered'));
    }
  } catch(e){
    alert("初期化に失敗しました: " + e.message);
    console.error(e);
  }
})();
