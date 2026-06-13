#pragma once

// ── WiFi ─────────────────────────────────────────────────────
#define WIFI_SSID       "KT_GIGA_2G_Wave2_549B"     // ← 수정 필수
#define WIFI_PASSWORD   "fzd3jbg175"   // ← 수정 필수

// ── Flask 서버 (Raspberry Pi IP) ─────────────────────────────
#define SERVER_IP       "192.168.0.xxx"  // ← 수정 필수 (hostname -I 로 확인)
#define SERVER_PORT     8765

// ── 센서 핀 ──────────────────────────────────────────────────
#define SDA_PIN         21    // VL53L1X I2C SDA
#define SCL_PIN         22    // VL53L1X I2C SCL
#define MMWAVE_PIN      4     // mmWave OUT 핀 (HIGH=사람 있음)
#define BUTTON_PIN      18    // 아케이드 버튼 (INPUT_PULLUP)
#define DOOR_PIN        15    // BL0303 자석 문 센서 (INPUT_PULLUP, LOW=닫힘)
#define LED_PIN         2     // 내장 LED

// ── Pico UART (ESP32 → Pico 각도 명령 전송) ──────────────────
// pico.ino: UART0(GP0=TX, GP1=RX) 115200baud, 서보=GP14
// 배선: ESP32 GPIO17(TX) → Pico GP1(RX)  /  GND 공통 연결 필수
#define PICO_RX_PIN     16    // 미사용 (Pico→ESP32 수신 없음)
#define PICO_TX_PIN     17    // ESP32 TX → Pico GP1(RX)
#define PICO_BAUD       115200

// ── DFPlayer Mini UART ────────────────────────────────────────
// ESP32 UART1: RX=32, TX=33
#define DFPLAYER_RX     32
#define DFPLAYER_TX     33
#define DFPLAYER_BAUD   9600

// ── 타이머 ────────────────────────────────────────────────────
#define DATA_INTERVAL_MS    3000   // 서버 데이터 전송 주기 (ms)
#define AUDIO_INTERVAL_MS    500   // 오디오 명령 폴링 주기 (ms)
#define WIFI_RETRY_MAX        20   // WiFi 재시도 횟수

// ── 디버그 출력 ───────────────────────────────────────────────
#define DEBUG_SERIAL    true
#define DBG(x)    if(DEBUG_SERIAL) Serial.print(x)
#define DBGLN(x)  if(DEBUG_SERIAL) Serial.println(x)
#define DBGF(...) if(DEBUG_SERIAL) Serial.printf(__VA_ARGS__)
