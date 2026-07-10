// --- Tab Navigation Logic ---
function switchTab(tabId) {
    // Hide all tab contents
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });
    // Remove active class from all buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    
    // Show selected tab content
    document.getElementById(tabId + '-tab').classList.add('active');
    
    // Find active tab button and highlight it
    const activeBtn = Array.from(document.querySelectorAll('.tab-btn')).find(btn => 
        btn.getAttribute('onclick').includes(tabId)
    );
    if (activeBtn) activeBtn.classList.add('active');
    
    // If returning to simulator, force resize / redraw
    if (tabId === 'simulator' && typeof initCanvas === 'function') {
        setTimeout(draw, 50);
    }
}

function switchCodeTab(tabId) {
    document.querySelectorAll('.code-block').forEach(block => {
        block.classList.remove('active');
    });
    document.querySelectorAll('.code-tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    
    document.getElementById(tabId).classList.add('active');
    
    const activeBtn = Array.from(document.querySelectorAll('.code-tab-btn')).find(btn => 
        btn.getAttribute('onclick').includes(tabId)
    );
    if (activeBtn) activeBtn.classList.add('active');
}

// --- Source Code Embedding for Code Tabs ---
const mainPyCode = `import time
import math
import wave
import struct
import tempfile
import os
import subprocess
import threading
import sys

from ydlidar_parser import YDLidarX4

# --- Configuration ---
LIDAR_PORT = "/dev/ttyUSB0"
BAUDRATE = 115200
IS_SIMULATION = True # Default to simulation for safety and testing

# Mode selection: 
# - "SPATIAL_BEEPS": stereo panned beeping tones (pitch and pan indicators)
# - "VOICE_TTS": spoken voice directions (using espeak or say commands)
# - "HAPTIC_GPIO": vibrates mini-motors mapped to GPIO pins (forehead, temples, occipital)
AUDIO_FEEDBACK_MODE = "SPATIAL_BEEPS"

# GPIO Pins configuration (BCM numbers) for Haptic feedback
GPIO_MOTOR_FRONT = 17    # Pin 11 - Forehead
GPIO_MOTOR_LEFT = 27     # Pin 13 - Left Temple
GPIO_MOTOR_RIGHT = 22    # Pin 15 - Right Temple
GPIO_MOTOR_BEHIND = 23   # Pin 16 - Back of head

# Gracefully attempt to import RPi.GPIO (runs anywhere, but controls pins on Pi)
try:
    import RPi.GPIO as GPIO
    GPIO.setmode(GPIO.BCM)
    for pin in [GPIO_MOTOR_FRONT, GPIO_MOTOR_LEFT, GPIO_MOTOR_RIGHT, GPIO_MOTOR_BEHIND]:
        GPIO.setup(pin, GPIO.OUT)
        GPIO.output(pin, GPIO.LOW)
    print("[GPIO] Raspberry Pi GPIO pins configured for haptic motors.")
except ImportError:
    GPIO = None
    print("[GPIO] Warning: 'RPi.GPIO' library not found. Haptics will be simulated in the console.")

# Detection distance ranges (meters)
MAX_DETECT_DISTANCE_M = 2.5
MIN_DETECT_DISTANCE_M = 0.25

# Threading control
running = True

def generate_stereo_beep_wav(filepath, frequency, duration, pan=0.0, volume=0.5):
    sample_rate = 44100
    num_samples = int(sample_rate * duration)
    
    pan_angle = (pan + 1.0) * math.pi / 4.0
    left_gain = math.cos(pan_angle) * volume
    right_gain = math.sin(pan_angle) * volume
    
    try:
        with wave.open(filepath, 'wb') as wav:
            wav.setnchannels(2)      # Stereo
            wav.setsampwidth(2)      # 16-bit
            wav.setframerate(sample_rate)
            
            raw_frames = bytearray()
            for i in range(num_samples):
                t = i / sample_rate
                sine_val = math.sin(2.0 * math.pi * frequency * t)
                left_val = int(32767 * left_gain * sine_val)
                right_val = int(32767 * right_gain * sine_val)
                raw_frames.extend(struct.pack('<hh', left_val, right_val))
                
            wav.writeframesraw(raw_frames)
        return True
    except Exception as e:
        print(f"[Audio] Error writing WAV file: {e}")
        return False

def play_sound(filepath):
    try:
        if sys.platform.startswith("linux"):
            subprocess.run(["aplay", "-q", filepath], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif sys.platform == "darwin":
            subprocess.run(["afplay", filepath], check=True)
    except Exception:
        print("\\a", end="", flush=True)

def speak_direction(direction, distance):
    text = f"{direction} {distance:.1f} meters"
    try:
        if sys.platform.startswith("linux"):
            subprocess.Popen(["espeak", "-v", "en", "-s", "160", text], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif sys.platform == "darwin":
            subprocess.Popen(["say", text])
        else:
            print(f"\\n[VOICE] {text}")
    except Exception:
        print(f"\\n[VOICE] {text}")

def trigger_haptic_pulse(sector, duration):
    pin = None
    if sector == "front": pin = GPIO_MOTOR_FRONT
    elif sector == "left": pin = GPIO_MOTOR_LEFT
    elif sector == "right": pin = GPIO_MOTOR_RIGHT
    elif sector == "behind": pin = GPIO_MOTOR_BEHIND
    
    if pin is not None:
        if GPIO:
            try:
                GPIO.output(pin, GPIO.HIGH)
                time.sleep(duration)
                GPIO.output(pin, GPIO.LOW)
            except Exception as e:
                print(f"[GPIO] Error toggling pin {pin}: {e}")
        else:
            sys.stdout.write(f"\\r[TACTILE] *VIBRATE {sector.upper()}* ({int(duration*1000)}ms)                ")
            sys.stdout.flush()
            time.sleep(duration)

class FeedbackGeneratorThread(threading.Thread):
    def __init__(self):
        super().__init__()
        self.daemon = True
        self.closest_distance = float('inf')
        self.closest_angle = 0
        self.closest_sector = "safe"
        self.temp_dir = tempfile.gettempdir()
        self.temp_wav = os.path.join(self.temp_dir, "i_hear_spatial.wav")
        self.last_speech_time = 0
        self.speech_cooldown = 2.5
        
    def update_obstacle(self, distance, angle, sector):
        self.closest_distance = distance
        self.closest_angle = angle
        self.closest_sector = sector

    def run(self):
        while running:
            dist = self.closest_distance
            angle = self.closest_angle
            sector = self.closest_sector
            
            if dist >= MAX_DETECT_DISTANCE_M:
                time.sleep(0.1)
                continue
                
            if dist <= MIN_DETECT_DISTANCE_M:
                interval = 0.04
            else:
                ratio = (dist - MIN_DETECT_DISTANCE_M) / (MAX_DETECT_DISTANCE_M - MIN_DETECT_DISTANCE_M)
                interval = 0.08 + ratio * 0.82
                
            if AUDIO_FEEDBACK_MODE == "VOICE_TTS":
                now = time.time()
                if now - self.last_speech_time >= self.speech_cooldown:
                    speak_direction(sector, dist)
                    self.last_speech_time = now
                time.sleep(0.1)
                
            elif AUDIO_FEEDBACK_MODE == "HAPTIC_GPIO":
                pulse_duration = 0.08 if dist > MIN_DETECT_DISTANCE_M else 0.15
                trigger_haptic_pulse(sector, pulse_duration)
                time.sleep(interval)
                
            else:
                angle_rad = math.radians(angle)
                pan = math.sin(angle_rad) 
                
                if sector == "behind":
                    pitch = 450
                elif sector == "front":
                    pitch = 850
                else:
                    pitch = 650
                    
                duration = 0.08
                generate_stereo_beep_wav(self.temp_wav, pitch, duration, pan=pan, volume=0.6)
                play_sound(self.temp_wav)
                time.sleep(interval)
                
        try:
            if os.path.exists(self.temp_wav):
                os.remove(self.temp_wav)
        except Exception:
            pass

def process_360_scan_data(scan):
    closest_distance = float('inf')
    closest_angle = 0
    closest_sector = "safe"
    
    for angle, distance in scan.items():
        if distance <= 0.08 or distance > 10.0:
            continue
            
        rel_angle = angle
        if rel_angle > 180:
            rel_angle -= 360
            
        if -45 <= rel_angle <= 45:
            sector = "front"
        elif 45 < rel_angle <= 135:
            sector = "right"
        elif -135 <= rel_angle < -45:
            sector = "left"
        else:
            sector = "behind"
            
        if distance < closest_distance:
            closest_distance = distance
            closest_angle = rel_angle
            closest_sector = sector
            
    return closest_distance, closest_angle, closest_sector

def main():
    global running, AUDIO_FEEDBACK_MODE
    
    choice = "1"
    if len(sys.argv) > 1 and sys.argv[1] in ["1", "2", "3"]:
        choice = sys.argv[1]
        
    if choice == "2":
        AUDIO_FEEDBACK_MODE = "VOICE_TTS"
    elif choice == "3":
        AUDIO_FEEDBACK_MODE = "HAPTIC_GPIO"
        
    lidar = YDLidarX4(port=LIDAR_PORT, baudrate=BAUDRATE, is_simulated=IS_SIMULATION)
    if not lidar.connect():
        sys.exit(1)
        
    feedback_thread = FeedbackGeneratorThread()
    feedback_thread.start()
    lidar.start_scanning()
    
    try:
        while True:
            scan = lidar.get_scan()
            dist, angle, sector = process_360_scan_data(scan)
            feedback_thread.update_obstacle(dist, angle, sector)
            
            if dist < MAX_DETECT_DISTANCE_M:
                status = "DANGER" if dist <= MIN_DETECT_DISTANCE_M else "WARNING"
                bar_len = int((MAX_DETECT_DISTANCE_M - dist) * 12)
                visual_bar = "█" * bar_len + "░" * (24 - bar_len)
                if AUDIO_FEEDBACK_MODE != "HAPTIC_GPIO":
                    print(f"[{status}] Nearest: {dist:.2f}m in {sector.upper():6s} at {angle:4d}° | {visual_bar}", end="\\r", flush=True)
            else:
                if AUDIO_FEEDBACK_MODE != "HAPTIC_GPIO":
                    print(f"[ SAFE ] Clear in all directions (No obstacles within {MAX_DETECT_DISTANCE_M}m)               ", end="\\r", flush=True)
            time.sleep(0.1)
    except KeyboardInterrupt:
        pass
    finally:
        running = False
        lidar.disconnect()
        if GPIO:
            try:
                GPIO.cleanup()
            except Exception:
                pass

if __name__ == "__main__":
    main()`;

const ydlidarPyCode = `import time
try:
    import serial
except ImportError:
    serial = None
import threading
import math
import random

class YDLidarX4:
    def __init__(self, port="/dev/ttyUSB0", baudrate=115200, is_simulated=False):
        self.port = port
        self.baudrate = baudrate
        self.is_simulated = is_simulated
        self.serial_port = None
        self.is_scanning = False
        self.read_thread = None
        self.latest_scan = {angle: 0.0 for angle in range(360)}
        self.lock = threading.Lock()
        
        self.sim_obstacles = [
            {"type": "wall", "x1": -1.2, "y1": -3.0, "x2": -1.2, "y2": 3.0},
            {"type": "wall", "x1": 1.2, "y1": -3.0, "x2": 1.2, "y2": 3.0},
            {"type": "wall", "x1": -2.0, "y1": 2.5, "x2": 2.0, "y2": 2.5},
            {"type": "circle", "cx": -0.8, "cy": 1.0, "radius": 0.20},
            {"type": "circle", "cx": 0.8, "cy": 1.6, "radius": 0.25},
        ]
        
    def connect(self):
        if not self.is_simulated and serial is None:
            print("[LiDAR] Warning: 'pyserial' not found. Falling back to SIMULATION.")
            self.is_simulated = True

        if self.is_simulated:
            print("[LiDAR] Initializing in SIMULATION mode.")
            return True

        try:
            self.serial_port = serial.Serial(
                port=self.port, baudrate=self.baudrate,
                bytesize=serial.EIGHTBITS, parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_ONE, timeout=1.0
            )
            self.serial_port.dtr = True
            self.serial_port.rts = True
            time.sleep(0.5)
            return True
        except Exception as e:
            print(f"[LiDAR] Connection failed: {e}. Auto-falling back to SIMULATION.")
            self.is_simulated = True
            return True

    def start_scanning(self):
        if self.is_scanning: return
        self.is_scanning = True
        
        if not self.is_simulated:
            self.serial_port.write(b'\\xA5\\x60')
            time.sleep(0.1)
            
        self.read_thread = threading.Thread(target=self._run, daemon=True)
        self.read_thread.start()

    def stop_scanning(self):
        if not self.is_scanning: return
        self.is_scanning = False
        if self.read_thread: self.read_thread.join(timeout=2.0)
        if not self.is_simulated and self.serial_port:
            self.serial_port.write(b'\\xA5\\x65')
            time.sleep(0.1)
            self.serial_port.reset_input_buffer()

    def disconnect(self):
        self.stop_scanning()
        if self.serial_port and self.serial_port.is_open:
            self.serial_port.close()

    def get_scan(self):
        with self.lock:
            return self.latest_scan.copy()

    def _run(self):
        if self.is_simulated:
            self._run_simulator()
        else:
            self._run_hardware()

    def _run_simulator(self):
        hz = 7.0
        while self.is_scanning:
            scan_data = {}
            for angle_deg in range(360):
                angle_rad = math.radians(angle_deg)
                dx = math.sin(angle_rad)
                dy = math.cos(angle_rad)
                min_dist = 10.0
                
                for obs in self.sim_obstacles:
                    dist = 10.0
                    if obs["type"] == "wall":
                        x1, y1, x2, y2 = obs["x1"], obs["y1"], obs["x2"], obs["y2"]
                        denom = dx * (y2 - y1) - dy * (x2 - x1)
                        if abs(denom) > 1e-6:
                            t = (x1 * (y2 - y1) - y1 * (x2 - x1)) / denom
                            if t > 0.1:
                                ix, iy = t * dx, t * dy
                                min_x, max_x = min(x1, x2) - 0.01, max(x1, x2) + 0.01
                                min_y, max_y = min(y1, y2) - 0.01, max(y1, y2) + 0.01
                                if min_x <= ix <= max_x and min_y <= iy <= max_y:
                                    dist = t
                    elif obs["type"] == "circle":
                        cx, cy, r = obs["cx"], obs["cy"], obs["radius"]
                        b = -2 * (dx * cx + dy * cy)
                        c = cx**2 + cy**2 - r**2
                        discriminant = b**2 - 4*c
                        if discriminant >= 0:
                            t1 = (-b - math.sqrt(discriminant)) / 2.0
                            if t1 > 0.1: dist = t1
                
                measured_dist = max(0.12, min_dist + random.gauss(0, 0.015))
                if random.random() < 0.02: measured_dist = 0.0
                scan_data[angle_deg] = measured_dist
                
            with self.lock:
                self.latest_scan.update(scan_data)
            time.sleep(1.0 / hz)

    def _run_hardware(self):
        try:
            desc = self.serial_port.read(7)
        except Exception:
            return
        byte_buffer = bytearray()
        while self.is_scanning:
            try:
                if self.serial_port.in_waiting > 0:
                    byte_buffer.extend(self.serial_port.read(self.serial_port.in_waiting))
                else:
                    time.sleep(0.002)
                    continue
                while len(byte_buffer) >= 10:
                    header_index = byte_buffer.find(b'\\xAA\\x55')
                    if header_index == -1:
                        del byte_buffer[:-1]
                        break
                    if header_index > 0:
                        del byte_buffer[:header_index]
                    if len(byte_buffer) < 10:
                        break
                    package_type = byte_buffer[2]
                    sample_quantity = byte_buffer[3]
                    packet_size = 10 + (sample_quantity * 2)
                    if len(byte_buffer) < packet_size:
                        break
                    packet = byte_buffer[:packet_size]
                    del byte_buffer[:packet_size]
                    fsa = packet[4] | (packet[5] << 8)
                    lsa = packet[6] | (packet[7] << 8)
                    angle_fsa = (fsa >> 1) / 64.0
                    angle_lsa = (lsa >> 1) / 64.0
                    angle_diff = angle_lsa - angle_fsa
                    if angle_diff < 0: angle_diff += 360.0
                    step = angle_diff / (sample_quantity - 1) if sample_quantity > 1 else 0
                    
                    scan_chunk = {}
                    for i in range(sample_quantity):
                        sample_offset = 10 + (i * 2)
                        raw_sample = packet[sample_offset] | (packet[sample_offset + 1] << 8)
                        distance_m = (raw_sample / 4.0) / 1000.0
                        angle = angle_fsa + (step * i)
                        if angle >= 360.0: angle -= 360.0
                        
                        if distance_m > 0:
                            dist_mm = distance_m * 1000.0
                            correction = math.degrees(math.atan(21.8 * (155.3 - dist_mm) / (155.3 * dist_mm))) if dist_mm < 155.3 else 0
                            corrected_angle = angle - correction
                            if corrected_angle < 0: corrected_angle += 360.0
                        else:
                            corrected_angle = angle
                        angle_idx = int(round(corrected_angle)) % 360
                        if 0.08 < distance_m < 10.0:
                            scan_chunk[angle_idx] = distance_m
                        else:
                            scan_chunk[angle_idx] = 0.0
                    with self.lock:
                        self.latest_scan.update(scan_chunk)
            except Exception:
                time.sleep(0.1)`;

// Inject code to DOM
document.querySelector('#code-main code').textContent = mainPyCode;
document.querySelector('#code-parser code').textContent = ydlidarPyCode;


// --- Web Audio Engine & Synthesizer ---
let audioCtx = null;
let beepTimer = null;
let nextBeepTime = 0;
let isAudioEnabled = true;

// TTS Variables
let isSpeechEnabled = false;
let speechSynth = window.speechSynthesis;
let lastSpeechTime = 0;
let speechThrottleMs = 3000; // Speak at most once every 3s

function initAudio() {
    if (audioCtx) return;
    try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AudioContextClass();
        console.log("Web Audio API initialized.");
    } catch (e) {
        console.error("Failed to initialize Web Audio API:", e);
    }
}

