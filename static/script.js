// ============================================================
// Smart Bath Guard - 프론트엔드 메인 스크립트
// ============================================================

const POLL_MS = 1000;

// ── 상태 메모 ─────────────────────────────────────────────
let prevFallState   = false;
let currentTab      = 'canvas';
let radarChart      = null;
let scanDataStore   = {};   // 스캔 완료 후 저장
let currentScanAng  = null;
let latestSnapshot  = {};
let currentTrackId  = 1;  // 기본 트랙 = 배경 음악
let alertBeepCount  = 0;
let alertBeepTimer  = null;

// ── 상태 맵 ───────────────────────────────────────────────
const STATUS_MAP = {
  "정상":      { cls: "s-normal",  icon: "✅", badge: "lbadge-ok",   tag: "tag-ok"   },
  "낙상 의심": { cls: "s-warning", icon: "⚠️", badge: "lbadge-warn", tag: "tag-warn" },
  "낙상 감지": { cls: "s-fall",    icon: "🆘", badge: "lbadge-fall", tag: "tag-fall" },
  "보호자 알림":{ cls: "s-fall",   icon: "📱", badge: "lbadge-fall", tag: "tag-fall" },
  "장시간 체류":{ cls: "s-warning", icon: "⏱", badge: "lbadge-warn", tag: "tag-warn" },
  "센서 오류": { cls: "s-error",   icon: "❌", badge: "lbadge-err",  tag: ""         },
};

// ── 세션 만료 리다이렉트 ──────────────────────────────────
function redirectLogin() {
  const base = window.location.pathname.replace(/\/?$/, "/");
  window.location.href = base + "login";
}

// ── 안전 fetch (401 → 자동 로그인 이동) ──────────────────
async function apiFetch(url, opts = {}) {
  const res = await fetch(url, opts);
  if (res.status === 401) { redirectLogin(); return null; }
  return res;
}


// ════════════════════════════════════════════════════════
// 1. 최신 데이터 폴링 + UI 갱신
// ════════════════════════════════════════════════════════
async function fetchLatest() {
  try {
    const res = await apiFetch("api/latest");
    if (!res) return;
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    latestSnapshot = data;

    setBadge("bdgConn", "ok", '<span class="dot-blink" style="background:var(--green)"></span> 연결됨');
    updateHero(data);
    updateMetrics(data);
    updateSensorCards(data);
    updateScanUI(data.scan_state);
    updateAudioUI(data.audio_state);
    updateSmartBadges(data);
    updateOccupancyBadge(data);
    updateFallResponseUI(data);
    updateSystemState(data);
    updateConnBar(data.connection);
    drawBathroomCanvas(data);
    updateRadarChart(data.scan_state?.scan_data || {});
  } catch (e) {
    setBadge("bdgConn", "err", '<span class="dot-blink" style="background:var(--red)"></span> 오류');
    console.error("[fetchLatest]", e);
  }
}

// ── 스마트 배지 ────────────────────────────────────────────
function updateSmartBadges(data) {
  // Environment Learned
  const env = document.getElementById("bdgEnv");
  if (data.scan_state?.completed) {
    env.textContent = "✅ Environment Learned";
    env.style.opacity = "1";
  } else if (data.scan_state?.scanning) {
    env.textContent = `🔍 스캔 중 ${data.scan_state.progress}%`;
    env.style.opacity = "1";
  } else {
    env.textContent = "📊 Scan Needed";
    env.style.opacity = "0.6";
  }
}

// ── 입퇴실 상태 배지 ──────────────────────────────────────
function updateOccupancyBadge(data) {
  const el = document.getElementById("bdgOcc");
  if (!el) return;
  const state = data.occupancy_state || "empty";
  const labels = {
    empty:     "🏠 Bathroom Empty",
    occupied:  "🚶 Bathroom Occupied",
    long_stay: "⚠️ Care Mode Active"
  };
  el.textContent = labels[state] || "🏠 Bathroom Empty";
  el.className = `sbadge sbadge-occ occ-${state}`;
}

function setBadge(id, cls, html) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = `sbadge sbadge-conn ${cls}`;
  el.innerHTML = html;
}


// ── 히어로 섹션 ────────────────────────────────────────────
function updateHero(data) {
  const hero   = document.getElementById("statusHero");
  const icon   = document.getElementById("heroIcon");
  const status = document.getElementById("heroStatus");
  const time   = document.getElementById("lastUpdate");
  const extra  = document.getElementById("heroExtra");

  const info = STATUS_MAP[data.status] || STATUS_MAP["센서 오류"];
  hero.className   = `status-hero ${info.cls}`;
  icon.textContent = info.icon;
  status.textContent = data.status || "데이터 없음";
  time.textContent = new Date().toLocaleTimeString("ko-KR");

  // 추가 메시지
  const occMap = { empty: "욕실 비어있음", occupied: "욕실 사용 중", long_stay: "장시간 체류 감지" };
  const occLabel = occMap[data.occupancy_state] || "";
  if (data.status === "낙상 감지") {
    const doorCtx = data.door === "closed" ? " · 문 닫힘 (낙상 신뢰도↑)" : "";
    extra.textContent = `보호자 알림 발송됨${doorCtx}`;
  } else if (data.status === "낙상 의심") {
    extra.textContent = `높이 ${disp(data.height,"cm")} / 각도 ${disp(data.angle,"°")} — ${occLabel || "모니터링 중"}`;
  } else if (data.status === "장시간 체류") {
    extra.textContent = `30분 이상 감지 · 문 ${data.door==="closed"?"닫힘":"열림"} · mmWave: ${data.mmwave?"감지":"없음"}`;
  } else if (data.height) {
    extra.textContent = `높이 ${disp(data.height,"cm")} · 각도 ${disp(data.angle,"°")} · ${occLabel || `ToF: ${data.tof_status||"-"}`}`;
  } else {
    extra.textContent = "센서 데이터 대기 중…";
  }

  // 낙상 감지 특수 처리
  if (data.fall_detected && !prevFallState) triggerFallAlert();
  if (!data.fall_detected && prevFallState) clearFallAlert();
  prevFallState = !!data.fall_detected;
}


