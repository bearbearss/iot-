# ============================================================
# Smart Bath Guard - Flask 서버 (공모전 버전)
# ============================================================
import os, copy, threading, time, random
from functools import wraps
from datetime import datetime, timedelta
from collections import deque
from flask import Flask, request, jsonify, render_template, session, redirect, url_for

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

import json as _json
import config as _cfg

# ── 런타임 설정 (config.py 기본값 + settings.json 덮어쓰기) ─
SETTINGS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "settings.json")

def _load_runtime_config():
    cfg = {
        "device_name":   _cfg.DEVICE_NAME,
        "device_room":   _cfg.DEVICE_ROOM,
        "wifi_ssid":     _cfg.WIFI_SSID,
        "wifi_password": _cfg.WIFI_PASSWORD,
        "server_port":   _cfg.SERVER_PORT,
        "esp32_timeout": _cfg.ESP32_TIMEOUT_S,
        "access_code":   _cfg.ACCESS_CODE,
    }
    if os.path.exists(SETTINGS_FILE):
        try:
            with open(SETTINGS_FILE) as f:
                cfg.update(_json.load(f))
        except Exception:
            pass
    return cfg

runtime_config = _load_runtime_config()

app = Flask(__name__)
app.secret_key       = _cfg.SECRET_KEY
ACCESS_CODE          = runtime_config["access_code"]
app.permanent_session_lifetime = timedelta(hours=24)

# ── 하드웨어 연결 상태 추적 ────────────────────────────────
connection_status = {
    "esp32_last_seen": None,  # Unix ts — 마지막 데이터 수신 시각
    "esp32_ip":        None,  # ESP32 IP 주소
    "cloudflare_url":  os.environ.get("TUNNEL_URL", ""),  # 시작 시 환경변수로도 설정 가능
}

# ── 센서 상태 ──────────────────────────────────────────────
latest_data = {
    "height": None, "angle": None, "tof_status": "unknown",
    "mmwave": False, "door": "unknown",
    "fall_candidate": False, "fall_detected": False,
    "servo_status": "stopped", "timestamp": None,
    "occupancy_state": "empty", "occupied": False,
}
log_history = deque(maxlen=20)

# ── 이벤트 로그 (문/입퇴실/낙상/오디오) ───────────────────
event_log = deque(maxlen=100)

def add_event(msg: str, etype: str = "info"):
    event_log.appendleft({
        "time":  datetime.now().strftime("%H:%M:%S"),
        "event": msg,
        "type":  etype
    })
    print(f"[EVENT][{etype.upper()}] {msg}")

# ── 입퇴실 추적 (BL0303 문센서 + mmWave) ─────────────────
occupancy = {
    "state":        "empty",   # empty | occupied | long_stay
    "occupied":     False,
    "door_prev":    None,
    "door_open_ts": None,
    "occupied_since": None,
    "long_stay_threshold_s": 1800,  # 30분
}

def update_occupancy(data: dict):
    """문 열림/닫힘 + mmWave로 입퇴실 판단 (BL0303)"""
    global occupancy
    door   = data.get("door",   "unknown")
    mmwave = data.get("mmwave", False)
    now    = datetime.now()

    # 알 수 없는 문 상태는 건너뜀
    if door not in ("open", "closed"):
        occupancy["door_prev"] = door
        data["occupancy_state"] = occupancy["state"]
        data["occupied"]        = occupancy["occupied"]
        return

    prev = occupancy["door_prev"]

    if prev is not None and door != prev:
        # 문 열림 전환
        if door == "open":
            occupancy["door_open_ts"] = now
            add_event("문 열림", "door")

        # 문 닫힘 전환
        elif door == "closed":
            add_event("문 닫힘", "door")
            if mmwave and not occupancy["occupied"]:
                # 입실: 문이 닫히고 mmWave 사람 감지
                occupancy.update({"state": "occupied", "occupied": True,
                                  "occupied_since": now})
                add_event("사용자 입실", "occupancy")
                # 입실 시 배경 음악 자동 재생
                if not audio_state["playing"]:
                    _queue_audio({"command": "play", "track": 1})
                    audio_state.update({"playing": True, "current_track": 1,
                                        "current_name": TRACK_NAMES[1], "mode": "music"})
                    add_event("배경 음악 자동 재생 (입실)", "audio")
            elif not mmwave and occupancy["occupied"]:
                # 퇴실: 문이 닫히고 mmWave 감지 없음
                occupancy.update({"state": "empty", "occupied": False,
                                  "occupied_since": None})
                add_event("사용자 퇴실", "occupancy")
                _full_exit_reset(data)
                add_event("낙상·오디오 상태 초기화 (퇴실)", "audio")

    # 장시간 체류 체크
    if (occupancy["state"] == "occupied" and occupancy["occupied_since"]):
        elapsed = (now - occupancy["occupied_since"]).total_seconds()
        if elapsed >= occupancy["long_stay_threshold_s"]:
            occupancy["state"] = "long_stay"
            add_event("장시간 욕실 체류 감지 (30분 이상)", "warning")

    occupancy["door_prev"]   = door
    data["occupancy_state"]  = occupancy["state"]
    data["occupied"]         = occupancy["occupied"]

