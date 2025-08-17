const VERSION = "24"; // キャッシュ更新用

/* ======== fetch data (names / seat layout / preset) ======== */
async function loadData() {
  const [namesRes, layoutRes, presetRes] = await Promise.all([
    fetch(`./data/names.json?v=${VERSION}`),
    fetch(`./data/seat_layout.json?v=${VERSION}`),
    fetch(`./data/seat_preset.json?v=${VERSION}`).catch(() => null)
  ]);
  if (!namesRes.ok) throw new Error("names.json の読み込みに失敗しました");
  if (!layoutRes.ok) throw new Error("seat_layout.json の読み込みに失敗しました");

  const names = await namesRes.json();
  const seatLayout = await layoutRes.json();
  let preset = {};
  if (presetRes && presetRes.ok) {
    try { preset = await presetRes.json(); } catch(_) {}
  }
  return { names, seatLayout, preset };
}

/* ======== DOM refs ======== */
const startBtn = document.getElementById('startBtn');
const stopBtn  = document.getElementById('stopBtn');
const resetBtn = document.getElementById('resetBtn');
const muteBtn  = document.getElementById('muteBtn');
const updateBtn= document.getElementById('updateBtn');
const managerBtn = document.getElementById('managerBtn');
const currentNameSel = document.getElementById('currentName');

const numberDisplay = document.getElementById('numberDisplay');
const statusDiv = document.getElementById('status');
const chipsDiv = document.getElementById('chips');
const resultsDiv = document.getElementById('results');

const drum = document.getElementById('drum');
const fanfare = document.getElementById('fanfare');
const luckyProbInput = document.getElementById('luckyProb');

const confettiCanvas = document.getElementById('confettiCanvas');
const ctx = confettiCanvas.getContext('2d');

const revealOverlay = document.getElementById('revealOverlay');
const revealTitleEl = document.getElementById('revealTitle');
const revealNumberEl = document.getElementById('revealNumber');

const luckyOverlay = document.getElementById('luckyOverlay');
const luckyTitle = document.getElementById('luckyTitle');
const seatGridOverlay = document.getElementById('seatGridOverlay');

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
let seatLayout = [];
let seatPreset = {};                     // 事前割り当て seatNo -> name

let namesAssignedDraw = new Set();       // 抽選で確定済み（編集不可）
let namesAssignedPreset = new Set();     // 事前割り当てで確定済み（編集可）
let seats = [];                          // 未確定席番号
let intervalId = null;
let currentNumber = null;
let finished = false;
let muted = false;
let totalCount = 0;
let initialCount = 0;
let currentPlayer = null;
let managerMode = false;
let managerSeatNo = null;                // 現在編集中の席番号

const seatCellByNo = new Map();
const seatNameByNo = new Map();