// ── 지표 카드 ──────────────────────────────────────────────
function updateMetrics(data) {
  setText("mcHeight", disp(data.height,"cm"), mcCls(data.height, data));
  setText("mcAngle",  disp(data.angle,"°"),   "");
  const mm = data.mmwave;
  setText("mcPerson", mm ? "감지됨" : (mm===false ? "없음" : "-"),
          mm ? "mc-warn" : "mc-ok");
  const door = data.door;
  const occ  = data.occupancy_state || "empty";
  setText("mcDoor",
    door==="open" ? "열림" : door==="closed" ? "닫힘" : disp(door),
    door==="open" ? "mc-warn" : "mc-ok");

  // 문 아이콘 (열림 = glow 효과)
  const dIcon = document.getElementById("mcDoorIcon");
  if (dIcon) {
    dIcon.textContent = door === "open" ? "🔓" : "🚪";
    dIcon.style.filter = door === "open"
      ? "drop-shadow(0 0 6px rgba(0,212,255,.8))"
      : door === "closed" && occ === "occupied"
        ? "drop-shadow(0 0 5px rgba(0,255,136,.6))"
        : "";
  }

  // 입퇴실 상태 서브 라벨
  const occEl = document.getElementById("mcOccLbl");
  if (occEl) {
    const occText = { empty: "비어있음", occupied: "사용 중", long_stay: "장시간 체류!" };
    const occCls  = occ === "occupied" ? "mc-ok" : occ === "long_stay" ? "mc-warn" : "";
    occEl.textContent = occText[occ] || "";
    occEl.className = `mc-occ-lbl ${occCls}`;
  }

  // 플래시 애니메이션
  ["mc-height","mc-angle","mc-person","mc-door"].forEach(id => flash(id));
}

function mcCls(height, data) {
  if (data.fall_detected)  return "mc-err";
  if (data.fall_candidate) return "mc-warn";
  return "";
}

// ── 센서 상세 카드 ─────────────────────────────────────────
function updateSensorCards(data) {
  const tofCls = data.tof_status==="error"  ? "sc-err"  :
                 data.tof_status==="low"    ? "sc-warn" :
                 data.tof_status==="normal" ? "sc-ok"   : "sc-dim";

  const entries = [
    ["scHeight",  disp(data.height,""),    data.fall_detected?"sc-err":data.fall_candidate?"sc-warn":""],
    ["scAngle",   disp(data.angle,""),     ""],
    ["scTof",     disp(data.tof_status),   tofCls],
    ["scMmwave",  data.mmwave?"감지됨":"없음",    data.mmwave?"sc-warn":"sc-ok"],
    ["scDoor",    data.door==="open"?"열림":data.door==="closed"?"닫힘":disp(data.door),
                  data.door==="open"?"sc-warn":"sc-ok"],
    ["scFallC",   data.fall_candidate?"의심됨":"없음",  data.fall_candidate?"sc-warn":"sc-ok"],
    ["scFallD",   data.fall_detected?"낙상!":"없음",     data.fall_detected?"sc-err":"sc-ok"],
    ["scServo",   disp(data.servo_status), data.servo_status==="alert"?"sc-err":
                                           data.servo_status==="checking"?"sc-warn":"sc-ok"],
  ];

  entries.forEach(([id, val, cls]) => {
    setText(id, val, cls);
    flash(id.replace("sc","sc"));  // flash parent scard
  });
  // Flash scard parents
  for (let i=0;i<8;i++) flash(`sc${i}`);
}


// ════════════════════════════════════════════════════════
// 2. 로그 폴링
// ════════════════════════════════════════════════════════
async function fetchLogs() {
  try {
    const res = await apiFetch("api/logs");
    if (!res || !res.ok) return;
    const logs = await res.json();
    renderLogs(logs);
  } catch(e) { console.error("[fetchLogs]", e); }
}