function playSimulatorBeep(frequency, duration, panValue = 0.0) {
    if (!audioCtx || !isAudioEnabled) return;
    
    // Resume context if suspended (browser autoplay policy)
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
    
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    
    let panner = null;
    if (audioCtx.createStereoPanner) {
        panner = audioCtx.createStereoPanner();
        panner.pan.setValueAtTime(panValue, audioCtx.currentTime);
        
        osc.connect(panner);
        panner.connect(gain);
    } else {
        osc.connect(gain);
    }
    
    gain.connect(audioCtx.destination);
    
    osc.type = 'sine';
    osc.frequency.setValueAtTime(frequency, audioCtx.currentTime);
    
    // Clean beep volume envelope (fade in/out to prevent speaker pops/clicks)
    gain.gain.setValueAtTime(0, audioCtx.currentTime);
    gain.gain.linearRampToValueAtTime(0.3, audioCtx.currentTime + 0.005);
    gain.gain.setValueAtTime(0.3, audioCtx.currentTime + duration - 0.015);
    gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + duration);
    
    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + duration);
}

function speakText(text) {
    if (!isSpeechEnabled || !speechSynth) return;
    const now = Date.now();
    if (now - lastSpeechTime < speechThrottleMs) return; // Throttling speech to not flood
    
    // Cancel any active speech
    speechSynth.cancel();
    
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.1; // slightly fast
    utterance.volume = 0.8;
    speechSynth.speak(utterance);
    lastSpeechTime = now;
}


