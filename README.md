# I-HEAR: Lidar-Based Assistive Hat for Visually Impaired Navigation

I-HEAR is an assistive technology prototype designed to help blind and visually impaired individuals navigate their surroundings more safely. The system consists of a hat equipped with a **YDLIDAR X4 2D LiDAR** sensor and a **bone conduction earphone** to deliver real-time spatial awareness.

## System Architecture

The project is structured as follows:

```
i_hear/
├── README.md                 # Project Overview & System Guide (this file)
├── run_simulator.py          # Launcher script for the interactive visual web simulator
├── sim/                      # Interactive Web Simulator Client
│   ├── index.html            # Web dashboard interface
│   ├── style.css             # Glassmorphism dark UI styling
│   └── app.js                # Raycast simulation, Web Audio beeper, and HUD logic
└── hardware/                 # Deployable Python Scripts for Raspberry Pi
    ├── main.py               # Main control loop, distance parser, ALSA audio warning thread
    └── ydlidar_parser.py     # Serial data packet decoder and simulator fallback class
```

---

## 1. Web-Based Simulator

To test the spatial awareness logic, beeping frequencies, and field of view configurations before your hardware arrives, use the **Visual Web Simulator**. It features:
*   An interactive 2D room map with draggable circular and wall obstacles.
*   A draggable player representation with directional indicator (move using **WASD / Arrow Keys** or mouse).
*   Real-time 360-degree LiDAR raycasting showing hit coordinates.
*   Dynamic audio feedback via the **Web Audio API** (beeps speed up as obstacles enter the front warning cone).
*   Optional **Text-to-Speech (TTS)** warnings.
*   Sliders to tune settings (detection angle cone, danger and safety thresholds, beep pitch).

### How to Run the Simulator:
Run the launcher script from the root directory:
```bash
python3 run_simulator.py
```
This boots up a local web server and automatically opens the dashboard in your default browser at:
👉 **[http://localhost:8000/sim/index.html](http://localhost:8000/sim/index.html)**

---

## 2. Deployable Python Scripts

The python files inside `hardware/` are ready to copy directly onto your Raspberry Pi once your components arrive.

*   [ydlidar_parser.py](file:///home/keen/i_hear/hardware/ydlidar_parser.py): Decodes the raw little-endian bytes from the serial port (at 128000 baud), parsing package headers (`0x55AA`), starting/ending angles, sample counts, and calculating distances. If no hardware is connected, it automatically falls back to generating mock scans.
*   [main.py](file:///home/keen/i_hear/hardware/main.py): Filters coordinates in the warning sector (e.g. front 60-degree cone), finds the closest object, and triggers beeps.

### Hardware Sound Cues:
To avoid heavy python audio dependency compiles (which often fail on headless IoT boards), `main.py` generates a custom WAV file on startup and uses the system utility `aplay` (part of the standard `alsa-utils` package) to play beeps with minimal latency. If `aplay` is missing, it will output terminal audio alerts (`\a` beep) and log warnings to the screen.

---

## 3. Hardware Guide & Controller Selection

### Board Comparison
*   **Raspberry Pi 4 / 5 (Recommended):** Highly active community support, standard Python library installations, excellent compatibility, and reliable Bluetooth audio connection for bone conduction earphones. The Raspberry Pi 4 is more than powerful enough for raw 2D Lidar parsing. A Pi 5 can be used as well, but requires slightly more power (5V, 5A).
*   **Intel Joule 570x (Not Recommended):** Released in 2016 and discontinued by Intel in 2017. Finding compatible modern Linux OS images, driver support, and troubleshooting resources will be extremely difficult compared to the Pi ecosystem.

### Setup Steps
1.  **Mount the LiDAR:** Place the YDLIDAR X4 facing forward on top of the hat. Make sure it has a clear 360-degree horizontal view.
2.  **Connect to Raspberry Pi:**
    *   Connect the LiDAR's 8-pin connector cable to the included UART-to-USB CP2102 adapter board.
    *   Plug the Micro-USB cable from the adapter board into a USB port on your Raspberry Pi.
    *   The OS will mount it as a serial device, typically `/dev/ttyUSB0`.
3.  **Connect Headphones:** Pair your bone conduction earphones via Bluetooth or plug them into the 3.5mm audio jack.
4.  **Install dependencies and run:**
    ```bash
    sudo apt update && sudo apt install python3-pip alsa-utils -y
    pip3 install pyserial
    
    # Run the hardware control loop:
    # (Edit main.py to set IS_SIMULATION = False)
    python3 hardware/main.py
    ```

---

## Technical Specifications (YDLIDAR X4)
*   **Baudrate:** 128,000 bps
*   **Frequency:** 6 - 12 Hz (default ~7 Hz)
*   **Range:** 0.12 meters to 10 meters
*   **Packet Sync Header:** `0x55AA`
*   **Angular Resolution:** ~0.5° to 1° depending on frequency