function renderLogs(logs) {
  const cnt  = document.getElementById("logCnt");
  const body = document.getElementById("logBody");
  cnt.textContent = `${logs.length}개`;

  if (!logs.length) {
    body.innerHTML = `<tr><td colspan="8" class="no-data">데이터 없음 — 테스트 버튼을 눌러보세요</td></tr>`;
    return;
  }

  body.innerHTML = logs.map(l => {
    const info = STATUS_MAP[l.status] || STATUS_MAP["센서 오류"];
    const mm   = l.mmwave===true?"감지됨":l.mmwave===false?"없음":"-";
    const door = l.door==="open"?"열림":l.door==="closed"?"닫힘":(l.door||"-");
    return `<tr>
      <td style="white-space:nowrap;color:var(--txt3)">${l.timestamp||"-"}</td>
      <td><span class="lbadge ${info.badge}">${l.status||"-"}</span></td>
      <td>${disp(l.height,"cm")}</td>
      <td>${disp(l.angle,"°")}</td>
      <td>${disp(l.tof_status)}</td>
      <td>${mm}</td>
      <td>${door}</td>
      <td>${disp(l.servo_status)}</td>
    </tr>`;
  }).join("");
}


// ════════════════════════════════════════════════════════
// 3. 욕실 Canvas 맵 드로잉
// ════════════════════════════════════════════════════════
function servoRad(angle) {
  // 서보 90° = 캔버스 위 방향 (270°)
  // 공식: (360 - servo) * π/180
  return (360 - angle) * Math.PI / 180;
}

