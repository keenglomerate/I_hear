FROM python:3.9-slim

# Install system dependencies for audio (ALSA) and text-to-speech (espeak)
RUN apt-get update && apt-get install -y \
    alsa-utils \
    espeak \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy hardware code files
COPY hardware/ /app/

# Install python dependencies
RUN pip install pyserial

# Start the application
ENTRYPOINT ["python", "main.py"]