// --- 2D Lidar Simulator Canvas Setup ---
const canvas = document.getElementById('sim-canvas');
const ctx = canvas.getContext('2d');

// Simulation scaling: 1 meter = 80 pixels
const scale = 80;

// User state
const user = {
    x: canvas.width / 2 / scale, // centered (meters)
    y: (canvas.height / 2 + 100) / scale, // shifted down slightly (meters)
    angle: 0, // facing straight up (Y is up, 0 rad)
    radius: 0.22, // 22cm avatar size
    isDragging: false,
    dragOffset: { x: 0, y: 0 }
};

// Simulated obstacles
let obstacles = [
    { type: 'circle', x: 2.5, y: 1.5, r: 0.35, isDragging: false },
    { type: 'circle', x: 5.0, y: 3.5, r: 0.45, isDragging: false },
    { type: 'circle', x: 1.2, y: 2.8, r: 0.25, isDragging: false },
    { type: 'wall', x1: 0.5, y1: 0.5, x2: 7.0, y2: 0.5, isDragging: false }, // Top wall boundary
    { type: 'wall', x1: 0.5, y1: 0.5, x2: 0.5, y2: 5.8, isDragging: false }, // Left wall
    { type: 'wall', x1: 7.0, y1: 0.5, x2: 7.0, y2: 5.8, isDragging: false }, // Right wall
];