function drawBathroomCanvas(data) {
  const canvas = document.getElementById("bathroomCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H - 22;
  const SCALE = 1.05;  // 1cm → 1.05px

  // 배경
  ctx.fillStyle = "#060e1f";
  ctx.fillRect(0, 0, W, H);

  // 거리 링
  [60, 100, 150].forEach(d => {
    const r = d * SCALE;
    ctx.beginPath();
    ctx.arc(cx, cy, r, servoRad(140), servoRad(35), false);
    ctx.strokeStyle = "rgba(0,212,255,0.1)";
    ctx.lineWidth = 1;
    ctx.stroke();
    // 거리 레이블
    ctx.fillStyle = "rgba(100,116,139,0.55)";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`${d}`, cx, cy - r + 10);
  });

  // 스캔 데이터 채우기
  const sd = data.scan_state?.scan_data || scanDataStore;
  const angKeys = Object.keys(sd).map(Number).sort((a,b)=>a-b);

  if (angKeys.length > 1) {
    // 채운 영역
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    angKeys.forEach(a => {
      const d = Math.min(parseFloat(sd[a]) * SCALE, 195);
      const r = servoRad(a);
      ctx.lineTo(cx + d * Math.cos(r), cy + d * Math.sin(r));
    });
    ctx.closePath();
    ctx.fillStyle = "rgba(0,212,255,0.06)";
    ctx.fill();

    // 외곽선
    ctx.beginPath();
    ctx.moveTo(cx + Math.min(parseFloat(sd[angKeys[0]])*SCALE,195)*Math.cos(servoRad(angKeys[0])),
               cy + Math.min(parseFloat(sd[angKeys[0]])*SCALE,195)*Math.sin(servoRad(angKeys[0])));
    angKeys.forEach(a => {
      const d = Math.min(parseFloat(sd[a])*SCALE, 195);
      const r = servoRad(a);
      ctx.lineTo(cx + d*Math.cos(r), cy + d*Math.sin(r));
    });
    ctx.strokeStyle = "rgba(0,212,255,0.3)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // 끝점 dot
    angKeys.forEach(a => {
      const d = Math.min(parseFloat(sd[a])*SCALE, 195);
      const r = servoRad(a);
      ctx.beginPath();
      ctx.arc(cx + d*Math.cos(r), cy + d*Math.sin(r), 2.5, 0, Math.PI*2);
      ctx.fillStyle = "rgba(0,212,255,0.6)";
      ctx.fill();
    });
  }

  // 현재 스캔 각도 (노란 점선)
  const scanAng = data.scan_state?.scanning ? data.scan_state.current_angle : null;
  if (scanAng && scanAng >= 35 && scanAng <= 140) {
    const r = servoRad(scanAng);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + 195*Math.cos(r), cy + 195*Math.sin(r));
    ctx.strokeStyle = "rgba(255,183,0,0.75)";
    ctx.lineWidth = 2;
    ctx.setLineDash([6,3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 사람 감지 위치 (빨간 원)
  if (data.mmwave && data.angle >= 35 && data.angle <= 140 && data.height) {
    const dist = Math.min(data.height * SCALE, 185);
    const r    = servoRad(data.angle);
    const px   = cx + dist * Math.cos(r);
    const py   = cy + dist * Math.sin(r);

    // 글로우
    const grd = ctx.createRadialGradient(px, py, 0, px, py, 22);
    grd.addColorStop(0, "rgba(255,45,85,0.5)");
    grd.addColorStop(1, "rgba(255,45,85,0)");
    ctx.beginPath();
    ctx.arc(px, py, 22, 0, Math.PI*2);
    ctx.fillStyle = grd;
    ctx.fill();

    // 사람 점
    ctx.beginPath();
    ctx.arc(px, py, 7, 0, Math.PI*2);
    ctx.fillStyle = "#ff2d55";
    ctx.shadowColor = "#ff2d55";
    ctx.shadowBlur = 12;
    ctx.fill();
    ctx.shadowBlur = 0;

    // 사람 아이콘 텍스트
    ctx.fillStyle = "#fff";
    ctx.font = "bold 9px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("👤", px, py - 14);
  }

  // 센서 위치
  ctx.beginPath();
  ctx.arc(cx, cy, 7, 0, Math.PI*2);
  ctx.fillStyle = "#00d4ff";
  ctx.shadowColor = "#00d4ff";
  ctx.shadowBlur = 14;
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.fillStyle = "rgba(100,116,139,0.7)";
  ctx.font = "9px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("SENSOR", cx, cy + 16);

  // 문 상태 + 입퇴실 오버레이 (우상단)
  const doorOpen = data.door === "open";
  const occState = data.occupancy_state || "empty";

  ctx.textAlign = "right";
  ctx.font = "bold 9px monospace";
  ctx.fillStyle = doorOpen ? "rgba(0,212,255,0.9)" : "rgba(71,85,105,0.65)";
  ctx.fillText((doorOpen ? "🔓 OPEN" : "🚪 CLOSED"), W - 6, 16);

  const occColor = occState === "occupied"  ? "rgba(0,255,136,0.85)"  :
                   occState === "long_stay" ? "rgba(255,183,0,0.95)"  :
                                              "rgba(71,85,105,0.5)";
  const occText  = occState === "occupied"  ? "● Occupied" :
                   occState === "long_stay" ? "⚠ Long Stay" :
                                              "○ Empty";
  ctx.fillStyle = occColor;
  ctx.font = "bold 9px sans-serif";
  ctx.fillText(occText, W - 6, 30);
}


// ════════════════════════════════════════════════════════
// 4. Radar Chart (Chart.js)
// ════════════════════════════════════════════════════════
function initRadarChart() {
  const ctx = document.getElementById("radarChart");
  if (!ctx) return;
  radarChart = new Chart(ctx, {
    type: "radar",
    data: {
      labels: ["35°","50°","65°","80°","95°","110°","125°","140°"],
      datasets: [
        {
          label: "기준 거리 (cm)",
          data: new Array(8).fill(0),
          fill: true,
          backgroundColor: "rgba(0,212,255,0.08)",
          borderColor: "rgba(0,212,255,0.6)",
          pointBackgroundColor: "#00d4ff",
          pointRadius: 4,
        },
        {
          label: "현재 감지",
          data: new Array(8).fill(0),
          fill: true,
          backgroundColor: "rgba(255,45,85,0.08)",
          borderColor: "rgba(255,45,85,0.5)",
          pointBackgroundColor: "#ff2d55",
          pointRadius: 4,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      scales: {
        r: {
          min: 0, max: 200,
          ticks:       { color: "#475569", stepSize: 50, backdropColor: "transparent" },
          grid:        { color: "rgba(26,46,74,0.8)" },
          angleLines:  { color: "rgba(26,46,74,0.6)" },
          pointLabels: { color: "#94a3b8", font: { size: 11 } },
        }
      },
      plugins: {
        legend: { labels: { color: "#94a3b8", font: { size: 11 } } }
      },
      animation: { duration: 400 }
    }
  });
}

const RADAR_ANGLES = [35, 50, 65, 80, 95, 110, 125, 140];

function updateRadarChart(scanData) {
  if (!radarChart) return;
  const baseLine = RADAR_ANGLES.map(a => parseFloat(scanData[String(a)]) || 0);
  radarChart.data.datasets[0].data = baseLine;

  // 현재 감지 포인트 (현재 각도 기준)
  const cur = latestSnapshot;
  if (cur.angle && cur.height) {
    const curData = RADAR_ANGLES.map(a =>
      Math.abs(a - cur.angle) < 8 ? cur.height : 0
    );
    radarChart.data.datasets[1].data = curData;
  }
  radarChart.update("none");
}


// ════════════════════════════════════════════════════════
// 5. 환경 스캔 UI
// ════════════════════════════════════════════════════════
function updateScanUI(scanState) {
  if (!scanState) return;
  const btn      = document.getElementById("scanBtn");
  const progress = document.getElementById("scanProgress");
  const done     = document.getElementById("scanDone");
  const tag      = document.getElementById("scanTag");
  const mapTag   = document.getElementById("mapEnvTag");

  if (scanState.scanning) {
    btn.disabled = true;
    btn.textContent = `🔄 스캔 중… ${scanState.progress}%`;
    progress.style.display = "block";
    done.style.display     = "none";
    document.getElementById("spAngle").textContent = scanState.current_angle;
    document.getElementById("spPct").textContent   = `${scanState.progress}%`;
    document.getElementById("pbarFill").style.width = `${scanState.progress}%`;
    tag.textContent = "스캔 중";
    tag.className   = "tag tag-scan";
    currentScanAng  = scanState.current_angle;
  } else if (scanState.completed) {
    btn.disabled = false;
    btn.textContent = "🔄 재스캔";
    progress.style.display = "none";
    done.style.display     = "block";
    tag.textContent = "완료";
    tag.className   = "tag tag-ok";
    mapTag.textContent = "✅ 학습 완료";
    mapTag.className   = "tag tag-ok";
    scanDataStore = { ...scanState.scan_data };
    renderScanPreview(scanState.scan_data);
    currentScanAng = null;
  } else {
    btn.disabled = false;
    btn.textContent = "🔍 환경 스캔 시작";
    progress.style.display = "none";
    tag.textContent = "대기";
    tag.className   = "tag";
  }
}

function renderScanPreview(sd) {
  const el = document.getElementById("scanPreview");
  if (!el || !sd) return;
  const angles = Object.keys(sd).map(Number).sort((a,b)=>a-b);
  el.innerHTML = angles.map(a =>
    `<div class="sp-chip">${a}° → <span>${sd[a]}cm</span></div>`
  ).join("");
}

async function startScan() {
  const res = await apiFetch("start-scan", { method: "POST" });
  if (!res) return;
  if (!res.ok) {
    const d = await res.json();
    alert(d.message || "스캔 시작 실패");
  }
}


// ════════════════════════════════════════════════════════
// 6. DFPlayer Mini 오디오 UI
// ════════════════════════════════════════════════════════

// 트랙 번호 → 표시 정보
const TRACK_INFO = {
  0: { file: "-",         name: "없음",                           icon: "🎵" },
  1: { file: "0001.mp3",  name: "평상시 배경 음악",               icon: "🎵" },
  2: { file: "0002.mp3",  name: "경고음",                         icon: "🚨" },
  3: { file: "0003.mp3",  name: "낙상이 감지되었습니다.",          icon: "🆘" },
  4: { file: "0004.mp3",  name: "괜찮으십니까?",                  icon: "💬" },
  5: { file: "0005.mp3",  name: "응답이 없으면 보호자에게 알림을…", icon: "📢" },
};

// 모드 → 태그 스타일
const MODE_TAG = {
  idle:    { text: "■ 정지",    cls: "tag"          },
  music:   { text: "▶ 재생 중", cls: "tag tag-scan"  },
  warning: { text: "⚠ 의심 경보", cls: "tag tag-warn" },
  fall:    { text: "🆘 낙상 경보", cls: "tag tag-fall" },
  voice:   { text: "💬 음성 안내", cls: "tag tag-scan" },
};

function updateAudioUI(as) {
  if (!as) return;
  const tag    = document.getElementById("audioTag");
  const npName = document.getElementById("npName");
  const npFile = document.getElementById("npFile");
  const npIcon = document.getElementById("npIcon");
  const eqBars = document.getElementById("eqBars");

  const info  = TRACK_INFO[as.current_track] || TRACK_INFO[0];
  const mTag  = MODE_TAG[as.mode]            || MODE_TAG["idle"];

  npName.textContent   = info.name;
  npFile.textContent   = as.playing ? info.file : "SD카드 대기 중";
  npIcon.textContent   = info.icon;
  eqBars.style.display = as.playing ? "flex" : "none";
  tag.textContent      = mTag.text;
  tag.className        = mTag.cls;

  // SD카드 트랙 행 하이라이트 (현재 재생 중인 파일 강조)
  for (let i = 1; i <= 5; i++) {
    const row = document.getElementById(`sdr${i}`);
    if (row) row.classList.toggle("sd-row-active", as.playing && as.current_track === i);
  }

  // 볼륨 동기화 (드래그 중이 아닐 때만)
  const slider = document.getElementById("volSlider");
  if (slider && !slider.matches(":active") && Math.abs(parseInt(slider.value) - as.volume) > 1) {
    slider.value = as.volume;
  }
  const volNum = document.getElementById("volNum");
  if (volNum) volNum.textContent = as.volume;
}

// ── 오디오 제어 함수 ──────────────────────────────────────

async function playMusic() {
  // 평상시 배경 음악 재생 (0001.mp3)
  const res = await apiFetch("audio/play_music", { method: "POST" });
  if (res) fetchLatest();
}

async function stopAudio() {
  // 재생 정지
  const res = await apiFetch("audio/stop", { method: "POST" });
  if (res) fetchLatest();
}

async function testWarning() {
  // 경고음 테스트 (0002.mp3)
  const res = await apiFetch("audio/warning", { method: "POST" });
  if (res) fetchLatest();
}

async function testVoice() {
  // 음성 안내 테스트 (0003.mp3)
  const res = await apiFetch("audio/voice", { method: "POST" });
  if (res) fetchLatest();
}

async function setVolume(val) {
  document.getElementById("volNum").textContent = val;
  await apiFetch("audio/volume", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ volume: parseInt(val) })
  });
}


// ════════════════════════════════════════════════════════
// 7. 낙상 감지 알림 효과
// ════════════════════════════════════════════════════════
function triggerFallAlert() {
  document.getElementById("fallOverlay").style.display = "flex";
  playAlertBeep(3);
  console.warn("[ALERT] 낙상 감지!");
}

function clearFallAlert() {
  document.getElementById("fallOverlay").style.display = "none";
  if (alertBeepTimer) { clearInterval(alertBeepTimer); alertBeepTimer = null; }
}

function playAlertBeep(times) {
  let count = 0;
  alertBeepTimer = setInterval(() => {
    beep(880, 0.3, 0.3);
    count++;
    if (count >= times) { clearInterval(alertBeepTimer); alertBeepTimer = null; }
  }, 500);
}

function beep(freq, duration, gain) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gn  = ctx.createGain();
    osc.connect(gn); gn.connect(ctx.destination);
    osc.type = "sine"; osc.frequency.value = freq;
    gn.gain.value = gain;
    osc.start(); osc.stop(ctx.currentTime + duration);
  } catch(e) {}
}