# ── 환경 스캔 상태 ─────────────────────────────────────────
scan_state = {
    "scanning": False, "current_angle": 0,
    "progress": 0, "completed": False, "scan_data": {}
}

# ── 오디오 상태 (DFPlayer Mini + SD카드) ──────────────────
TRACK_NAMES = {
    0: "없음",
    1: "0001.mp3  평상시 배경 음악",
    2: "0002.mp3  경고음",
    3: "0003.mp3  낙상이 감지되었습니다.",
    4: "0004.mp3  괜찮으십니까?",
    5: "0005.mp3  응답이 없으면 보호자에게 알림을 전송합니다.",
}

audio_state = {
    "playing":       False,
    "volume":        15,
    "current_track": 0,
    "current_name":  "없음",
    "mode":          "idle",
}

audio_cmd_queue = deque(maxlen=10)

def _queue_audio(cmd: dict):
    audio_cmd_queue.append(cmd)
    print(f"[AUDIO CMD] → {cmd}")


# ── 낙상 응답 대기 (60mm LED 아케이드 버튼 연동) ──────────
response_state = {
    "mode":        "idle",  # idle | awaiting | responded | notified
    "fall_ts":     None,    # Unix timestamp (낙상 감지 시각)
    "deadline_ts": None,    # Unix timestamp (응답 제한 시각)
    "respond_ts":  None,    # Unix timestamp (응답 확인 시각)
    "timeout_s":   60,      # 응답 대기 제한 시간 (초)
}

recovery_until = None   # float | None — 응답 후 복구 창 종료 Unix ts

# ── 12-상태 시스템 상태 머신 ───────────────────────────────
STATE_INFO = {
    "EMPTY":             {"label":"욕실 비어있음",    "icon":"🏠","phase":"normal",    "servo":True},
    "DOOR_OPEN":         {"label":"문 열림",          "icon":"🚪","phase":"normal",    "servo":True},
    "ENTERING":          {"label":"입실 중",          "icon":"🚶","phase":"normal",    "servo":True},
    "OCCUPIED":          {"label":"욕실 사용 중",     "icon":"🧑","phase":"normal",    "servo":True},
    "MONITORING":        {"label":"케어 모드 활성",   "icon":"👁","phase":"normal",    "servo":True},
    "HEIGHT_DROP":       {"label":"높이 급감 감지",   "icon":"📉","phase":"warning",   "servo":True},
    "FALL_CANDIDATE":    {"label":"낙상 후보",        "icon":"⚠️","phase":"warning",   "servo":False},
    "AWAITING_RESPONSE": {"label":"응답 대기 중",     "icon":"⏱","phase":"warning",   "servo":False},
    "FALL_DETECTED":     {"label":"낙상 감지",        "icon":"🆘","phase":"emergency", "servo":False},
    "GUARDIAN_ALERTED":  {"label":"보호자 알림 발송", "icon":"📱","phase":"emergency", "servo":False},
    "RESPONSE_RECEIVED": {"label":"사용자 응답 확인", "icon":"✅","phase":"recovery",  "servo":True},
    "RECOVERY":          {"label":"시스템 복구 중",   "icon":"🔄","phase":"recovery",  "servo":True},
}
system_sm     = {"state": "EMPTY", "prev_state": None, "changed_at": None}
state_history = deque(maxlen=30)