// Dragging track state
let activeDraggedObject = null;

// UI controls elements
const audioEnableCb = document.getElementById('audio-enable');
const speechEnableCb = document.getElementById('speech-enable');
const hapticEnableCb = document.getElementById('haptic-enable');
const beepPitchSlider = document.getElementById('beep-pitch');
const beepPitchVal = document.getElementById('beep-pitch-val');
const coneAngleSlider = document.getElementById('cone-angle');
const coneAngleVal = document.getElementById('cone-angle-val');
const maxDistSlider = document.getElementById('max-dist');
const maxDistVal = document.getElementById('max-dist-val');
const minDistSlider = document.getElementById('min-dist');
const minDistVal = document.getElementById('min-dist-val');
const noiseSlider = document.getElementById('noise-slider');
const noiseVal = document.getElementById('noise-val');
const addObstacleBtn = document.getElementById('add-obstacle-btn');
const clearObstaclesBtn = document.getElementById('clear-obstacles-btn');

// Haptic Nodes
const motorFront = document.getElementById('motor-front');
const motorLeft = document.getElementById('motor-left');
const motorRight = document.getElementById('motor-right');
const motorBehind = document.getElementById('motor-behind');

// State feedback elements
const statusCard = document.getElementById('status-card');
const statusValue = document.getElementById('status-value');
const distanceValue = document.getElementById('distance-value');
const angleValue = document.getElementById('angle-value');
const barFill = document.getElementById('bar-fill');
const barDistanceLbl = document.getElementById('bar-distance-lbl');

let isHapticEnabled = true;

// Connect UI triggers
audioEnableCb.addEventListener('change', (e) => {
    isAudioEnabled = e.target.checked;
    initAudio();
});
speechEnableCb.addEventListener('change', (e) => {
    isSpeechEnabled = e.target.checked;
    if (isSpeechEnabled && speechSynth) {
        initAudio();
        speakText("Text to speech enabled");
    }
});
hapticEnableCb.addEventListener('change', (e) => {
    isHapticEnabled = e.target.checked;
    if (!isHapticEnabled) {
        clearHapticIndicators();
    }
});

function clearHapticIndicators() {
    if (motorFront) motorFront.classList.remove('active', 'danger');
    if (motorLeft) motorLeft.classList.remove('active', 'danger');
    if (motorRight) motorRight.classList.remove('active', 'danger');
    if (motorBehind) motorBehind.classList.remove('active', 'danger');
}

function updateHapticVisuals(sector, dist, minThreshold) {
    clearHapticIndicators();
    if (!isHapticEnabled || dist >= parseFloat(maxDistSlider.value)) return;
    
    let node = null;
    if (sector === "front") node = motorFront;
    else if (sector === "left") node = motorLeft;
    else if (sector === "right") node = motorRight;
    else if (sector === "behind") node = motorBehind;
    
    if (node) {
        node.classList.add('active');
        if (dist <= minThreshold) {
            node.classList.add('danger');
        }
    }
}
beepPitchSlider.addEventListener('input', (e) => {
    beepPitchVal.textContent = e.target.value + " Hz";
});
coneAngleSlider.addEventListener('input', (e) => {
    coneAngleVal.textContent = e.target.value + "°";
});
maxDistSlider.addEventListener('input', (e) => {
    maxDistVal.textContent = parseFloat(e.target.value).toFixed(1) + " m";
});
minDistSlider.addEventListener('input', (e) => {
    minDistVal.textContent = parseFloat(e.target.value).toFixed(2) + " m";
});
noiseSlider.addEventListener('input', (e) => {
    noiseVal.textContent = parseFloat(e.target.value).toFixed(1) + "%";
});

// Reset Map
clearObstaclesBtn.addEventListener('click', () => {
    // Reset to defaults
    user.x = canvas.width / 2 / scale;
    user.y = (canvas.height / 2 + 100) / scale;
    user.angle = 0;
    
    obstacles = [
        { type: 'circle', x: 2.5, y: 1.5, r: 0.35, isDragging: false },
        { type: 'circle', x: 5.0, y: 3.5, r: 0.45, isDragging: false },
        { type: 'circle', x: 1.2, y: 2.8, r: 0.25, isDragging: false },
        { type: 'wall', x1: 0.5, y1: 0.5, x2: 7.0, y2: 0.5, isDragging: false },
        { type: 'wall', x1: 0.5, y1: 0.5, x2: 0.5, y2: 5.8, isDragging: false },
        { type: 'wall', x1: 7.0, y1: 0.5, x2: 7.0, y2: 5.8, isDragging: false },
    ];
    draw();
});

// Spawn circle obstacle
addObstacleBtn.addEventListener('click', () => {
    const rx = 1.0 + Math.random() * (canvas.width / scale - 2.0);
    const ry = 1.0 + Math.random() * (canvas.height / scale - 2.0);
    const rr = 0.2 + Math.random() * 0.3; // 20cm to 50cm
    obstacles.push({ type: 'circle', x: rx, y: ry, r: rr, isDragging: false });
    draw();
});


