# I-HEAR: LiDAR-Based Assistive Hat for Visually Impaired Navigation

I-HEAR is an assistive technology prototype designed to help blind and visually impaired individuals navigate their surroundings safely. The system consists of a hat equipped with a **2D LiDAR** sensor, a **directional haptic vibration band**, and a **bone conduction earphone** to deliver real-time spatial awareness.

---

## 📂 Project Structure

```
i_hear/
├── README.md                 # Project Overview & System Guide (this file)
├── Dockerfile                # Multi-stage image setup for running the hardware loop in containers
├── run_simulator.py          # Launcher script for the interactive visual web simulator
├── sim/                      # Interactive Web Simulator Client
│   ├── index.html            # Web dashboard interface
│   ├── style.css             # Glassmorphism dark UI styling
│   └── app.js                # Raycast simulation, Web Audio beeper, vibration, and wall filters
└── hardware/                 # Deployable Python Scripts for Laptop & Raspberry Pi
    ├── main.py               # Main control loop, distance parser, ALSA audio & GPIO haptics thread
    └── ydlidar_parser.py     # Serial data packet decoder and simulator fallback class
```

---

## 1. Web-Based Simulator Dashboard

To test the spatial awareness logic, beeping frequencies, haptic indicators, and wall suppression filters, use the **Visual Web Simulator**. It features:
*   An interactive 2D room map with draggable circular obstacles, walls, and a user avatar.
*   A simulated 360-degree LiDAR raycasting showing hit coordinates.
*   Dynamic audio feedback via the **Web Audio API** (stereo-panned beeps speed up as obstacles get closer).
*   **Intelligent Side-Wall Suppression:** Linear regression traces detected side walls in a dashed cyan line and silences continuous walls to prevent noise fatigue.
*   **Haptic Band HUD:** A vibrating visual display that mimics the haptic nodes (Front, Left, Right, Behind).
*   **Physical Mobile Vibration:** Uses the HTML5 `navigator.vibrate` API. Opening the URL on a smartphone physically vibrates the device in synced pulses!

### How to Run the Simulator:
Run the launcher script from the root directory:
```bash
python3 run_simulator.py
```
This boots up a local web server and opens the dashboard in your default browser at:
👉 **[http://localhost:8000/sim/index.html](http://localhost:8000/sim/index.html)**

---

## 2. Deployable Python Scripts

The python files inside `hardware/` are ready to run natively on your laptop or copy onto your Raspberry Pi.

*   [ydlidar_parser.py](file:///home/keen/Desktop/Projects and Codes/i_hear/hardware/ydlidar_parser.py): Decodes the raw little-endian bytes from the serial port, parsing package headers (`0x55AA`), starting/ending angles, sample counts, and calculating distances. Falls back to simulated raycasting if serial is disconnected.
*   [main.py](file:///home/keen/Desktop/Projects and Codes/i_hear/hardware/main.py): Divides the scan data into 4 quadrants (Front, Left, Right, Behind), applies the wall suppression filter, and triggers alarm feedback (spatial tones, TTS warnings, or GPIO haptics).

### Run Command Options:
Run the main script in the hardware folder:
```bash
# 1. Run in Simulation mode (mock room)
python3 hardware/main.py 1  # Spatial Beeps
python3 hardware/main.py 2  # espeak Voice directions

# 2. Run in Real mode (connecting to LiDAR on /dev/ttyUSB0)
python3 hardware/main.py 1 --real
```

---

## 3. Intelligent Algorithms & Hardware Guides

### A. Side-Wall Suppression Filter
When walking down a hallway or parallel to a wall, continuous alarms can cause sensory fatigue. 
*   **How it works:** The system runs a linear regression line fit ($x = m \cdot y + c$) on the Left/Right point clouds. If the fitting error is low ($\text{RMSE} < 8\text{cm}$) and the line length is $> 1.2\text{m}$, the system classifies it as a wall and **silences warnings**.
*   **Protrusion Bypass:** If an object sticks out of the wall towards the user by more than $25\text{cm}$ (e.g., a fire extinguisher), the filter ignores the wall and immediately warns the user!

### B. Directional Haptic Band (Vibration)
For silent, tactile navigation, a haptic band lining the hat band utilizes 4 flat coin vibration motors:
*   **Pin mapping (BCM):** Front = `GPIO 17` | Left = `GPIO 27` | Right = `GPIO 22` | Behind = `GPIO 23`.
*   **NPN Transistor Driver Circuit:**
    *   `GPIO Pin` ➔ $1\text{k}\Omega$ Resistor ➔ **Transistor Base**
    *   `Motor Negative (-)` ➔ **Transistor Collector**
    *   `Motor Positive (+)` ➔ **3.3V Pin**
    *   `Transistor Emitter` ➔ **GND Pin**
    *   *Tip:* Connect a 1N4007 diode parallel to the motor terminals (cathode to 3.3V) for inductive flyback protection.

---

## 4. USB LiDAR Setup on Laptop/PC

If you are running the LiDAR on a laptop rather than a Raspberry Pi:
1.  Plug the LiDAR USB UART adapter into a USB port.
2.  Add your user to the `dialout` group to gain permission to read the port:
    ```bash
    sudo usermod -a -G dialout $USER
    # Log out and log back in for changes to apply
    ```
3.  **Baud Rate Note:** Standard YDLIDAR documentation specifies a `128000` baud rate. However, some hardware revisions (including ours) utilize **`115200`** baud rate. This has been pre-configured as the default.
4.  **Motor Power Control:** The USB adapter board maps the serial port's `DTR` line to the motor power circuit. We set DTR to `True` inside the connection sequence to trigger the laser rotation.

---

## 5. Docker Integration
To run the project inside a sandboxed container while still accessing your hardware:

1.  **Build the Docker Image:**
    ```bash
    docker build -t i-hear-nav .
    ```
2.  **Run the Container (with Serial & Audio passthroughs):**
    ```bash
    docker run -it --rm \
      --device /dev/ttyUSB0 \
      --device /dev/snd \
      --group-add dialout \
      --group-add audio \
      i-hear-nav 1 --real
    ```

---

## ⚙️ Technical Specifications (YDLIDAR X4)
*   **Baudrate:** 115,200 bps (default/calibrated) or 128,000 bps
*   **Frequency:** 6 - 12 Hz (default ~7 Hz)
*   **Range:** 0.12 meters to 10 meters
*   **Packet Sync Header:** `0x55AA` (little-endian bytes: `0xAA 0x55`)
