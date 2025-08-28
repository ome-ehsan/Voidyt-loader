#!/bin/bash

# Install system dependencies (if Aptfile doesn't work)
# apt-get update && apt-get install -y python3 python3-pip ffmpeg

# Install Node.js dependencies
npm install

# Install Python dependencies
pip3 install -r requirements.txt

# Verify installations
echo "Checking installations..."
python3 --version
ffmpeg -version
yt-dlp --version

# Create temp directory
mkdir -p temp

# Create public directory if it doesn't exist
mkdir -p public

echo "Build completed successfully!"