// 오버레이 클릭으로 닫기
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("fallOverlay")?.addEventListener("click", clearFallAlert);
});


// ════════════════════════════════════════════════════════
// 8. 낙상 대응 현황 UI (LED 아케이드 버튼 + 응답 타이머)
// ════════════════════════════════════════════════════════
function updateFallResponseUI(data) {
  const rs   = data.response_state;
  const card = document.getElementById("responseCard");
  if (!card || !rs) return;

  const visible = rs.mode !== "idle";
  card.style.display = visible ? "" : "none";
  if (!visible) return;

  const tag        = document.getElementById("responseTag");
  const countdown  = document.getElementById("rspCountdown");
  const rspUnit    = document.getElementById("rspUnit");
  const barFill    = document.getElementById("rspBarFill");
  const rspResult  = document.getElementById("rspResult");
  const respondBtn = document.getElementById("respondBtn");
  const ledCore    = document.getElementById("btnLedCore");
  const ledRing    = document.getElementById("btnLedRing");
  const ledStatus  = document.getElementById("btnLedStatus");

  if (rs.mode === "awaiting") {
    card.className = "card response-card";
    tag.textContent = "⏱ 응답 대기 중"; tag.className = "tag tag-fall";

    const remaining = Math.max(0, Math.floor(rs.deadline_ts - Date.now() / 1000));
    const pct = Math.min(100, (remaining / (rs.timeout_s || 60)) * 100);
    countdown.textContent = remaining;
    countdown.className = "rsp-countdown";
    rspUnit.textContent  = "초 남음";
    barFill.style.width  = pct + "%";
    barFill.className    = "rsp-bar-fill";
    rspResult.style.display = "none";
    if (respondBtn) respondBtn.disabled = false;

    ledCore.textContent = "●"; ledCore.className = "btn-led-core";
    ledRing.className   = "btn-led-ring";
    ledStatus.textContent = "점등 중 (응답 대기)"; ledStatus.className = "btn-led-status";

  } else if (rs.mode === "responded") {
    card.className = "card response-card rsp-ok";
    tag.textContent = "✅ 응답 완료"; tag.className = "tag tag-ok";

    countdown.textContent = "✓"; countdown.className = "rsp-countdown rsp-ok";
    rspUnit.textContent   = "응답 완료";
    barFill.style.width   = "100%"; barFill.className = "rsp-bar-fill fill-ok";

    rspResult.style.display = "";
    rspResult.className = "rsp-result ok";
    const t = rs.respond_ts ? new Date(rs.respond_ts * 1000).toLocaleTimeString("ko-KR") : "-";
    rspResult.textContent = `✅ ${t} — 사용자 응답 확인. 보호자 알림 취소됨.`;
    if (respondBtn) respondBtn.disabled = true;

    ledCore.textContent = "●"; ledCore.className = "btn-led-core ok";
    ledRing.className   = "btn-led-ring ok";
    ledStatus.textContent = "소등 (확인됨)"; ledStatus.className = "btn-led-status ok";

  } else if (rs.mode === "notified") {
    card.className = "card response-card rsp-notified";
    tag.textContent = "📱 보호자 알림됨"; tag.className = "tag tag-warn";

    countdown.textContent = "0"; countdown.className = "rsp-countdown rsp-warn";
    rspUnit.textContent   = "시간 초과";
    barFill.style.width   = "0%"; barFill.className = "rsp-bar-fill";

    rspResult.style.display = "";
    rspResult.className = "rsp-result notified";
    rspResult.textContent = "⚠️ 응답 없음 — 보호자에게 알림이 전송되었습니다.";
    if (respondBtn) respondBtn.disabled = false;

    ledCore.textContent = "○"; ledCore.className = "btn-led-core off";
    ledRing.className   = "btn-led-ring off";
    ledStatus.textContent = "소등 (알림 발송 후)"; ledStatus.className = "btn-led-status off";
  }
}

