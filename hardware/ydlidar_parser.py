import time
try:
    import serial
except ImportError:
    serial = None
import threading
import math
import random

class YDLidarX4:
    """
    Python driver and simulator for the YDLIDAR X4 2D Laser Scanner.
    Can operate in both real hardware mode (via serial) and simulation mode.
    """
    def __init__(self, port="/dev/ttyUSB0", baudrate=115200, is_simulated=False):
        self.port = port
        self.baudrate = baudrate
        self.is_simulated = is_simulated
        self.serial_port = None
        self.is_scanning = False
        self.read_thread = None
        
        # Buffer to store the latest 360-degree scan
        # Format: dict with integer angle keys (0-359) and distance values (in meters)
        self.latest_scan = {angle: 0.0 for angle in range(360)}
        self.lock = threading.Lock()
        
        # Simulation parameters (hallway configuration to test side-wall filtering)
        self.sim_obstacles = [
            {"type": "wall", "x1": -1.2, "y1": -3.0, "x2": -1.2, "y2": 3.0},   # Left hallway wall
            {"type": "wall", "x1": 1.2, "y1": -3.0, "x2": 1.2, "y2": 3.0},    # Right hallway wall
            {"type": "wall", "x1": -2.0, "y1": 2.5, "x2": 2.0, "y2": 2.5},    # Wall blocking front path
            {"type": "circle", "cx": -0.8, "cy": 1.0, "radius": 0.20},         # Obstacle front-left (sticks out)
            {"type": "circle", "cx": 0.8, "cy": 1.6, "radius": 0.25},          # Obstacle front-right (sticks out)
        ]
        
    def connect(self):
        """Connects to the LiDAR serial port, TCP socket bridge, or initializes simulator."""
        if not self.is_simulated and serial is None and not self.port.startswith("tcp://"):
            print("[LiDAR] Warning: 'pyserial' library not found. Cannot connect to real hardware.")
            print("[LiDAR] Auto-falling back to SIMULATION mode.")
            self.is_simulated = True

        if self.is_simulated:
            print("[LiDAR] Initializing in SIMULATION mode.")
            return True

        if self.port.startswith("tcp://"):
            try:
                import socket
                parts = self.port.replace("tcp://", "").split(":")
                host = parts[0]
                port = int(parts[1])
                print(f"[LiDAR] Connecting to TCP serial bridge on {host}:{port}...")
                
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock.connect((host, port))
                sock.settimeout(1.0)
                
                class SocketSerialWrapper:
                    def __init__(self, sock):
                        self.sock = sock
                        self.is_open = True
                        
                    def read(self, n):
                        try:
                            # Read up to 1024 bytes instead of just 1 byte for performance
                            return self.sock.recv(max(n, 1024))
                        except socket.timeout:
                            return b''
                        except Exception:
                            return b''
                            
                    def write(self, data):
                        try:
                            self.sock.sendall(data)
                        except Exception:
                            pass
                            
                    def close(self):
                        self.is_open = False
                        self.sock.close()
                        
                    @property
                    def in_waiting(self):
                        return 1 if self.is_open else 0
                        
                    def reset_input_buffer(self):
                        pass
                
                self.serial_port = SocketSerialWrapper(sock)
                print("[LiDAR] Connected to TCP serial bridge successfully.")
                return True
            except Exception as e:
                print(f"[LiDAR] TCP Connection failed: {e}")
                print("[LiDAR] Auto-falling back to SIMULATION mode.")
                self.is_simulated = True
                return True

        try:
            print(f"[LiDAR] Connecting to YDLIDAR X4 on {self.port} at {self.baudrate} baud...")
            self.serial_port = serial.Serial(
                port=self.port,
                baudrate=self.baudrate,
                bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_ONE,
                timeout=1.0
            )
            # DTR/RTS lines control the motor enable on some board adapters
            self.serial_port.dtr = True
            self.serial_port.rts = True
            time.sleep(0.5)
            print("[LiDAR] Serial port opened successfully.")
            return True
        except Exception as e:
            print(f"[LiDAR] Connection failed: {e}")
            print("[LiDAR] Auto-falling back to SIMULATION mode.")
            self.is_simulated = True
            return True

    def start_scanning(self):
        """Starts the background acquisition thread."""
        if self.is_scanning:
            return
            
        self.is_scanning = True
        
        if not self.is_simulated:
            # Send start command to LiDAR: 0xA5 0x60 (Start scan)
            # YDLIDAR protocol uses 0xA5 as command prefix
            print("[LiDAR] Sending start scan command...")
            self.serial_port.write(b'\xA5\x60')
            time.sleep(0.1)
            
        self.read_thread = threading.Thread(target=self._run, daemon=True)
        self.read_thread.start()
        print("[LiDAR] Scan thread started.")

    def stop_scanning(self):
        """Stops scanning and turns off the motor."""
        if not self.is_scanning:
            return
            
        self.is_scanning = False
        if self.read_thread:
            self.read_thread.join(timeout=2.0)
            
        if not self.is_simulated and self.serial_port:
            # Send stop command: 0xA5 0x65
            print("[LiDAR] Sending stop command...")
            self.serial_port.write(b'\xA5\x65')
            time.sleep(0.1)
            self.serial_port.reset_input_buffer()
            
        print("[LiDAR] Scan thread stopped.")

    def disconnect(self):
        """Disconnects serial interface."""
        self.stop_scanning()
        if self.serial_port and self.serial_port.is_open:
            self.serial_port.close()
            print("[LiDAR] Serial connection closed.")

    def get_scan(self):
        """Returns a copy of the latest 360-degree scan."""
        with self.lock:
            return self.latest_scan.copy()

    def _run(self):
        """Background thread loop for data ingestion."""
        if self.is_simulated:
            self._run_simulator()
        else:
            self._run_hardware()

    def _run_simulator(self):
        """Generates mock LiDAR scan data based on simulated obstacles."""
        angle_step = 1.0 # degrees
        hz = 7.0         # X4 typical rotation rate (6-12 Hz)
        
        # Simulation loop
        while self.is_scanning:
            scan_data = {}
            for angle_deg in range(360):
                angle_rad = math.radians(angle_deg)
                
                # Laser origin at (0, 0)
                # Ray direction vector
                dx = math.sin(angle_rad) # Angle 0 is front (Y-axis), clockwise rotation is positive
                dy = math.cos(angle_rad) 
                
                min_dist = 10.0 # Max simulated distance: 10m
                
                for obs in self.sim_obstacles:
                    dist = 10.0
                    if obs["type"] == "wall":
                        # Ray-line segment intersection
                        x1, y1, x2, y2 = obs["x1"], obs["y1"], obs["x2"], obs["y2"]
                        # Ray: x = t*dx, y = t*dy
                        # Line: (x-x1)(y2-y1) - (y-y1)(x2-x1) = 0
                        # Solve for t: t*(dx*(y2-y1) - dy*(x2-x1)) = x1*(y2-y1) - y1*(x2-x1)
                        denom = dx * (y2 - y1) - dy * (x2 - x1)
                        if abs(denom) > 1e-6:
                            t = (x1 * (y2 - y1) - y1 * (x2 - x1)) / denom
                            if t > 0.1: # Minimum range 10cm
                                # Check if intersection point lies on the line segment
                                ix = t * dx
                                iy = t * dy
                                # Check boundaries with a tolerance
                                min_x, max_x = min(x1, x2) - 0.01, max(x1, x2) + 0.01
                                min_y, max_y = min(y1, y2) - 0.01, max(y1, y2) + 0.01
                                if min_x <= ix <= max_x and min_y <= iy <= max_y:
                                    dist = t
                    elif obs["type"] == "circle":
                        # Ray-circle intersection
                        cx, cy, r = obs["cx"], obs["cy"], obs["radius"]
                        # Circle equation: (x - cx)^2 + (y - cy)^2 = r^2
                        # Substitute x = t*dx, y = t*dy
                        # t^2*(dx^2 + dy^2) - 2*t*(dx*cx + dy*cy) + cx^2 + cy^2 - r^2 = 0
                        # dx^2 + dy^2 = 1 since dx, dy is normalized
                        b = -2 * (dx * cx + dy * cy)
                        c = cx**2 + cy**2 - r**2
                        discriminant = b**2 - 4*c
                        if discriminant >= 0:
                            t1 = (-b - math.sqrt(discriminant)) / 2.0
                            t2 = (-b + math.sqrt(discriminant)) / 2.0
                            if t1 > 0.1:
                                dist = t1
                            elif t2 > 0.1:
                                dist = t2
                                
                    if dist < min_dist:
                        min_dist = dist
                
                # Add minor Gaussian noise
                noise = random.gauss(0, 0.015)
                measured_dist = max(0.12, min_dist + noise) # YDLIDAR X4 min range: 12cm
                
                # In real lidar, sometimes beams don't return (invalid range)
                # 2% chance of return failure
                if random.random() < 0.02:
                    measured_dist = 0.0
                    
                scan_data[angle_deg] = measured_dist
                
            with self.lock:
                self.latest_scan.update(scan_data)
                
            # Sleep to match scan frequency (1/hz seconds per rotation)
            time.sleep(1.0 / hz)

    def _run_hardware(self):
        """Parses the raw serial data stream from YDLIDAR X4."""
        # Wait for the response descriptor header (7 bytes) after start scan
        # Format of response header: 0xA5 0x5A [4 bytes length/mode] [1 byte type]
        # Then, continuous data packets stream in.
        
        # First, flush buffer and skip descriptor
        try:
            desc = self.serial_port.read(7)
            if len(desc) == 7 and desc[0] == 0xA5 and desc[1] == 0x5A:
                print(f"[LiDAR] Start scan acknowledged. Descriptor: {desc.hex()}")
            else:
                print(f"[LiDAR] Warning: Scan start header not aligned. Received: {desc.hex()}")
        except Exception as e:
            print(f"[LiDAR] Error reading start descriptor: {e}")
            return
            
        byte_buffer = bytearray()
        
        while self.is_scanning:
            try:
                # Read incoming serial bytes
                if self.serial_port.in_waiting > 0:
                    read_bytes = self.serial_port.read(self.serial_port.in_waiting)
                    byte_buffer.extend(read_bytes)
                else:
                    time.sleep(0.002)
                    continue
                    
                # Look for packet header: 0xAA 0x55 (PH) in byte_buffer
                # PH (Packet Header) is 2 bytes: Low byte = 0xAA, High byte = 0x55
                while len(byte_buffer) >= 10:
                    header_index = byte_buffer.find(b'\xAA\x55')
                    if header_index == -1:
                        # Clear buffer except last byte, in case it's 0xAA
                        del byte_buffer[:-1]
                        break
                    
                    if header_index > 0:
                        # Discard bytes before the header
                        del byte_buffer[:header_index]
                        
                    if len(byte_buffer) < 10:
                        break # Need more bytes to parse header fields
                        
                    # Parse header fields
                    package_type = byte_buffer[2]
                    sample_quantity = byte_buffer[3]
                    
                    # Size of sample data is sample_quantity * 2 bytes
                    packet_size = 10 + (sample_quantity * 2)
                    
                    if len(byte_buffer) < packet_size:
                        break # Complete packet not received yet, wait for more data
                        
                    # Extract the packet
                    packet = byte_buffer[:packet_size]
                    del byte_buffer[:packet_size]
                    
                    # Parse Starting Angle (FSA) and End Angle (LSA)
                    fsa = packet[4] | (packet[5] << 8)
                    lsa = packet[6] | (packet[7] << 8)
                    
                    # Convert raw angles to degrees
                    # FSA/LSA format: Angle = (Val >> 1) / 64.0 (in degrees)
                    angle_fsa = (fsa >> 1) / 64.0
                    angle_lsa = (lsa >> 1) / 64.0
                    
                    # Calculate angle step
                    angle_diff = angle_lsa - angle_fsa
                    if angle_diff < 0:
                        angle_diff += 360.0
                        
                    step = angle_diff / (sample_quantity - 1) if sample_quantity > 1 else 0
                    
                    # Parse samples
                    scan_chunk = {}
                    for i in range(sample_quantity):
                        sample_offset = 10 + (i * 2)
                        raw_sample = packet[sample_offset] | (packet[sample_offset + 1] << 8)
                        
                        # Distance: raw_sample / 4.0 in mm. Let's convert to meters.
                        distance_m = (raw_sample / 4.0) / 1000.0
                        
                        # Correct angle for this sample
                        angle = angle_fsa + (step * i)
                        if angle >= 360.0:
                            angle -= 360.0
                            
                        # Apply angle offset correction based on distance (from datasheet)
                        if distance_m > 0:
                            # Formula: offset = atan(21.8 * (155.3 - dist_mm) / (155.3 * dist_mm))
                            # For simplicity and speed, raw angle is often close enough, 
                            # but we can apply the datasheet correction:
                            dist_mm = distance_m * 1000.0
                            if dist_mm < 155.3:
                                correction = math.degrees(math.atan(21.8 * (155.3 - dist_mm) / (155.3 * dist_mm)))
                            else:
                                correction = 0
                            corrected_angle = angle - correction
                            if corrected_angle < 0:
                                corrected_angle += 360.0
                        else:
                            corrected_angle = angle
                            
                        angle_idx = int(round(corrected_angle)) % 360
                        
                        # Filter out invalid distances (0.0 represents no return or error)
                        if distance_m > 0.08 and distance_m < 10.0:
                            scan_chunk[angle_idx] = distance_m
                        else:
                            scan_chunk[angle_idx] = 0.0
                            
                    # Update thread-safe scan buffer
                    with self.lock:
                        self.latest_scan.update(scan_chunk)
                        
            except Exception as e:
                print(f"[LiDAR] Exception in reader loop: {e}")
                time.sleep(0.1)

if __name__ == "__main__":
    # Test script to run the parser in simulation mode
    lidar = YDLidarX4(is_simulated=True)
    if lidar.connect():
        lidar.start_scanning()
        try:
            for _ in range(5):
                time.sleep(1.0)
                scan = lidar.get_scan()
                # Print non-zero distances in the front sector (350 to 10 degrees)
                front_ranges = []
                for a in range(360):
                    if a <= 15 or a >= 345:
                        d = scan.get(a, 0.0)
                        if d > 0:
                            front_ranges.append(f"{a}°:{d:.2f}m")
                print(f"Front scans: {', '.join(front_ranges[:5])}...")
        finally:
            lidar.disconnect()