// --- Raycasting Math for Simulation ---
function castRay(ox, oy, directionRad) {
    const dx = Math.sin(directionRad); // Angle 0 is straight up, clockwise is positive
    const dy = -Math.cos(directionRad); // Canvas Y is inverted
    
    let closestDistance = 10.0; // Max raycast range
    let hitX = ox + dx * closestDistance;
    let hitY = oy + dy * closestDistance;
    
    for (const obs of obstacles) {
        if (obs.type === 'circle') {
            // Ray-circle intersection
            const cx = obs.x;
            const cy = obs.y;
            const r = obs.r;
            
            // Vector from ray origin to circle center
            const ocx = cx - ox;
            const ocy = cy - oy;
            
            // Projection of oc onto ray direction
            const tca = ocx * dx + ocy * dy;
            if (tca < 0) continue; // Circle is behind ray
            
            // Perpendicular distance squared
            const d2 = (ocx * ocx + ocy * ocy) - tca * tca;
            if (d2 > r * r) continue; // Ray misses circle
            
            // Distance from projection to intersection point
            const thc = Math.sqrt(r * r - d2);
            const t0 = tca - thc;
            const t1 = tca + thc;
            
            let t = -1;
            if (t0 > 0.05) t = t0;
            else if (t1 > 0.05) t = t1;
            
            if (t > 0.05 && t < closestDistance) {
                closestDistance = t;
                hitX = ox + dx * t;
                hitY = oy + dy * t;
            }
        }
        else if (obs.type === 'wall') {
            // Ray-line segment intersection
            const x1 = obs.x1;
            const y1 = obs.y1;
            const x2 = obs.x2;
            const y2 = obs.y2;
            
            // Ray: P = O + t*D
            // Segment: Q = A + u*(B - A)
            // Solve O.x + t*D.x = A.x + u*(B.x - A.x) & O.y + t*D.y = A.y + u*(B.y - A.y)
            const v1x = ox - x1;
            const v1y = oy - y1;
            const v2x = x2 - x1;
            const v2y = y2 - y1;
            const v3x = -dx;
            const v3y = -dy;
            
            const denom = v2x * v3y - v2y * v3x;
            if (Math.abs(denom) > 1e-6) {
                const t = (v1x * v2y - v1y * v2x) / denom;
                const u = (v1x * v3y - v1y * v3x) / denom;
                
                if (t > 0.05 && t < closestDistance && u >= 0 && u <= 1) {
                    closestDistance = t;
                    hitX = ox + dx * t;
                    hitY = oy + dy * t;
                }
            }
        }
    }
    
    // Grid boundary check (canvas edge collisions)
    const bounds = [
        { x1: 0, y1: 0, x2: canvas.width/scale, y2: 0 }, // Top
        { x1: 0, y1: 0, x2: 0, y2: canvas.height/scale }, // Left
        { x1: canvas.width/scale, y1: 0, x2: canvas.width/scale, y2: canvas.height/scale }, // Right
        { x1: 0, y1: canvas.height/scale, x2: canvas.width/scale, y2: canvas.height/scale } // Bottom
    ];
    for (const b of bounds) {
        const v1x = ox - b.x1;
        const v1y = oy - b.y1;
        const v2x = b.x2 - b.x1;
        const v2y = b.y2 - b.y1;
        const v3x = -dx;
        const v3y = -dy;
        
        const denom = v2x * v3y - v2y * v3x;
        if (Math.abs(denom) > 1e-6) {
            const t = (v1x * v2y - v1y * v2x) / denom;
            const u = (v1x * v3y - v1y * v3x) / denom;
            if (t > 0.05 && t < closestDistance && u >= 0 && u <= 1) {
                closestDistance = t;
                hitX = ox + dx * t;
                hitY = oy + dy * t;
            }
        }
    }
    
    return {
        distance: closestDistance,
        x: hitX,
        y: hitY
    };
}


// --- Main Draw & Update Loop ---
let lastFrameTime = 0;
let nearestObs = { distance: Infinity, angle: 0, sector: "safe", x: 0, y: 0 };
let leftWallFit = null;
let rightWallFit = null;

function fitSideWall(points) {
    if (points.length < 8) return null;
    const N = points.length;
    
    // Determine if mostly horizontal or vertical
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    for (const p of points) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
    }
    
    const spanX = maxX - minX;
    const spanY = maxY - minY;
    const span = Math.hypot(spanX, spanY);
    
    let m = 0, c = 0, vertical = false;
    
    if (spanY > spanX) {
        // Fit x = m * y + c (mostly vertical wall)
        vertical = true;
        let sumY = 0, sumX = 0, sumY2 = 0, sumY_X = 0;
        for (const p of points) {
            sumY += p.y;
            sumX += p.x;
            sumY2 += p.y * p.y;
            sumY_X += p.y * p.x;
        }
        const denom = (N * sumY2 - sumY * sumY);
        if (Math.abs(denom) < 1e-6) return null;
        m = (N * sumY_X - sumY * sumX) / denom;
        c = (sumX - m * sumY) / N;
    } else {
        // Fit y = m * x + c (mostly horizontal wall)
        vertical = false;
        let sumX = 0, sumY = 0, sumX2 = 0, sumX_Y = 0;
        for (const p of points) {
            sumX += p.x;
            sumY += p.y;
            sumX2 += p.x * p.x;
            sumX_Y += p.x * p.y;
        }
        const denom = (N * sumX2 - sumX * sumX);
        if (Math.abs(denom) < 1e-6) return null;
        m = (N * sumX_Y - sumX * sumY) / denom;
        c = (sumY - m * sumX) / N;
    }
    
    // Calculate RMS error
    let errSum = 0;
    for (const p of points) {
        let dist = 0;
        if (vertical) {
            dist = Math.abs(p.x - (m * p.y + c)) / Math.sqrt(1 + m*m);
        } else {
            dist = Math.abs(p.y - (m * p.x + c)) / Math.sqrt(1 + m*m);
        }
        errSum += dist * dist;
    }
    const rmse = Math.sqrt(errSum / N);
    
    // Wall if straight (RMSE < 0.08m) and long (span > 1.2m)
    if (rmse < 0.08 && span > 1.2) {
        return { vertical, m, c, rmse, span, minX, maxX, minY, maxY };
    }
    return null;
}