async function respondToFall() {
  const res = await apiFetch("test/respond", { method: "POST" });
  if (res) { fetchLatest(); fetchEvents(); }
}


// ════════════════════════════════════════════════════════
// 9. 실시간 이벤트 로그
// ════════════════════════════════════════════════════════
async function fetchEvents() {
  try {
    const res = await apiFetch("api/events");
    if (!res || !res.ok) return;
    const events = await res.json();
    renderEvents(events);
  } catch(e) { console.error("[fetchEvents]", e); }
}

function renderEvents(events) {
  const list = document.getElementById("eventList");
  const cnt  = document.getElementById("evtCount");
  if (!list) return;
  if (cnt) cnt.textContent = `${events.length}`;

  if (!events.length) {
    list.innerHTML = `<div class="no-data">이벤트 없음 — 센서 데이터가 수신되면 표시됩니다</div>`;
    return;
  }

  list.innerHTML = events.map(e => `
    <div class="event-item evt-${e.type}">
      <span class="evt-dot"></span>
      <span class="evt-time">${e.time}</span>
      <span class="evt-msg">${e.event}</span>
    </div>`).join("");
}


// ════════════════════════════════════════════════════════
// 10. 하드웨어 연결 상태 바
// ════════════════════════════════════════════════════════

let _tunnelUrl = "";   // 현재 터널 URL 캐시

