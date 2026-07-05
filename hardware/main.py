import time
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
BAUDRATE = 128000
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
    """
    Generates a 2-channel (stereo) 16-bit PCM WAV file.
    'pan' ranges from -1.0 (hard left) to 1.0 (hard right).
    Uses constant-power panning formula.
    """
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
    """Plays a WAV file using local command-line players."""
    try:
        if sys.platform.startswith("linux"):
            subprocess.run(["aplay", "-q", filepath], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif sys.platform == "darwin":
            subprocess.run(["afplay", filepath], check=True)
    except Exception:
        print("\a", end="", flush=True) # visual/bell fallback

def speak_direction(direction, distance):
    """Speaks warning text using espeak on Linux or say on macOS."""
    text = f"{direction} {distance:.1f} meters"
    try:
        if sys.platform.startswith("linux"):
            subprocess.Popen(["espeak", "-v", "en", "-s", "160", text], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif sys.platform == "darwin":
            subprocess.Popen(["say", text])
        else:
            print(f"\n[VOICE] {text}")
    except Exception:
        print(f"\n[VOICE] {text}")

def trigger_haptic_pulse(sector, duration):
    """Activates the physical vibration motor for 'duration' seconds. Falls back to console print."""
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
            # Console simulation output
            sys.stdout.write(f"\r[TACTILE] *VIBRATE {sector.upper()}* ({int(duration*1000)}ms)                ")
            sys.stdout.flush()
            time.sleep(duration)

class FeedbackGeneratorThread(threading.Thread):
    """
    Background output thread. Generates beeps, speech, or haptic vibrations
    at dynamic speeds based on obstacle distance.
    """
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
        print(f"[Output] Feedback thread initialized in {AUDIO_FEEDBACK_MODE} mode.")
        while running:
            dist = self.closest_distance
            angle = self.closest_angle
            sector = self.closest_sector
            
            if dist >= MAX_DETECT_DISTANCE_M:
                time.sleep(0.1)
                continue
                
            # Determine beeping/pulsing rate
            if dist <= MIN_DETECT_DISTANCE_M:
                interval = 0.04
            else:
                ratio = (dist - MIN_DETECT_DISTANCE_M) / (MAX_DETECT_DISTANCE_M - MIN_DETECT_DISTANCE_M)
                interval = 0.08 + ratio * 0.82
                
            if AUDIO_FEEDBACK_MODE == "VOICE_TTS":
                # Speech Synthesis warning path
                now = time.time()
                if now - self.last_speech_time >= self.speech_cooldown:
                    speak_direction(sector, dist)
                    self.last_speech_time = now
                time.sleep(0.1)
                
            elif AUDIO_FEEDBACK_MODE == "HAPTIC_GPIO":
                # Vibrational feedback warning path
                pulse_duration = 0.08 if dist > MIN_DETECT_DISTANCE_M else 0.15
                trigger_haptic_pulse(sector, pulse_duration)
                time.sleep(interval)
                
            else:
                # Spatial Stereo Beeps path
                angle_rad = math.radians(angle)
                pan = math.sin(angle_rad) 
                
                # Pitch denotes vertical direction (Front=High, Back=Low, Side=Medium)
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
                
        # Clean up temp file on exit
        try:
            if os.path.exists(self.temp_wav):
                os.remove(self.temp_wav)
        except Exception:
            pass

def fit_side_wall(points):
    """
    Fits a linear line x = m*y + c to side points.
    Returns (m, c) if fitting error is low (RMSE < 0.08m) and span is sufficient (>1.2m).
    """
    if len(points) < 8:
        return None
    n = len(points)
    sum_y = sum(p[1] for p in points)
    sum_x = sum(p[0] for p in points)
    sum_y2 = sum(p[1]**2 for p in points)
    sum_yx = sum(p[1]*p[0] for p in points)
    
    denom = (n * sum_y2 - sum_y**2)
    if abs(denom) < 1e-6:
        return None
    m = (n * sum_yx - sum_y * sum_x) / denom
    c = (sum_x - m * sum_y) / n
    
    # Calculate RMS error and Y-span
    errors = []
    ys = [p[1] for p in points]
    for p in points:
        dist = abs(p[0] - (m * p[1] + c)) / math.sqrt(1 + m**2)
        errors.append(dist**2)
    rmse = math.sqrt(sum(errors) / n)
    span_y = max(ys) - min(ys)
    
    if rmse < 0.08 and span_y > 1.2:
        return m, c
    return None

def process_360_scan_data(scan):
    """
    Parses a 360-degree scan, divides it into 4 directional sectors,
    applies a linear wall detection filter on the Left/Right sectors,
    and returns the closest non-wall obstacle details.
    """
    sectors = {
        "front": [],
        "left": [],
        "right": [],
        "behind": []
    }
    
    for angle, distance in scan.items():
        if distance <= 0.08 or distance > 10.0:
            continue
            
        rel_angle = angle
        if rel_angle > 180:
            rel_angle -= 360
            
        # Convert to relative Cartesian coordinates
        angle_rad = math.radians(rel_angle)
        x = distance * math.sin(angle_rad)
        y = distance * math.cos(angle_rad)
        
        pt_info = {"dist": distance, "angle": rel_angle, "x": x, "y": y}
        
        if -45 <= rel_angle <= 45:
            sectors["front"].append(pt_info)
        elif 45 < rel_angle <= 135:
            sectors["right"].append(pt_info)
        elif -135 <= rel_angle < -45:
            sectors["left"].append(pt_info)
        else:
            sectors["behind"].append(pt_info)
            
    # Check for wall on Left
    left_wall = None
    if len(sectors["left"]) >= 8:
        left_pts_list = [(pt["x"], pt["y"]) for pt in sectors["left"]]
        left_wall = fit_side_wall(left_pts_list)
        
    # Check for wall on Right
    right_wall = None
    if len(sectors["right"]) >= 8:
        right_pts_list = [(pt["x"], pt["y"]) for pt in sectors["right"]]
        right_wall = fit_side_wall(right_pts_list)
        
    # Filter points in Left/Right if wall is detected
    filtered_sectors = {
        "front": sectors["front"],
        "behind": sectors["behind"],
        "left": [],
        "right": []
    }
    
    # Left Sector Filtering
    for pt in sectors["left"]:
        if left_wall:
            m, c = left_wall
            # Distance of point to the wall line: x - m*y - c = 0
            # Since Left is at negative x, points closer to user have larger (less negative) x.
            # Thus, we compute how much closer it is.
            wall_x_at_y = m * pt["y"] + c
            dist_closer_than_wall = pt["x"] - wall_x_at_y
            
            if dist_closer_than_wall > 0.25: # sticks out from wall by > 25cm
                filtered_sectors["left"].append(pt)
        else:
            filtered_sectors["left"].append(pt)
            
    # Right Sector Filtering
    for pt in sectors["right"]:
        if right_wall:
            m, c = right_wall
            # Since Right is at positive x, points closer to user have smaller x.
            wall_x_at_y = m * pt["y"] + c
            dist_closer_than_wall = wall_x_at_y - pt["x"]
            
            if dist_closer_than_wall > 0.25: # sticks out from wall by > 25cm
                filtered_sectors["right"].append(pt)
        else:
            filtered_sectors["right"].append(pt)
            
    # Find closest remaining obstacle
    closest_distance = float('inf')
    closest_angle = 0
    closest_sector = "safe"
    
    for sec_name, pts in filtered_sectors.items():
        for pt in pts:
            if pt["dist"] < closest_distance:
                closest_distance = pt["dist"]
                closest_angle = pt["angle"]
                closest_sector = sec_name
                
    return closest_distance, closest_angle, closest_sector, (left_wall is not None), (right_wall is not None)

def main():
    global running, AUDIO_FEEDBACK_MODE
    print("==============================================")
    print("      I-HEAR: Blind Navigation Headwear      ")
    print("==============================================")
    
    print("Select Output Feedback Mode:")
    print("  1. Spatial Stereo Beeps (Tone pitch & pan)")
    print("  2. Directional Voice Speech (espeak warnings)")
    print("  3. Haptic GPIO Band (Vibration motors) [Tactile]")
    
    # Auto-select from CLI argument or default to 1
    choice = "1"
    if len(sys.argv) > 1 and sys.argv[1] in ["1", "2", "3"]:
        choice = sys.argv[1]
        
    if choice == "2":
        AUDIO_FEEDBACK_MODE = "VOICE_TTS"
    elif choice == "3":
        AUDIO_FEEDBACK_MODE = "HAPTIC_GPIO"
        
    print(f"[System] Selected Feedback Mode: {AUDIO_FEEDBACK_MODE}")
    
    # Initialize LiDAR
    lidar = YDLidarX4(port=LIDAR_PORT, baudrate=BAUDRATE, is_simulated=IS_SIMULATION)
    if not lidar.connect():
        print("[Fatal] Could not initialize LiDAR interface.")
        sys.exit(1)
        
    # Start output feedback thread
    feedback_thread = FeedbackGeneratorThread()
    feedback_thread.start()
    
    # Start scanning
    lidar.start_scanning()
    
    print("\nPress Ctrl+C to terminate prototype execution.\n")
    
    try:
        while True:
            scan = lidar.get_scan()
            dist, angle, sector, left_wall, right_wall = process_360_scan_data(scan)
            
            # Send current closest obstacle details to feedback loop
            feedback_thread.update_obstacle(dist, angle, sector)
            
            # Wall indicators text
            wall_str = ""
            if left_wall: wall_str += "[L_WALL] "
            if right_wall: wall_str += "[R_WALL] "
            
            # Print HUD readout
            if dist < MAX_DETECT_DISTANCE_M:
                status = "DANGER" if dist <= MIN_DETECT_DISTANCE_M else "WARNING"
                bar_len = int((MAX_DETECT_DISTANCE_M - dist) * 12)
                visual_bar = "█" * bar_len + "░" * (24 - bar_len)
                
                # For Haptic GPIO, keep logs clean since console displays vibrate indicators
                if AUDIO_FEEDBACK_MODE != "HAPTIC_GPIO":
                    print(f"[{status}] {wall_str}Nearest: {dist:.2f}m in {sector.upper():6s} at {angle:4d}° | {visual_bar}", end="\r", flush=True)
            else:
                if AUDIO_FEEDBACK_MODE != "HAPTIC_GPIO":
                    print(f"[ SAFE ] {wall_str}Clear in all directions (No obstacles within {MAX_DETECT_DISTANCE_M}m)               ", end="\r", flush=True)
                
            time.sleep(0.1)
            
    except KeyboardInterrupt:
        print("\n\n[System] Stopping components...")
    finally:
        running = False
        lidar.disconnect()
        # Clean up GPIOs
        if GPIO:
            try:
                GPIO.cleanup()
                print("[GPIO] Pins reset successfully.")
            except Exception:
                pass
        print("[System] Done. Goodbye!")

if __name__ == "__main__":
    main()
