const VERSION = "21"; // キャッシュ更新用（JSON/CSS/JSの ?v= に合わせる）

/* ======== fetch data (names & seat layout) ======== */
async function loadData() {
  const [namesRes, layoutRes] = await Promise.all([
    fetch(`./data/names.json?v=${VERSION}`),
    fetch(`./data/seat_layout.json?v=${VERSION}`),
  ]);
  if (!namesRes.ok) throw new Error("names.json の読み込みに失敗しました");
  if (!layoutRes.ok) throw new Error("seat_layout.json の読み込みに失敗しました");

  const names = await namesRes.json();
  const seatLayout = await layoutRes.json();
  return { names, seatLayout };
}

/* ======== DOM refs ======== */
const startBtn = document.getElementById('startBtn');
const stopBtn  = document.getElementById('stopBtn');
const resetBtn = document.getElementById('resetBtn');
const muteBtn  = document.getElementById('muteBtn');
const updateBtn= document.getElementById('updateBtn');
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

/* ======== state ======== */
let names = [];
let seatLayout = [];
let namesAssigned = new Set();        // 決定済みの参加者名
let seats = [];                       // 未確定の席番号リスト
let intervalId = null;
let currentNumber = null;
let finished = false;
let muted = false;
let totalCount = 0;
let initialCount = 0;
let currentPlayer = null;
const seatCellByNo = new Map();       // seatNo -> HTMLElement
const seatNameByNo = new Map();       // seatNo -> assigned name

/* ======== helpers ======== */
function getAllSeatNumbers(layout){
  const nums = [];
  for (const row of layout) for (const v of row) if (typeof v === 'number') nums.push(v);
  return nums;
}
function maxCols(layout){
  return Math.max(...layout.map(r => r.length));
}
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
  const remaining = names.filter(n => !namesAssigned.has(n));
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
  const remainingPeople = names.filter(n=>!namesAssigned.has(n)).length;
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
  for (const [no, el] of seatCellByNo.entries()){
    el.classList.remove('is-taken');
    el.querySelector('.name').textContent = '';
  }
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
  if (namesAssigned.has(sel)) { alert('その方はすでに決定済みです。別の方を選んでください。'); return; }
  currentPlayer = sel;

  if (!seats.length && !finished) {
    initFromLayout();
  }
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

/* ======== seat commit ======== */
function commitSeat(seatNo, name){
  seatNameByNo.set(seatNo, name);
  const el = seatCellByNo.get(seatNo);
  if (el){
    el.classList.add('is-taken');
    const nameEl = el.querySelector('.name');
    if (nameEl) nameEl.textContent = name;
  }
}

/* ======== finish & reset ======== */
function finishOne(){
  stopBtn.style.display='none'; startBtn.disabled=false; startBtn.style.opacity=1; resetBtn.disabled=false;
  namesAssigned.add(currentPlayer); currentPlayer=null; renderNameSelect(); currentNameSel.disabled=false;
  if (seats.length===0){ finished=true; startBtn.disabled=true; stopBtn.disabled=true; }
  updateStatus();
}

function resetAll(){
  if (intervalId){ clearInterval(intervalId); intervalId=null; }
  drum.pause(); fanfare.pause();
  seats=[]; currentNumber=null; finished=false; resultsDiv.innerHTML=''; numberDisplay.textContent='---';
  startBtn.disabled=false; startBtn.style.opacity=1; stopBtn.disabled=false; stopBtn.style.display='none';
  namesAssigned.clear(); renderNameSelect();
  initFromLayout();
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

/* ======== boot ======== */
(async function boot(){
  try{
    const data = await loadData();
    names = Array.isArray(data.names) ? data.names : [];
    seatLayout = Array.isArray(data.seatLayout) ? data.seatLayout : data.seat_layout || [];

    // render
    renderSeatMap(seatLayout);
    renderNameSelect();
    resizeCanvas();
    initFromLayout();

    // events
    startBtn.addEventListener('click', startDraw);
    stopBtn.addEventListener('click', stopDraw);
    resetBtn.addEventListener('click', resetAll);
    muteBtn.addEventListener('click', toggleMute);
    updateBtn.addEventListener('click', checkUpdate);

    // SW
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./service-worker.js', { scope: './' }).then(()=> console.log('SW registered'));
    }
  } catch(e){
    alert("初期化に失敗しました: " + e.message);
    console.error(e);
  }
})();