def check_response_timeout():
    """응답 제한 시간 초과 → 보호자 알림 전환"""
    if response_state["mode"] == "awaiting" and response_state["deadline_ts"]:
        if time.time() > response_state["deadline_ts"]:
            response_state["mode"] = "notified"
            add_event("응답 없음 — 보호자에게 알림 전송됨", "fall")
            _transition_state(compute_system_state())


# ── 상태 머신 헬퍼 ─────────────────────────────────────────
def _transition_state(new_state: str):
    old_state = system_sm["state"]
    if old_state == new_state:
        return
    info_old = STATE_INFO.get(old_state, {})
    info_new = STATE_INFO.get(new_state, {})
    system_sm.update({"state": new_state, "prev_state": old_state, "changed_at": time.time()})
    state_history.appendleft({
        "from":       old_state,
        "to":         new_state,
        "from_label": info_old.get("label", old_state),
        "to_label":   info_new.get("label", new_state),
        "ts":         datetime.now().strftime("%H:%M:%S"),
    })
    phase = info_new.get("phase", "normal")
    etype = "fall" if phase == "emergency" else "warning" if phase == "warning" else "occupancy"
    add_event(f"[SM] {info_old.get('label',old_state)} → {info_new.get('label',new_state)}", etype)


def compute_system_state() -> str:
    rs  = response_state
    ld  = latest_data
    occ = occupancy

    if rs["mode"] == "responded":
        if recovery_until and time.time() < recovery_until:
            return "RECOVERY"
        return "RESPONSE_RECEIVED"

    if rs["mode"] == "notified":
        return "GUARDIAN_ALERTED"

    if rs["mode"] == "awaiting":
        return "AWAITING_RESPONSE"

    if ld.get("fall_detected"):
        return "FALL_DETECTED"

    if ld.get("fall_candidate"):
        return "FALL_CANDIDATE"

    h = ld.get("height")
    if occ["occupied"] and h is not None and h < 50:
        return "HEIGHT_DROP"

    if occ["state"] == "long_stay":
        return "MONITORING"

    if occ["occupied"]:
        return "OCCUPIED"

    door = ld.get("door")
    if door == "open":
        return "ENTERING" if ld.get("mmwave") else "DOOR_OPEN"

    return "EMPTY"


def compute_fall_confidence() -> int:
    ld  = latest_data
    rs  = response_state
    score = 0
    if ld.get("fall_detected"):  score += 55
    if ld.get("fall_candidate"): score += 25
    h = ld.get("height")
    if h is not None:
        if h < 20:   score += 20
        elif h < 40: score += 12
        elif h < 60: score += 5
    if ld.get("mmwave"):             score += 5
    if ld.get("door") == "closed":   score += 5
    if rs["mode"] == "notified":     score += 10
    return min(100, score)


def _full_exit_reset(incoming: dict):
    """퇴실 시 낙상/응답/오디오 상태 전체 초기화"""
    global recovery_until
    response_state.update({
        "mode": "idle", "fall_ts": None,
        "deadline_ts": None, "respond_ts": None
    })
    audio_state.update({
        "playing": False, "current_track": 0,
        "current_name": "없음", "mode": "idle"
    })
    recovery_until = None
    incoming["fall_candidate"] = False
    incoming["fall_detected"]  = False
    _queue_audio({"command": "stop"})


# ── 상태 판단 ──────────────────────────────────────────────
def determine_status(data: dict) -> str:
    if data.get("fall_detected"):
        if response_state["mode"] == "notified":
            return "보호자 알림"
        return "낙상 감지"
    if data.get("fall_candidate"):
        return "낙상 의심"
    if data.get("occupancy_state") == "long_stay":
        return "장시간 체류"
    if data.get("height") is None or data.get("tof_status") == "error":
        return "센서 오류"
    return "정상"