function updateConnBar(conn) {
  if (!conn) return;

  function setBadge(id, ok) {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = `cstatus ${ok ? "ok" : "err"}`;
  }

  setBadge("cs-esp32", conn.esp32_ok);
  setBadge("cs-pico",  conn.pico_ok);
  // RPi는 항상 ok (서버가 실행 중이므로)
  setBadge("cs-cf", !!conn.cloudflare_url);

  // Cloudflare 배지 — URL이 있으면 클릭 가능
  const cfEl = document.getElementById("cs-cf");
  if (cfEl) {
    if (conn.cloudflare_url) {
      cfEl.title  = conn.cloudflare_url;
      cfEl.style.cursor = "pointer";
      cfEl.onclick = () => window.open(conn.cloudflare_url, "_blank");
    } else {
      cfEl.title  = "Cloudflare Tunnel — start.sh 실행 시 자동 연결";
      cfEl.style.cursor = "default";
      cfEl.onclick = null;
    }
  }

  const note = document.getElementById("connNote");
  if (note) {
    if (conn.esp32_ok) {
      const ago = conn.esp32_last_seen
        ? Math.round(Date.now()/1000 - conn.esp32_last_seen) + "초 전"
        : "";
      note.textContent = `ESP32 연결됨 · ${conn.esp32_ip || ""} ${ago}`;
      note.style.color = "var(--txt3)";
    } else {
      note.textContent = "ESP32 미연결 — config.h SERVER_IP 확인";
      note.style.color = "rgba(255,183,0,.7)";
    }
  }

  // 터널 공유 패널
  _updateTunnelPanel(conn.cloudflare_url || "");
}

function _updateTunnelPanel(url) {
  const panel = document.getElementById("tunnelPanel");
  if (!panel) return;

  if (url && url !== _tunnelUrl) {
    _tunnelUrl = url;
    const link = document.getElementById("tunnelLink");
    if (link) { link.textContent = url; link.href = url; }
  }

  panel.style.display = url ? "" : "none";
}

function copyTunnelUrl() {
  if (!_tunnelUrl) return;
  navigator.clipboard.writeText(_tunnelUrl).then(() => {
    const btn = document.getElementById("tunnelCopyBtn");
    if (!btn) return;
    btn.textContent = "✅ 복사됨!";
    setTimeout(() => { btn.textContent = "📋 복사"; }, 2500);
  }).catch(() => {
    // clipboard API 실패 시 fallback
    const ta = document.createElement("textarea");
    ta.value = _tunnelUrl; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); document.body.removeChild(ta);
    const btn = document.getElementById("tunnelCopyBtn");
    if (btn) { btn.textContent = "✅ 복사됨!"; setTimeout(() => { btn.textContent = "📋 복사"; }, 2500); }
  });
}

function openTunnelUrl() {
  if (_tunnelUrl) window.open(_tunnelUrl, "_blank");
}


// ════════════════════════════════════════════════════════
// 11. AI 시스템 상태 머신 UI
// ════════════════════════════════════════════════════════
const STATE_FLOW = [
  { id: "EMPTY",             label: "욕실\n비어있음",  icon: "🏠", phase: "normal"    },
  { id: "DOOR_OPEN",         label: "문\n열림",        icon: "🚪", phase: "normal"    },
  { id: "ENTERING",          label: "입실\n중",        icon: "🚶", phase: "normal"    },
  { id: "OCCUPIED",          label: "사용\n중",        icon: "🧑", phase: "normal"    },
  { id: "MONITORING",        label: "케어\n모드",       icon: "👁", phase: "normal"    },
  { id: "HEIGHT_DROP",       label: "높이\n급감",      icon: "📉", phase: "warning"   },
  { id: "FALL_CANDIDATE",    label: "낙상\n후보",      icon: "⚠️", phase: "warning"   },
  { id: "AWAITING_RESPONSE", label: "응답\n대기",      icon: "⏱", phase: "warning"   },
  { id: "FALL_DETECTED",     label: "낙상\n감지",      icon: "🆘", phase: "emergency" },
  { id: "GUARDIAN_ALERTED",  label: "보호자\n알림",    icon: "📱", phase: "emergency" },
  { id: "RESPONSE_RECEIVED", label: "응답\n확인",      icon: "✅", phase: "recovery"  },
  { id: "RECOVERY",          label: "복구\n중",        icon: "🔄", phase: "recovery"  },
];
const PHASE_LABELS = { normal: "정상", warning: "경계", emergency: "긴급", recovery: "복구" };