function unionAssigned(){ // 合成（UIのプルダウン等で使用）
  return new Set([...namesAssignedDraw, ...namesAssignedPreset]);
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
function renderNameSelect(){
  const assigned = unionAssigned();
  const remaining = names.filter(n => !assigned.has(n));
  currentNameSel.innerHTML = '';
  if (!remaining.length) {
    const opt = document.createElement('option'); opt.value=''; opt.text='（全員決定済み）';
    currentNameSel.appendChild(opt); return;
  }
  remaining.forEach(n => {
    const opt = document.createElement('option'); opt.value=n; opt.text=n;
    currentNameSel.appendChild(opt);
  });
}
function renderChips() {
  const classes = ['chip--rose','chip--pink','chip--violet','chip--sky','chip--mint','chip--amber'];
  chipsDiv.innerHTML = seats.map((n,i) => `<span class="chip ${classes[i%classes.length]}">${n}</span>`).join('');
}
function updateStatus(){
  const remainingSeats = seats.length;
  const remainingPeople = names.filter(n=>!unionAssigned().has(n)).length;
  statusDiv.textContent = finished ? 'ルーレットが終了しました' : `残り座席 ${remainingSeats} / 合計 ${totalCount}　|　未決定の人 ${remainingPeople}`;
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

  // 全席リセット
  for (const [no, el] of seatCellByNo.entries()){
    el.classList.remove('is-taken','is-draw','is-preset');
    el.querySelector('.name').textContent = '';
  }

  // 事前割り当てをリセット・反映
  namesAssignedPreset.clear();
  for (const value of Object.values(seatPreset)) {
    if (!names.includes(value)) names.push(value);
  }
  for (const [key, name] of Object.entries(seatPreset)) {
    const no = parseInt(key, 10);
    if (!Number.isFinite(no)) continue;
    const el = seatCellByNo.get(no);
    if (!el) continue;

    seatNameByNo.set(no, name);
    el.classList.add('is-taken','is-preset');
    el.querySelector('.name').textContent = name;

    // 抽選から除外 & 名前は事前確定扱い
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

/* ======== lucky & draw ======== */
function isLuckyHit(){
  const input = parseFloat(luckyProbInput.value);
  const p = (!isNaN(input) && input>=0 && input<=1) ? input : (initialCount>0 ? (1/initialCount) : 0.1);
  return Math.random() < p;
}

function startDraw(){
  const sel = currentNameSel.value;
  if (!sel) { alert('今回回す人を選んでください'); return; }
  if (unionAssigned().has(sel)) { alert('その方はすでに決定済みです。別の方を選んでください。'); return; }
  currentPlayer = sel;

  if (!seats.length && !finished) initFromLayout();
  if (finished) return;

  stopBtn.style.display='block'; startBtn.disabled=true; startBtn.style.opacity=.6; resetBtn.disabled=true; currentNameSel.disabled=true;

  if (!muted) { try { drum.currentTime=0; drum.play(); } catch(e){} }

  intervalId = setInterval(()=>{
    currentNumber = seats[Math.floor(Math.random() * seats.length)];
    numberDisplay.textContent = currentNumber;
  }, 50);
}

function stopDraw(){
  if (!intervalId) return;
  clearInterval(intervalId); intervalId=null; drum.pause();

  if (!currentPlayer) currentPlayer = currentNameSel.value || '（名無し）';

  if (seats.length>1 && isLuckyHit()) { showLuckyOverlay(); return; }

  // 通常当選
  seats = seats.filter(n=> n!==currentNumber);
  revealTitleEl.textContent = `${currentPlayer} さんは…`;
  revealNumberEl.textContent = currentNumber;
  revealOverlay.style.display='grid';
  if (!muted) { try { fanfare.currentTime=0; fanfare.play(); } catch(e){} }
  launchConfetti(1600, 260, false);
}

/* ======== lucky overlay ======== */
function showLuckyOverlay(){
  luckyTitle.textContent = `✨ ラッキー！ ${currentPlayer} さんは好きな席を選ぶことができます！ ✨`;
  seatGridOverlay.innerHTML='';
  [...seats].sort((a,b)=>a-b).forEach(n=>{
    const btn=document.createElement('button'); btn.className='seat-btn'; btn.textContent=n;
    btn.addEventListener('click', ()=> chooseLuckySeat(n), { once:true });
    seatGridOverlay.appendChild(btn);
  });
  luckyOverlay.style.display='grid';
  if (!muted) { try { fanfare.currentTime=0; fanfare.play(); } catch(e){} }
  launchConfetti(1800, 280, true);
}
function chooseLuckySeat(n){
  currentNumber = n;
  seats = seats.filter(x=> x!==n);
  luckyOverlay.style.display='none';
  resultsDiv.innerHTML += `<div class="result-item">🎉 <strong>ラッキー！</strong> <strong>${currentPlayer}</strong> さんは 好きな席 <strong>${currentNumber}</strong> を選びました！</div>`;
  numberDisplay.textContent='---';
  commitSeat(currentNumber, currentPlayer);
  finishOne();
}

/* ======== normal overlay close ======== */
revealOverlay.addEventListener('click', ()=>{
  revealOverlay.style.display='none';
  resultsDiv.innerHTML += `<div class="result-item">→ <strong>${currentPlayer}</strong> さんは <strong>席番号 ${currentNumber}</strong> に決定しました。</div>`;
  numberDisplay.textContent='---';
  commitSeat(currentNumber, currentPlayer);
  finishOne();
});

/* ======== seat commit (抽選確定) ======== */
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
  currentPlayer=null; renderNameSelect(); currentNameSel.disabled=false;

  if (seats.length===0){ finished=true; startBtn.disabled=true; stopBtn.disabled=true; }
  updateStatus();
}

function resetAll(){
  if (intervalId){ clearInterval(intervalId); intervalId=null; }
  drum.pause(); fanfare.pause();
  seats=[]; currentNumber=null; finished=false; resultsDiv.innerHTML=''; numberDisplay.textContent='---';
  startBtn.disabled=false; startBtn.style.opacity=1; stopBtn.disabled=false; stopBtn.style.display='none';

  namesAssignedDraw.clear();
  initFromLayout(); // ← ここでpreset再適用＆namesAssignedPreset再構築
  renderNameSelect();

  revealOverlay.style.display='none'; luckyOverlay.style.display='none';
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
managerBtn.addEventListener('click', ()=> setManagerMode(!managerMode));

// 座席セルをクリックで編集（抽選確定済みは不可）
seatGrid.addEventListener('click', (e)=>{
  if (!managerMode) return;
  const seatEl = e.target.closest('.seat');
  if (!seatEl || seatEl.classList.contains('is-aisle')) return;

  if (seatEl.classList.contains('is-draw')) {
    alert('この席は抽選で確定済みのため編集できません。');
    return;
  }
  managerSeatNo = parseInt(seatEl.dataset.no, 10);
  openManagerModal(managerSeatNo);
});

function openManagerModal(seatNo){
  managerSeatTitle.textContent = `席 ${seatNo}`;
  // 選択肢を作成：未決定の人 + 現在この席に割当済の人（あれば先頭に）
  const assigned = unionAssigned();
  const currentName = seatPreset[seatNo] || null;

  const options = [];
  if (currentName) {
    options.push(currentName); // 先頭に現在名
  }
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
managerCloseBtn.addEventListener('click', closeManagerModal);
managerOverlay.addEventListener('click', (e)=>{ if (e.target === managerOverlay) closeManagerModal(); });

managerApplyBtn.addEventListener('click', ()=>{
  if (managerSeatNo == null) return;
  const name = managerNameSelect.value;
  if (!name) return;

  // その名前が抽選で確定済みなら不可
  if (namesAssignedDraw.has(name)) { alert('その方は抽選で確定済みです。'); return; }

  applyPreset(managerSeatNo, name);
  closeManagerModal();
});

managerClearBtn.addEventListener('click', ()=>{
  if (managerSeatNo == null) return;
  clearPreset(managerSeatNo);
  closeManagerModal();
});

// 書き出し（seat_preset.json ダウンロード）
managerExportBtn.addEventListener('click', ()=>{
  const blob = new Blob([JSON.stringify(seatPreset, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'seat_preset.json';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
});

// 読み込み（seat_preset.json インポート）
managerImportInput.addEventListener('change', async (e)=>{
  const file = e.target.files?.[0];
  if (!file) return;
  try{
    const text = await file.text();
    const json = JSON.parse(text);

    // すでに抽選で確定している席が含まれていないか軽くチェック
    for (const [k,v] of Object.entries(json)){
      const no = parseInt(k,10);
      const el = seatCellByNo.get(no);
      if (el && el.classList.contains('is-draw')) {
        alert(`席${no}は抽選で確定済みのため、インポートからは変更できません。`);
        return;
      }
    }

    seatPreset = json || {};
    initFromLayout();     // プリセット再適用（抽選結果は維持：namesAssignedDrawはクリアしない）
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
  if (el.classList.contains('is-draw')) return; // 抽選確定席は不可

  // 既存のプリセットがあれば一旦解除
  const prev = seatPreset[seatNo];
  if (prev) namesAssignedPreset.delete(prev);

  // もしこの席が抽選対象に戻っていたら、プリセットで再度除外
  seats = seats.filter(n => n !== seatNo);

  // UI更新
  el.classList.add('is-taken','is-preset');
  el.querySelector('.name').textContent = name;

  // 状態更新
  seatPreset[seatNo] = name;
  seatNameByNo.set(seatNo, name);
  namesAssignedPreset.add(name);

  renderNameSelect();
  updateStatus();
}

function clearPreset(seatNo){
  const el = seatCellByNo.get(seatNo);
  if (!el) return;
  if (el.classList.contains('is-draw')) return; // 抽選確定席は不可

  const prev = seatPreset[seatNo];
  if (prev){
    namesAssignedPreset.delete(prev);
    delete seatPreset[seatNo];
  }

  // UI更新：見た目を空席に戻す
  el.classList.remove('is-taken','is-preset');
  el.querySelector('.name').textContent = '';

  // 状態更新：抽選対象へ復帰（重複追加防止）
  if (!seats.includes(seatNo)) seats.push(seatNo);
  seats.sort((a,b)=>a-b);
  seatNameByNo.delete(seatNo);

  renderNameSelect();
  updateStatus();
}

/* ======== boot ======== */
(async function boot(){
  try{
    const data = await loadData();
    names = Array.isArray(data.names) ? data.names : [];
    seatLayout = Array.isArray(data.seatLayout) ? data.seatLayout : data.seat_layout || [];
    seatPreset = data.preset || {};

    renderSeatMap(seatLayout);
    renderNameSelect();
    resizeCanvas();
    initFromLayout();

    startBtn.addEventListener('click', startDraw);
    stopBtn.addEventListener('click', stopDraw);
    resetBtn.addEventListener('click', resetAll);
    muteBtn.addEventListener('click', toggleMute);
    updateBtn.addEventListener('click', checkUpdate);

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./service-worker.js', { scope: './' }).then(()=> console.log('SW registered'));
    }
  } catch(e){
    alert("初期化に失敗しました: " + e.message);
    console.error(e);
  }
})();