function updateSimulation() {
    const warningConeHalf = (parseInt(coneAngleSlider.value) / 2) * Math.PI / 180;
    const maxThreshold = parseFloat(maxDistSlider.value);
    const minThreshold = parseFloat(minDistSlider.value);
    const noisePct = parseFloat(noiseSlider.value) / 100.0;
    
    nearestObs = { distance: Infinity, angle: 0, sector: "safe", x: 0, y: 0 };
    leftWallFit = null;
    rightWallFit = null;
    
    // Simulate LiDAR scan at 360 points (1-degree increments)
    const scanData = [];
    const leftPoints = [];
    const rightPoints = [];
    
    for (let i = 0; i < 360; i++) {
        // LiDAR angle is relative to user facing angle
        const relativeAngleRad = (i * Math.PI / 180);
        const absoluteAngleRad = user.angle + relativeAngleRad;
        
        const rayResult = castRay(user.x, user.y, absoluteAngleRad);
        
        // Add artificial noise
        if (rayResult.distance < 10.0) {
            // Apply gaussian approximation noise
            const noise = (Math.random() - 0.5) * 2 * noisePct * rayResult.distance;
            rayResult.distance = Math.max(0.12, rayResult.distance + noise);
            // Re-calculate hit point with noise
            rayResult.x = user.x + Math.sin(absoluteAngleRad) * rayResult.distance;
            rayResult.y = user.y - Math.cos(absoluteAngleRad) * rayResult.distance;
        }
        
        // Store point cloud item
        scanData.push(rayResult);
        
        // Group left and right scan hits for line fitting (walls within 4.0m)
        let relDeg = i;
        if (relDeg > 180) relDeg -= 360;
        
        const halfFront = parseInt(coneAngleSlider.value) / 2;
        if (relDeg > halfFront && relDeg <= 180 - halfFront) {
            if (rayResult.distance < 4.0) rightPoints.push(rayResult);
        } else if (relDeg >= -(180 - halfFront) && relDeg < -halfFront) {
            if (rayResult.distance < 4.0) leftPoints.push(rayResult);
        }
    }
    
    // Fit side walls in the room
    leftWallFit = fitSideWall(leftPoints);
    rightWallFit = fitSideWall(rightPoints);
    
    // Find the closest non-wall obstacle
    for (let i = 0; i < 360; i++) {
        const rayResult = scanData[i];
        let relDeg = i;
        if (relDeg > 180) relDeg -= 360;
        
        const halfFront = parseInt(coneAngleSlider.value) / 2;
        let sector = "behind";
        if (relDeg >= -halfFront && relDeg <= halfFront) {
            sector = "front";
        } else if (relDeg > halfFront && relDeg <= 180 - halfFront) {
            sector = "right";
        } else if (relDeg >= -(180 - halfFront) && relDeg < -halfFront) {
            sector = "left";
        } else {
            sector = "behind";
        }
        
        let isValidObstacle = true;
        
        // Filter out wall points
        if (sector === "left" && leftWallFit) {
            let distToWall = 0;
            if (leftWallFit.vertical) {
                distToWall = Math.abs(rayResult.x - (leftWallFit.m * rayResult.y + leftWallFit.c)) / Math.sqrt(1 + leftWallFit.m * leftWallFit.m);
            } else {
                distToWall = Math.abs(rayResult.y - (leftWallFit.m * rayResult.x + leftWallFit.c)) / Math.sqrt(1 + leftWallFit.m * leftWallFit.m);
            }
            if (distToWall <= 0.25) {
                isValidObstacle = false; // suppress
            }
        } else if (sector === "right" && rightWallFit) {
            let distToWall = 0;
            if (rightWallFit.vertical) {
                distToWall = Math.abs(rayResult.x - (rightWallFit.m * rayResult.y + rightWallFit.c)) / Math.sqrt(1 + rightWallFit.m * rightWallFit.m);
            } else {
                distToWall = Math.abs(rayResult.y - (rightWallFit.m * rayResult.x + rightWallFit.c)) / Math.sqrt(1 + rightWallFit.m * rightWallFit.m);
            }
            if (distToWall <= 0.25) {
                isValidObstacle = false; // suppress
            }
        }
        
        if (isValidObstacle && rayResult.distance > 0.08 && rayResult.distance < nearestObs.distance) {
            nearestObs = {
                distance: rayResult.distance,
                angle: relDeg,
                sector: sector,
                x: rayResult.x,
                y: rayResult.y
            };
        }
    }
    
    // Compile wall indicators string
    let wallStatusText = "";
    if (leftWallFit) wallStatusText += "[L-WALL] ";
    if (rightWallFit) wallStatusText += "[R-WALL] ";
    
    // Update Telemetry Panel
    if (nearestObs.distance < maxThreshold) {
        distanceValue.textContent = nearestObs.distance.toFixed(2) + " m";
        angleValue.textContent = `${wallStatusText}${nearestObs.angle >= 0 ? `+${nearestObs.angle}` : nearestObs.angle}° (${nearestObs.sector.toUpperCase()})`;
        
        // Update warnings HUD state
        if (nearestObs.distance <= minThreshold) {
            statusCard.className = "status-card danger";
            statusValue.textContent = "DANGER";
            barFill.className = "bar-fill danger";
            barDistanceLbl.textContent = `Critical Danger: ${nearestObs.sector.toUpperCase()}`;
            speakText(`danger, ${nearestObs.sector} ${nearestObs.distance.toFixed(1)} meters`);
        } else {
            statusCard.className = "status-card warning";
            statusValue.textContent = "WARNING";
            barFill.className = "bar-fill warning";
            barDistanceLbl.textContent = `Obstacle ${nearestObs.sector.toUpperCase()}`;
            speakText(`${nearestObs.sector} ${nearestObs.distance.toFixed(1)}`);
        }
        
        const pct = Math.max(0, Math.min(100, (1 - (nearestObs.distance / maxThreshold)) * 100));
        barFill.style.width = pct + "%";
    } else {
        distanceValue.textContent = "-- m";
        angleValue.textContent = `${wallStatusText}--° (--)`;
        statusCard.className = "status-card safe";
        statusValue.textContent = "SAFE";
        barFill.className = "bar-fill safe";
        barFill.style.width = "0%";
        barDistanceLbl.textContent = "Clear Path";
    }
    
    // Update Haptic Visuals
    updateHapticVisuals(nearestObs.sector, nearestObs.distance, minThreshold);
    
    return scanData;
}

// Background scheduler for beeping and vibration
function processAudioLoop() {
    if (!isAudioEnabled && !isHapticEnabled) {
        clearTimeout(beepTimer);
        beepTimer = null;
        return;
    }
    
    const dist = nearestObs.distance;
    const angle = nearestObs.angle;
    const sector = nearestObs.sector;
    const maxThreshold = parseFloat(maxDistSlider.value);
    const minThreshold = parseFloat(minDistSlider.value);
    
    let delay = 1000; // safe default
    
    if (dist < maxThreshold) {
        // 1. Determine Pitch by Sector
        let pitch = 650; // Side (left/right) default
        if (sector === "front") {
            pitch = 850;
        } else if (sector === "behind") {
            pitch = 450;
        }
        
        // 2. Determine Pan based on angle
        const angleRad = angle * Math.PI / 180;
        const pan = Math.sin(angleRad); // left negative, right positive
        
        // 3. Play audio beep if enabled
        if (isAudioEnabled) {
            playSimulatorBeep(pitch, 0.08, pan);
        }
        
        // 4. Trigger vibration if enabled
        if (isHapticEnabled && navigator.vibrate) {
            navigator.vibrate(50);
        }
        
        // 5. Determine warning speed delay
        if (dist <= minThreshold) {
            delay = 120; // 120ms beep cycle
        } else {
            // Map distance linearly: minThreshold -> 120ms delay, maxThreshold -> 900ms delay
            const ratio = (dist - minThreshold) / (maxThreshold - minThreshold);
            delay = 120 + ratio * 780;
        }
    } else {
        // Clear: slow idle check
        delay = 200;
    }
    
    beepTimer = setTimeout(processAudioLoop, delay);
}