function updateSystemState(data) {
  const sm   = data.system_sm;
  const conf = data.fall_confidence ?? 0;
  if (!sm) return;

  const currState = sm.state || "EMPTY";
  const stateInfo = STATE_FLOW.find(s => s.id === currState) || STATE_FLOW[0];
  const phase     = stateInfo.phase;

  // 현재 상태 블록
  const currEl  = document.getElementById("smCurrent");
  const iconEl  = document.getElementById("smCurrIcon");
  const labelEl = document.getElementById("smCurrLabel");
  const prevEl  = document.getElementById("smCurrPrev");
  const phaseTag = document.getElementById("smPhaseTag");

  if (currEl) {
    iconEl.textContent  = stateInfo.icon;
    labelEl.textContent = stateInfo.label.replace(/\n/g, " ");
    if (sm.prev_state) {
      const pi = STATE_FLOW.find(s => s.id === sm.prev_state);
      prevEl.textContent = `이전: ${pi ? pi.label.replace(/\n/g, " ") : sm.prev_state}`;
    } else {
      prevEl.textContent = "이전: -";
    }
    currEl.className   = `sm-current phase-${phase}`;
    phaseTag.textContent = PHASE_LABELS[phase] || phase;
    phaseTag.className   = `tag sm-phase-${phase}`;
  }

  // 신뢰도
  const confValEl  = document.getElementById("smConfVal");
  const confFillEl = document.getElementById("smConfFill");
  if (confValEl)  confValEl.textContent   = `${conf}%`;
  if (confFillEl) confFillEl.style.width  = `${conf}%`;

  // 상태 흐름 노드
  const flowEl  = document.getElementById("smFlow");
  const currIdx = STATE_FLOW.findIndex(s => s.id === currState);
  if (flowEl) {
    flowEl.innerHTML = STATE_FLOW.map((s, i) => {
      let cls = "sm-node";
      if (i === currIdx)     cls += ` sm-active phase-${s.phase}`;
      else if (i < currIdx)  cls += " sm-done";
      const node = `<div class="${cls}" title="${s.label.replace(/\n/g," ")}">
        <div class="sm-node-icon">${s.icon}</div>
        <div class="sm-node-label">${s.label.replace(/\n/g,"<br>")}</div>
      </div>`;
      return i < STATE_FLOW.length - 1 ? node + `<div class="sm-arrow"></div>` : node;
    }).join("");
  }

  // 히스토리
  const histList = document.getElementById("smHistList");
  const hist = data.state_history || [];
  if (histList) {
    if (!hist.length) {
      histList.innerHTML = `<div class="no-data" style="padding:8px 0">전환 기록 없음</div>`;
    } else {
      histList.innerHTML = hist.slice(0, 6).map(h => `
        <div class="sm-hist-item">
          <span class="sm-hist-ts">${h.ts}</span>
          <span class="sm-hist-from">${h.from_label}</span>
          <span class="sm-hist-arrow">→</span>
          <span class="sm-hist-to">${h.to_label}</span>
        </div>`).join("");
    }
  }
}


// ════════════════════════════════════════════════════════
// 9. 테스트 버튼
// ════════════════════════════════════════════════════════
const TEST_LABELS = {
  normal: "정상 상태", warning: "낙상 의심", height_drop: "높이 급감",
  fall: "낙상 감지", enter: "입실 시뮬레이션", exit: "퇴실 시뮬레이션",
  long_stay: "장시간 체류", respond: "사용자 응답"
};

async function sendTest(type) {
  const msg = document.getElementById("testMsg");
  msg.textContent = `⏳ ${TEST_LABELS[type]} 전송 중…`;
  try {
    const res = await apiFetch(`test/${type}`, { method: "POST" });
    if (!res) return;
    msg.textContent = `✅ ${TEST_LABELS[type]} 데이터 주입 완료!`;
    fetchLatest(); fetchLogs();
  } catch(e) {
    msg.textContent = `❌ 오류: ${e.message}`;
  }
  setTimeout(() => { msg.textContent = ""; }, 4000);
}


// ════════════════════════════════════════════════════════
// 10. 탭 전환 (캔버스 ↔ 레이더)
// ════════════════════════════════════════════════════════
function switchTab(tab) {
  currentTab = tab;
  document.getElementById("paneCanvas").classList.toggle("hidden", tab !== "canvas");
  document.getElementById("paneRadar").classList.toggle("hidden",  tab !== "radar");
  document.getElementById("tabBtnCanvas").classList.toggle("active", tab === "canvas");
  document.getElementById("tabBtnRadar").classList.toggle("active",  tab === "radar");
  if (tab === "radar" && !radarChart) initRadarChart();
}


// ════════════════════════════════════════════════════════
// 유틸
// ════════════════════════════════════════════════════════
function disp(v, unit = "") {
  if (v === null || v === undefined || v === "") return "-";
  return unit ? `${v}${unit}` : String(v);
}

function setText(id, text, cls = "") {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  if (cls !== undefined) el.className = `sc-val ${cls}`;
}

function flash(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove("flash");
  void el.offsetWidth;  // reflow
  el.classList.add("flash");
}


// ════════════════════════════════════════════════════════
// 초기화 + 폴링 시작
// ════════════════════════════════════════════════════════
fetchLatest();
fetchLogs();
fetchEvents();
setInterval(fetchLatest, POLL_MS);
setInterval(fetchLogs,   POLL_MS);
setInterval(fetchEvents, POLL_MS);