def save_data(incoming: dict):
    global latest_data
    prev_fall_detected  = latest_data.get("fall_detected",  False)
    prev_fall_candidate = latest_data.get("fall_candidate", False)

    incoming["timestamp"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # 입퇴실 추적 (incoming에 occupancy_state, occupied 필드 추가됨)
    update_occupancy(incoming)

    latest_data = copy.deepcopy(incoming)
    log_entry   = copy.deepcopy(incoming)
    log_entry["status"] = determine_status(incoming)
    log_history.appendleft(log_entry)

    # ── 낙상 감지 전환 ──────────────────────────────────────
    if incoming.get("fall_detected") and not prev_fall_detected:
        add_event("낙상 감지!", "fall")
        _queue_audio({"command": "stop"})
        _queue_audio({"command": "play", "track": 2})
        audio_state.update({
            "playing": True, "current_track": 2,
            "current_name": TRACK_NAMES[2], "mode": "fall"
        })
        add_event("경고음 출력 중 (0002.mp3)", "audio")
        # 응답 대기 타이머 시작 (LED 버튼 점등 신호)
        if response_state["mode"] == "idle":
            now_ts = time.time()
            response_state.update({
                "mode":        "awaiting",
                "fall_ts":     now_ts,
                "deadline_ts": now_ts + response_state["timeout_s"],
                "respond_ts":  None
            })
            add_event(f"사용자 응답 대기 중 ({response_state['timeout_s']}초)", "warning")

    # ── 낙상 의심 전환 ──────────────────────────────────────
    elif incoming.get("fall_candidate") and not prev_fall_candidate:
        add_event("낙상 의심 감지", "warning")
        if audio_state["playing"]:
            _queue_audio({"command": "stop"})
        _queue_audio({"command": "play", "track": 4})
        audio_state.update({
            "playing": True, "current_track": 4,
            "current_name": TRACK_NAMES[4], "mode": "warning"
        })
        add_event("음성 출력 중 (괜찮으십니까?)", "audio")

    # ── 정상 복귀 ────────────────────────────────────────────
    elif not incoming.get("fall_detected") and not incoming.get("fall_candidate"):
        if audio_state["mode"] in ("fall", "warning"):
            audio_state.update({
                "playing": False, "current_track": 0,
                "current_name": "없음", "mode": "idle"
            })

    _transition_state(compute_system_state())


# ── 스캔 시뮬레이션 ────────────────────────────────────────
def run_scan_simulation():
    global scan_state
    angles = list(range(35, 141, 5))
    scan_state.update({"scanning": True, "completed": False,
                        "scan_data": {}, "current_angle": 35, "progress": 0})

    bathroom_profile = {
        (35, 49):   (140, 160), (50, 64):   (100, 130),
        (65, 79):   (70,  95),  (80, 100):  (85,  110),
        (101, 115): (90,  115), (116, 130): (120, 145),
        (131, 140): (150, 170),
    }

    for i, angle in enumerate(angles):
        if not scan_state["scanning"]:
            break
        scan_state["current_angle"] = angle
        scan_state["progress"] = int((i + 1) / len(angles) * 100)

        dist = 120
        for (lo, hi), (dmin, dmax) in bathroom_profile.items():
            if lo <= angle <= hi:
                dist = random.randint(dmin, dmax)
                break
        scan_state["scan_data"][str(angle)] = dist
        time.sleep(0.35)

    scan_state["scanning"]  = False
    scan_state["completed"] = True
    print(f"[SCAN] 완료 - {len(scan_state['scan_data'])}개 각도 저장")


# ── 로그인 데코레이터 ───────────────────────────────────────
def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("logged_in"):
            if request.path.startswith("/api/") or \
               request.path.startswith("/test/") or \
               request.path.startswith("/audio/") or \
               request.path in ["/start-scan", "/scan-status", "/scan-data"]:
                return jsonify({"status": "unauthorized"}), 401
            return redirect(url_for("login_page"))
        return f(*args, **kwargs)
    return decorated


# ══════════════════════════════════════════════════════════
# 인증 라우트
# ══════════════════════════════════════════════════════════
@app.route("/login", methods=["GET", "POST"])
def login_page():
    if session.get("logged_in"):
        return redirect(url_for("index"))
    error = None
    if request.method == "POST":
        if request.form.get("code", "").strip() == runtime_config.get("access_code", ACCESS_CODE):
            session.permanent = True
            session["logged_in"] = True
            return redirect(url_for("index"))
        error = "접근 코드가 올바르지 않습니다."
    return render_template("login.html", error=error)


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login_page"))


# ══════════════════════════════════════════════════════════
# 보호된 라우트
# ══════════════════════════════════════════════════════════
@app.route("/")
@login_required
def index():
    return render_template("index.html")


@app.route("/api/latest")
@login_required
def api_latest():
    check_response_timeout()   # 응답 타임아웃 체크
    resp = copy.deepcopy(latest_data)
    resp["status"]          = determine_status(latest_data)
    resp["scan_state"]      = copy.deepcopy(scan_state)
    resp["audio_state"]     = copy.deepcopy(audio_state)
    resp["occupancy_state"] = occupancy["state"]
    resp["occupied"]        = occupancy["occupied"]
    resp["response_state"]  = copy.deepcopy(response_state)
    resp["system_sm"]       = copy.deepcopy(system_sm)
    resp["state_history"]   = list(state_history)[:10]
    resp["fall_confidence"] = compute_fall_confidence()
    esp32_last = connection_status["esp32_last_seen"]
    esp32_ok   = bool(esp32_last and (time.time() - esp32_last) < runtime_config.get("esp32_timeout", 15))
    pico_ok    = esp32_ok and latest_data.get("servo_status") not in (None, "error")
    resp["connection"] = {
        "esp32_ok":        esp32_ok,
        "esp32_last_seen": esp32_last,
        "esp32_ip":        connection_status["esp32_ip"],
        "pico_ok":         pico_ok,
        "cloudflare_url":  connection_status["cloudflare_url"],
    }
    return jsonify(resp), 200


@app.route("/api/logs")
@login_required
def api_logs():
    return jsonify(list(log_history)), 200


@app.route("/api/events")
@login_required
def api_events():
    """실시간 이벤트 로그 (문/입퇴실/낙상/오디오)"""
    return jsonify(list(event_log)), 200


# ── 환경 스캔 ──────────────────────────────────────────────
@app.route("/start-scan", methods=["POST"])
@login_required
def start_scan():
    if scan_state["scanning"]:
        return jsonify({"status": "error", "message": "이미 스캔 중"}), 400
    t = threading.Thread(target=run_scan_simulation, daemon=True)
    t.start()
    return jsonify({"status": "ok", "message": "스캔 시작"}), 200


@app.route("/scan-status")
@login_required
def get_scan_status():
    return jsonify(scan_state), 200


@app.route("/scan-data")
@login_required
def get_scan_data():
    return jsonify(scan_state["scan_data"]), 200


# ════════════════════════════════════════════════════════
# DFPlayer Mini 오디오 API
# ════════════════════════════════════════════════════════

@app.route("/audio/play_music", methods=["POST"])
@login_required
def audio_play_music():
    audio_state.update({
        "playing": True, "current_track": 1,
        "current_name": TRACK_NAMES[1], "mode": "music"
    })
    _queue_audio({"command": "play", "track": 1})
    add_event("배경 음악 재생 (수동)", "audio")
    return jsonify({"status": "ok", "track": TRACK_NAMES[1]}), 200


@app.route("/audio/stop", methods=["POST"])
@login_required
def audio_stop():
    audio_state.update({
        "playing": False, "current_track": 0,
        "current_name": "없음", "mode": "idle"
    })
    _queue_audio({"command": "stop"})
    add_event("오디오 정지 (수동)", "audio")
    return jsonify({"status": "ok"}), 200


@app.route("/audio/warning", methods=["POST"])
@login_required
def audio_warning():
    audio_state.update({
        "playing": True, "current_track": 2,
        "current_name": TRACK_NAMES[2], "mode": "warning"
    })
    _queue_audio({"command": "play", "track": 2})
    add_event("경고음 테스트 (수동)", "audio")
    return jsonify({"status": "ok", "track": TRACK_NAMES[2]}), 200


@app.route("/audio/voice", methods=["POST"])
@login_required
def audio_voice():
    audio_state.update({
        "playing": True, "current_track": 3,
        "current_name": TRACK_NAMES[3], "mode": "voice"
    })
    _queue_audio({"command": "play", "track": 3})
    add_event("음성 테스트 (수동)", "audio")
    return jsonify({"status": "ok", "track": TRACK_NAMES[3]}), 200


@app.route("/audio/volume", methods=["POST"])
@login_required
def audio_volume():
    data = request.get_json(silent=True) or {}
    vol  = max(0, min(30, int(data.get("volume", 15))))
    audio_state["volume"] = vol
    _queue_audio({"command": "volume", "value": vol})
    return jsonify({"status": "ok", "volume": vol}), 200


# ── ESP32 오디오 명령 폴링 (인증 없음 - 내부망) ─────────────
@app.route("/esp32/audio-command", methods=["GET"])
def esp32_audio_command():
    if audio_cmd_queue:
        cmd = audio_cmd_queue.popleft()
        return jsonify(cmd), 200
    return jsonify({"command": "none"}), 200


# ── ESP32 데이터 수신 (인증 없음) ──────────────────────────
@app.route("/data", methods=["POST"])
def receive_data():
    if not request.is_json:
        return jsonify({"status": "error", "message": "JSON required"}), 400
    data = request.get_json()
    connection_status["esp32_last_seen"] = time.time()
    connection_status["esp32_ip"]        = request.remote_addr
    save_data(data)
    print(f"[{latest_data['timestamp']}] 수신 from {request.remote_addr}: {data}")
    return jsonify({"status": "ok", "message": "data received"}), 200


# ── 테스트 엔드포인트 ──────────────────────────────────────
@app.route("/test/normal", methods=["POST"])
@login_required
def test_normal():
    global recovery_until
    # 낙상 응답·상태 머신 초기화
    response_state.update({
        "mode": "idle", "fall_ts": None,
        "deadline_ts": None, "respond_ts": None
    })
    recovery_until = None
    save_data({"height": 165.0, "angle": 88, "tof_status": "normal",
               "mmwave": True, "door": "closed",
               "fall_candidate": False, "fall_detected": False, "servo_status": "stopped"})
    return jsonify({"status": "ok"}), 200

@app.route("/test/warning", methods=["POST"])
@login_required
def test_warning():
    save_data({"height": 45.0, "angle": 35, "tof_status": "low",
               "mmwave": True, "door": "closed",
               "fall_candidate": True, "fall_detected": False, "servo_status": "checking"})
    return jsonify({"status": "ok"}), 200

@app.route("/test/height_drop", methods=["POST"])
@login_required
def test_height_drop():
    """높이 급감 시뮬레이션 (낙상 후보 직전 상태)"""
    save_data({"height": 40.0, "angle": 60, "tof_status": "low",
               "mmwave": True, "door": "closed",
               "fall_candidate": False, "fall_detected": False, "servo_status": "checking"})
    return jsonify({"status": "ok"}), 200

@app.route("/test/fall", methods=["POST"])
@login_required
def test_fall():
    save_data({"height": 12.0, "angle": 5, "tof_status": "low",
               "mmwave": True, "door": "closed",
               "fall_candidate": True, "fall_detected": True, "servo_status": "alert"})
    return jsonify({"status": "ok"}), 200


# ── 입퇴실 / 장시간 체류 시연 테스트 ─────────────────────
@app.route("/test/enter", methods=["POST"])
@login_required
def test_enter():
    """입실 시뮬레이션: 문 열림 → mmWave 감지 → 문 닫힘"""
    # 문 열림
    save_data({"height": None, "angle": 88, "tof_status": "normal",
               "mmwave": False, "door": "open",
               "fall_candidate": False, "fall_detected": False, "servo_status": "stopped"})
    time.sleep(0.06)
    # mmWave 감지 (사람 통과)
    save_data({"height": 168.0, "angle": 85, "tof_status": "normal",
               "mmwave": True, "door": "open",
               "fall_candidate": False, "fall_detected": False, "servo_status": "stopped"})
    time.sleep(0.06)
    # 문 닫힘 → 입실 확정
    save_data({"height": 168.0, "angle": 88, "tof_status": "normal",
               "mmwave": True, "door": "closed",
               "fall_candidate": False, "fall_detected": False, "servo_status": "stopped"})
    return jsonify({"status": "ok", "message": "입실 시뮬레이션 완료"}), 200


@app.route("/test/exit", methods=["POST"])
@login_required
def test_exit():
    """퇴실 시뮬레이션: 문 열림 → mmWave 사라짐 → 문 닫힘"""
    save_data({"height": 168.0, "angle": 88, "tof_status": "normal",
               "mmwave": True, "door": "open",
               "fall_candidate": False, "fall_detected": False, "servo_status": "stopped"})
    time.sleep(0.06)
    save_data({"height": None, "angle": 88, "tof_status": "normal",
               "mmwave": False, "door": "open",
               "fall_candidate": False, "fall_detected": False, "servo_status": "stopped"})
    time.sleep(0.06)
    save_data({"height": None, "angle": 88, "tof_status": "normal",
               "mmwave": False, "door": "closed",
               "fall_candidate": False, "fall_detected": False, "servo_status": "stopped"})
    return jsonify({"status": "ok", "message": "퇴실 시뮬레이션 완료"}), 200


@app.route("/test/long_stay", methods=["POST"])
@login_required
def test_long_stay():
    """장시간 체류 시뮬레이션 (30분+ 경과 강제 설정)"""
    global occupancy
    if not occupancy["occupied"]:
        occupancy.update({
            "state": "occupied",
            "occupied": True,
            "occupied_since": datetime.now() - timedelta(minutes=35)
        })
        add_event("사용자 입실 (시뮬레이션)", "occupancy")
    occupancy["state"] = "long_stay"
    add_event("장시간 욕실 체류 감지 (35분+) — 시뮬레이션", "warning")
    save_data({"height": 165.0, "angle": 88, "tof_status": "normal",
               "mmwave": True, "door": "closed",
               "fall_candidate": False, "fall_detected": False, "servo_status": "stopped"})
    return jsonify({"status": "ok", "message": "장시간 체류 시뮬레이션 완료"}), 200


# ── LED 아케이드 버튼 눌림 (인증 없음 - ESP32 내부망) ─────
@app.route("/button/press", methods=["POST"])
def button_press():
    """
    60mm LED 아케이드 버튼 눌림 이벤트 수신.
    ESP32가 버튼 GPIO HIGH 감지 시 POST.
    낙상 응답 대기 중이면 "사용자 응답 완료" 처리.
    """
    if response_state["mode"] in ("awaiting", "notified"):
        global recovery_until
        now_ts = time.time()
        response_state.update({"mode": "responded", "respond_ts": now_ts})
        recovery_until = now_ts + 8
        _transition_state(compute_system_state())
        add_event("사용자 응답 확인 완료 (아케이드 버튼)", "occupancy")
        print("[BUTTON] 낙상 대응 버튼 눌림 — 사용자 확인")
    else:
        add_event("아케이드 버튼 눌림 (일반)", "door")
    return jsonify({"status": "ok", "mode": response_state["mode"]}), 200


@app.route("/test/respond", methods=["POST"])
@login_required
def test_respond():
    """낙상 응답 버튼 웹 시뮬레이션 (아케이드 버튼 대체)"""
    if response_state["mode"] in ("awaiting", "notified"):
        global recovery_until
        now_ts = time.time()
        response_state.update({"mode": "responded", "respond_ts": now_ts})
        recovery_until = now_ts + 8
        _transition_state(compute_system_state())
        add_event("사용자 응답 확인 완료 (웹 시뮬레이션)", "occupancy")
        return jsonify({"status": "ok", "message": "응답 처리 완료"}), 200
    return jsonify({"status": "error", "message": "대기 중인 낙상 알림 없음"}), 400


# ── Cloudflare Tunnel URL 등록 (start.sh → Flask 전달) ────
@app.route("/api/tunnel-url", methods=["GET", "POST"])
def api_tunnel_url():
    """
    GET  : 현재 터널 URL 조회 (인증 불필요)
    POST : start.sh 가 cloudflared URL 을 Flask 에 등록
           { "url": "https://xxxx.trycloudflare.com" }
    """
    if request.method == "GET":
        return jsonify({
            "url":    connection_status["cloudflare_url"],
            "active": bool(connection_status["cloudflare_url"]),
        }), 200

    data = request.get_json(silent=True) or {}
    url  = data.get("url", "").strip()
    if not url:
        return jsonify({"status": "error", "message": "url required"}), 400
    if not (url.startswith("https://") and ("trycloudflare.com" in url or "cloudflare" in url)):
        return jsonify({"status": "error", "message": "invalid tunnel URL"}), 400

    connection_status["cloudflare_url"] = url
    add_event(f"Cloudflare Tunnel 연결됨: {url}", "occupancy")
    print(f"[TUNNEL] URL 등록됨: {url}")
    return jsonify({"status": "ok", "url": url}), 200


# ── API 구조 요약 (개발 참고용) ────────────────────────────
@app.route("/api/info")
def api_info():
    """전체 API 엔드포인트 목록 (인증 없음)"""
    return jsonify({
        "esp32_send":   "POST /data",
        "esp32_audio":  "GET  /esp32/audio-command",
        "esp32_button": "POST /button/press",
        "dashboard":    "GET  /api/latest · /api/logs · /api/events",
        "audio":        "POST /audio/play_music|stop|warning|voice|volume",
        "scan":         "POST /start-scan  GET /scan-status /scan-data",
        "test":         "POST /test/normal|warning|height_drop|fall|enter|exit|long_stay|respond",
        "auth":         "POST /login  GET /logout",
    }), 200


# ════════════════════════════════════════════════════════
# 설정 / 개발자 콘솔 API
# ════════════════════════════════════════════════════════

@app.route("/esp32/config")
def esp32_config():
    """ESP32 시작 시 서버에서 설정값 가져오기 (인증 없음 - 내부망)"""
    return jsonify({
        "wifi_ssid":     runtime_config["wifi_ssid"],
        "wifi_password": runtime_config["wifi_password"],
        "server_port":   runtime_config["server_port"],
        "device_name":   runtime_config["device_name"],
    }), 200


@app.route("/api/connection-status")
@login_required
def api_connection_status():
    esp32_last = connection_status["esp32_last_seen"]
    esp32_ok   = bool(esp32_last and (time.time() - esp32_last) < runtime_config.get("esp32_timeout", 15))
    pico_ok    = esp32_ok and latest_data.get("servo_status") not in (None, "error")
    ago        = round(time.time() - esp32_last, 1) if esp32_last else None
    return jsonify({
        "esp32":      {"ok": esp32_ok, "last_seen": esp32_last, "ago_s": ago,
                       "ip": connection_status["esp32_ip"]},
        "pico":       {"ok": pico_ok,  "note": "UART via ESP32"},
        "rpi":        {"ok": True,     "note": "서버 실행 중"},
        "cloudflare": {"ok": bool(connection_status["cloudflare_url"]),
                       "url": connection_status["cloudflare_url"]},
    }), 200


@app.route("/api/settings", methods=["GET", "POST"])
@login_required
def api_settings():
    global runtime_config
    safe_cfg = {k: v for k, v in runtime_config.items() if k != "access_code"}
    if request.method == "POST":
        data    = request.get_json(silent=True) or {}
        allowed = {"device_name", "device_room", "wifi_ssid", "wifi_password",
                   "server_port", "esp32_timeout", "access_code"}
        for k, v in data.items():
            if k in allowed:
                runtime_config[k] = v
        try:
            with open(SETTINGS_FILE, "w") as f:
                _json.dump(runtime_config, f, indent=2, ensure_ascii=False)
        except Exception as e:
            return jsonify({"status": "error", "message": str(e)}), 500
        add_event("시스템 설정 저장됨", "occupancy")
        return jsonify({"status": "ok",
                        "config": {k: v for k, v in runtime_config.items() if k != "access_code"}}), 200
    return jsonify(safe_cfg), 200


@app.route("/api/raw-data")
@login_required
def api_raw_data():
    """개발자 콘솔용 — 마지막 수신 데이터 + 전체 상태 스냅샷"""
    return jsonify({
        "latest_data":     copy.deepcopy(latest_data),
        "occupancy":       copy.deepcopy(occupancy),
        "response_state":  copy.deepcopy(response_state),
        "audio_state":     copy.deepcopy(audio_state),
        "system_sm":       copy.deepcopy(system_sm),
        "connection":      copy.deepcopy(connection_status),
        "runtime_config":  {k: v for k, v in runtime_config.items() if k != "access_code"},
        "event_count":     len(event_log),
        "log_count":       len(log_history),
    }), 200


@app.route("/settings")
@login_required
def settings_page():
    return render_template("settings.html")


@app.route("/dev-console")
@login_required
def dev_console_page():
    return render_template("dev_console.html")


# ══════════════════════════════════════════════════════════
if __name__ == "__main__":
    print("=" * 55)
    print("  Smart Bath Guard 서버 시작")
    print(f"  접근 코드: {ACCESS_CODE}")
    print("  http://0.0.0.0:5000")
    print("=" * 55)
    app.run(host="0.0.0.0", port=5000, debug=True)