// Ensure audio loop restarts if settings change
audioEnableCb.addEventListener('change', (e) => {
    if (e.target.checked) {
        initAudio();
        if (!beepTimer) processAudioLoop();
    } else {
        clearTimeout(beepTimer);
        beepTimer = null;
    }
});


function draw() {
    // Clear Canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Draw grid background
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 0.5;
    const gridSize = 40;
    for (let x = 0; x < canvas.width; x += gridSize) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
    }
    for (let y = 0; y < canvas.height; y += gridSize) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
    }
    
    // Calculate scan data
    const scanData = updateSimulation();
    
    // 1. Draw Lidar Scan Rays & Points
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = 'rgba(16, 185, 129, 0.04)'; // faint green for raw rays
    
    for (let i = 0; i < scanData.length; i += 2) { // Draw every 2nd beam to keep canvas clean
        const pt = scanData[i];
        if (pt.distance < 10.0) {
            ctx.beginPath();
            ctx.moveTo(user.x * scale, user.y * scale);
            ctx.lineTo(pt.x * scale, pt.y * scale);
            ctx.stroke();
        }
    }
    
    // Draw Lidar hit points
    ctx.fillStyle = 'rgba(56, 189, 248, 0.6)'; // cyan dots
    for (let i = 0; i < scanData.length; i++) {
        const pt = scanData[i];
        if (pt.distance < 10.0) {
            ctx.beginPath();
            ctx.arc(pt.x * scale, pt.y * scale, 1.5, 0, Math.PI * 2);
            ctx.fill();
        }
    }
    
    // 2. Draw Warning Zone Arc (Cone)
    const warningConeHalf = (parseInt(coneAngleSlider.value) / 2) * Math.PI / 180;
    const maxThreshold = parseFloat(maxDistSlider.value);
    
    // Warning sector visualization
    ctx.beginPath();
    ctx.moveTo(user.x * scale, user.y * scale);
    // Draw warning slice
    // Start angle: user.angle - warningConeHalf - PI/2 (since 0 is facing up)
    const startAngle = user.angle - warningConeHalf - Math.PI/2;
    const endAngle = user.angle + warningConeHalf - Math.PI/2;
    
    ctx.arc(user.x * scale, user.y * scale, maxThreshold * scale, startAngle, endAngle);
    ctx.closePath();
    ctx.fillStyle = 'rgba(245, 158, 11, 0.08)'; // faint amber glow
    ctx.fill();
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.2)';
    ctx.lineWidth = 1;
    ctx.stroke();
    
    // 3. Highlight Nearest Obstacle hit point (pulsing target)
    if (nearestObs.distance < maxThreshold) {
        const pulseSize = 4 + Math.sin(Date.now() / 100) * 2;
        ctx.beginPath();
        ctx.arc(nearestObs.x * scale, nearestObs.y * scale, pulseSize, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.8)';
        ctx.lineWidth = 2;
        ctx.stroke();
        
        ctx.beginPath();
        ctx.arc(nearestObs.x * scale, nearestObs.y * scale, pulseSize + 4, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.4)';
        ctx.lineWidth = 1;
        ctx.stroke();
        
        // Line from user to nearest obstacle
        ctx.beginPath();
        ctx.moveTo(user.x * scale, user.y * scale);
        ctx.lineTo(nearestObs.x * scale, nearestObs.y * scale);
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.4)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]); // Reset
    }
    
    // 4. Draw Obstacles
    for (const obs of obstacles) {
        if (obs.type === 'circle') {
            // Draw circle obstacle
            ctx.beginPath();
            ctx.arc(obs.x * scale, obs.y * scale, obs.r * scale, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(30, 41, 59, 0.8)';
            ctx.fill();
            ctx.strokeStyle = obs === activeDraggedObject ? 'rgba(59, 130, 246, 0.8)' : '#475569';
            ctx.lineWidth = obs === activeDraggedObject ? 3 : 2;
            ctx.stroke();
            
            // Add grid pattern in obstacles to make them look nice
            ctx.save();
            ctx.clip();
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
            ctx.lineWidth = 1;
            for (let j = (obs.y - obs.r)*scale; j < (obs.y + obs.r)*scale; j += 8) {
                ctx.beginPath();
                ctx.moveTo((obs.x - obs.r)*scale, j);
                ctx.lineTo((obs.x + obs.r)*scale, j);
                ctx.stroke();
            }
            ctx.restore();
            
        } else if (obs.type === 'wall') {
            // Draw wall line
            ctx.beginPath();
            ctx.moveTo(obs.x1 * scale, obs.y1 * scale);
            ctx.lineTo(obs.x2 * scale, obs.y2 * scale);
            ctx.strokeStyle = obs === activeDraggedObject ? 'rgba(59, 130, 246, 0.8)' : '#64748b';
            ctx.lineWidth = obs === activeDraggedObject ? 6 : 4;
            ctx.lineCap = 'round';
            ctx.stroke();
            
            // Draw anchor endpoints
            ctx.fillStyle = '#475569';
            ctx.beginPath();
            ctx.arc(obs.x1 * scale, obs.y1 * scale, 4, 0, Math.PI * 2);
            ctx.arc(obs.x2 * scale, obs.y2 * scale, 4, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    // 4.5 Draw Detected Wall Filters (Visual indication of wall suppression)
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.7)'; // cyan
    ctx.lineWidth = 3.5;
    ctx.setLineDash([6, 6]); // dashed trace showing intelligent detection
    for (const wall of [leftWallFit, rightWallFit]) {
        if (wall) {
            ctx.beginPath();
            if (wall.vertical) {
                const y1 = wall.minY;
                const x1 = wall.m * y1 + wall.c;
                const y2 = wall.maxY;
                const x2 = wall.m * y2 + wall.c;
                ctx.moveTo(x1 * scale, y1 * scale);
                ctx.lineTo(x2 * scale, y2 * scale);
            } else {
                const x1 = wall.minX;
                const y1 = wall.m * x1 + wall.c;
                const x2 = wall.maxX;
                const y2 = wall.m * x2 + wall.c;
                ctx.moveTo(x1 * scale, y1 * scale);
                ctx.lineTo(x2 * scale, y2 * scale);
            }
            ctx.stroke();
        }
    }
    ctx.setLineDash([]); // Reset
    
    // 5. Draw User (Blind Person) Avatar
    ctx.save();
    ctx.translate(user.x * scale, user.y * scale);
    ctx.rotate(user.angle);
    
    // Avatar Outer Bezel (Hat)
    ctx.beginPath();
    ctx.arc(0, 0, user.radius * scale, 0, Math.PI * 2);
    ctx.fillStyle = '#1e1b4b'; // Deep navy hat color
    ctx.fill();
    ctx.strokeStyle = user === activeDraggedObject ? 'rgba(59, 130, 246, 0.9)' : 'rgba(99, 102, 241, 0.8)';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    
    // Draw nose / forward pointer direction
    ctx.beginPath();
    ctx.moveTo(0, -user.radius * scale + 2);
    ctx.lineTo(-8, -user.radius * scale + 15);
    ctx.lineTo(8, -user.radius * scale + 15);
    ctx.closePath();
    ctx.fillStyle = '#6366f1';
    ctx.fill();
    
    // Draw Lidar core spinner (visual)
    ctx.beginPath();
    ctx.arc(0, 0, 7, 0, Math.PI * 2);
    ctx.fillStyle = '#0f172a';
    ctx.fill();
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    
    // Draw rotating laser beam line inside Lidar unit
    const visBeamAngle = (Date.now() / 150) % (Math.PI * 2);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.sin(visBeamAngle) * 7, -Math.cos(visBeamAngle) * 7);
    ctx.strokeStyle = '#ef4444';
    ctx.stroke();
    
    ctx.restore();
    
    // Queue next frame
    requestAnimationFrame(draw);
}


// --- User Interaction Events ---

// Get mouse positions in meters
function getMousePos(canvas, evt) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: (evt.clientX - rect.left) / (rect.width / canvas.width) / scale,
        y: (evt.clientY - rect.top) / (rect.height / canvas.height) / scale
    };
}

canvas.addEventListener('mousedown', (e) => {
    initAudio();
    if (!beepTimer) processAudioLoop(); // Trigger sound thread on interaction
    
    const mouse = getMousePos(canvas, e);
    activeDraggedObject = null;
    
    // 1. Check user hit
    const distToUser = Math.hypot(mouse.x - user.x, mouse.y - user.y);
    if (distToUser < user.radius + 0.1) {
        user.isDragging = true;
        activeDraggedObject = user;
        user.dragOffset = {
            x: mouse.x - user.x,
            y: mouse.y - user.y
        };
        return;
    }
    
    // 2. Check obstacle hits
    for (const obs of obstacles) {
        if (obs.type === 'circle') {
            const dist = Math.hypot(mouse.x - obs.x, mouse.y - obs.y);
            if (dist < obs.r + 0.1) {
                obs.isDragging = true;
                activeDraggedObject = obs;
                obs.dragOffset = {
                    x: mouse.x - obs.x,
                    y: mouse.y - obs.y
                };
                return;
            }
        }
        else if (obs.type === 'wall') {
            // Check distance to segment
            const dist = distToSegment(mouse, { x: obs.x1, y: obs.y1 }, { x: obs.x2, y: obs.y2 });
            if (dist < 0.2) {
                obs.isDragging = true;
                activeDraggedObject = obs;
                obs.dragOffset = {
                    x: mouse.x - (obs.x1 + obs.x2)/2,
                    y: mouse.y - (obs.y1 + obs.y2)/2
                };
                return;
            }
        }
    }
});

canvas.addEventListener('mousemove', (e) => {
    if (!activeDraggedObject) return;
    const mouse = getMousePos(canvas, e);
    
    if (activeDraggedObject === user && user.isDragging) {
        user.x = mouse.x - user.dragOffset.x;
        user.y = mouse.y - user.dragOffset.y;
        
        // Boundaries lock
        user.x = Math.max(user.radius, Math.min(canvas.width/scale - user.radius, user.x));
        user.y = Math.max(user.radius, Math.min(canvas.height/scale - user.radius, user.y));
    }
    else if (activeDraggedObject && activeDraggedObject.isDragging) {
        const obs = activeDraggedObject;
        if (obs.type === 'circle') {
            obs.x = mouse.x - obs.dragOffset.x;
            obs.y = mouse.y - obs.dragOffset.y;
            obs.x = Math.max(obs.r, Math.min(canvas.width/scale - obs.r, obs.x));
            obs.y = Math.max(obs.r, Math.min(canvas.height/scale - obs.r, obs.y));
        }
        else if (obs.type === 'wall') {
            const dx = mouse.x - (obs.x1 + obs.x2)/2 - obs.dragOffset.x;
            const dy = mouse.y - (obs.y1 + obs.y2)/2 - obs.dragOffset.y;
            
            obs.x1 += dx;
            obs.y1 += dy;
            obs.x2 += dx;
            obs.y2 += dy;
        }
    }
});

window.addEventListener('mouseup', () => {
    if (activeDraggedObject) {
        if (activeDraggedObject === user) user.isDragging = false;
        else activeDraggedObject.isDragging = false;
        activeDraggedObject = null;
    }
});

// Segment math helper
function distToSegment(p, v, w) {
    const l2 = Math.pow(v.x - w.x, 2) + Math.pow(v.y - w.y, 2);
    if (l2 === 0) return Math.hypot(p.x - v.x, p.y - v.y);
    let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (v.x + t * (w.x - v.x)), p.y - (v.y + t * (w.y - v.y)));
}

// WASD Keyboard listener for user movement and rotation
window.addEventListener('keydown', (e) => {
    initAudio();
    if (!beepTimer) processAudioLoop();
    
    const moveStep = 0.12; // meters
    const rotStep = 0.08; // radians (~4.5 degrees)
    
    switch (e.key.toLowerCase()) {
        case 'w':
        case 'arrowup':
            // Move forward (direction user is facing)
            user.x += Math.sin(user.angle) * moveStep;
            user.y -= Math.cos(user.angle) * moveStep;
            e.preventDefault();
            break;
        case 's':
        case 'arrowdown':
            // Move backward
            user.x -= Math.sin(user.angle) * moveStep;
            user.y += Math.cos(user.angle) * moveStep;
            e.preventDefault();
            break;
        case 'a':
        case 'arrowleft':
            // Rotate left (counter-clockwise)
            user.angle -= rotStep;
            e.preventDefault();
            break;
        case 'd':
        case 'arrowright':
            // Rotate right (clockwise)
            user.angle += rotStep;
            e.preventDefault();
            break;
    }
    
    // Bounds check
    user.x = Math.max(user.radius, Math.min(canvas.width/scale - user.radius, user.x));
    user.y = Math.max(user.radius, Math.min(canvas.height/scale - user.radius, user.y));
});


// --- Startup ---
// Kickoff Canvas redraw loop
draw();
