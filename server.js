const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const app = express();

const PORT = process.env.PORT || 3000;
const TEMP_DIR = path.join(__dirname, 'temp');
//const ytdelp = "C:\\yt-dlp\\yt-dlp.exe";
const ytdelp = 'yt-dlp';
// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use('/temp', express.static(TEMP_DIR));

// Ensure temp directory exists
async function ensureTempDir() {
    try {
        await fs.mkdir(TEMP_DIR, { recursive: true });
    } catch (error) {
        console.error('Error creating temp directory:', error);
    }
}

// Clean up old files (older than 30 minutes)
async function cleanupOldFiles() {
    try {
        const files = await fs.readdir(TEMP_DIR);
        const now = Date.now();
        
        for (const file of files) {
            const filePath = path.join(TEMP_DIR, file);
            const stats = await fs.stat(filePath);
            const fileAge = now - stats.mtime.getTime();
            
            // Delete files older than 30 minutes
            if (fileAge > 30 * 60 * 1000) {
                await fs.unlink(filePath);
                console.log(`Cleaned up old file: ${file}`);
            }
        }
    } catch (error) {
        console.error('Error during cleanup:', error);
    }
}

// Validate YouTube URL
function isValidYouTubeURL(url) {
    const patterns = [
        /^https?:\/\/(www\.)?youtube\.com\/watch\?v=[\w-]+/,
        /^https?:\/\/(www\.)?youtube\.com\/embed\/[\w-]+/,
        /^https?:\/\/(www\.)?youtu\.be\/[\w-]+/,
        /^https?:\/\/(www\.)?youtube\.com\/v\/[\w-]+/
    ];
    return patterns.some(pattern => pattern.test(url));
}

// Get available formats for the video
function getAvailableFormats(url) {
    return new Promise((resolve, reject) => {
        const ytdlp = spawn(ytdelp, ['-F', '--no-playlist', url]);
        let stdout = '';
        let stderr = '';
        
        ytdlp.stdout.on('data', (data) => {
            stdout += data.toString();
        });
        
        ytdlp.stderr.on('data', (data) => {
            stderr += data.toString();
        });
        
        ytdlp.on('close', (code) => {
            if (code === 0) {
                resolve(stdout);
            } else {
                reject(new Error(`Failed to get formats: ${stderr}`));
            }
        });
    });
}

// Get video info including available qualities
function getVideoInfo(url) {
    return new Promise((resolve, reject) => {
        const ytdlp = spawn(ytdelp, ['--dump-json', '--no-playlist', url]);
        let stdout = '';
        let stderr = '';
        
        ytdlp.stdout.on('data', (data) => {
            stdout += data.toString();
        });
        
        ytdlp.stderr.on('data', (data) => {
            stderr += data.toString();
        });
        
        ytdlp.on('close', async (code) => {
            if (code === 0) {
                try {
                    const info = JSON.parse(stdout);
                    
                    // Get available video qualities
                    const availableQualities = [];
                    if (info.formats) {
                        const videoFormats = info.formats
                            .filter(f => f.vcodec !== 'none' && f.height)
                            .sort((a, b) => (b.height || 0) - (a.height || 0));
                        
                        const uniqueQualities = [...new Set(videoFormats.map(f => f.height))];
                        availableQualities.push(...uniqueQualities.map(height => `${height}p`));
                    }
                    
                    resolve({
                        title: info.title,
                        duration: info.duration,
                        uploader: info.uploader,
                        thumbnail: info.thumbnail,
                        availableQualities: availableQualities
                    });
                } catch (error) {
                    reject(new Error('Failed to parse video info'));
                }
            } else {
                reject(new Error(`Failed to get video info: ${stderr}`));
            }
        });
    });
}

// Download video with specific quality
function downloadVideo(url, outputPath, format = 'mp4', quality = 'best') {
    return new Promise((resolve, reject) => {
        let args;
        
        if (format === 'mp3') {
            // For MP3: get best audio and convert to true MP3
            args = [
                '--extract-audio',
                '--audio-format', 'mp3',
                '--audio-quality', '0',  // Best quality
                '--embed-thumbnail',
                '--add-metadata',
                '-o', outputPath,
                '--no-playlist',
                url
            ];
        } else {
            // For video: Enhanced format selection for high quality
            let formatSelector;
            
            if (quality === 'best') {
                // Get the absolute best quality available
                formatSelector = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best[ext=mp4]/best';
            } else if (quality === '4k' || quality === '2160p') {
                formatSelector = 'bestvideo[height<=2160][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=2160]+bestaudio/best[height<=2160]';
            } else if (quality === '1440p') {
                formatSelector = 'bestvideo[height<=1440][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1440]+bestaudio/best[height<=1440]';
            } else if (quality === '1080p') {
                formatSelector = 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]';
            } else if (quality === '720p') {
                formatSelector = 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]';
            } else {
                formatSelector = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best[ext=mp4]/best';
            }
            
            args = [
                '-f', formatSelector,
                '--merge-output-format', 'mp4',
                '-o', outputPath,
                '--no-playlist',
                '--prefer-ffmpeg',  // Use ffmpeg for better merging
                '--ffmpeg-location', 'ffmpeg',  // Assumes ffmpeg is in PATH
                url
            ];
        }
        
        console.log('yt-dlp command:', ytdelp, args.join(' '));
        
        const ytdlp = spawn(ytdelp, args);
        let stderr = '';
        
        ytdlp.stdout.on('data', (data) => {
            console.log('yt-dlp stdout:', data.toString());
        });
        
        ytdlp.stderr.on('data', (data) => {
            stderr += data.toString();
            console.log('yt-dlp progress:', data.toString());
        });
        
        ytdlp.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Download failed: ${stderr}`));
            }
        });
    });
}

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.post('/api/video-info', async (req, res) => {
    try {
        const { url } = req.body;
        
        if (!url || !isValidYouTubeURL(url)) {
            return res.status(400).json({ error: 'Invalid YouTube URL' });
        }
        
        const info = await getVideoInfo(url);
        res.json(info);
    } catch (error) {
        console.error('Error getting video info:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/formats', async (req, res) => {
    try {
        const { url } = req.body;
        
        if (!url || !isValidYouTubeURL(url)) {
            return res.status(400).json({ error: 'Invalid YouTube URL' });
        }
        
        const formats = await getAvailableFormats(url);
        res.json({ formats });
    } catch (error) {
        console.error('Error getting formats:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/download', async (req, res) => {
    try {
        const { url, format, quality = 'best' } = req.body;
        
        if (!url || !isValidYouTubeURL(url)) {
            return res.status(400).json({ error: 'Invalid YouTube URL' });
        }
        
        if (!['mp4', 'mp3'].includes(format)) {
            return res.status(400).json({ error: 'Invalid format. Use mp4 or mp3' });
        }
        
        const validQualities = ['best', '2160p', '4k', '1440p', '1080p', '720p', '480p', '360p'];
        if (format === 'mp4' && !validQualities.includes(quality)) {
            return res.status(400).json({ error: 'Invalid quality. Use: ' + validQualities.join(', ') });
        }
        
        // Get video info first
        const info = await getVideoInfo(url);
        const safeTitle = info.title.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_');
        
        // Generate unique filename
        const timestamp = Date.now();
        const hash = crypto.randomBytes(4).toString('hex');
        const extension = format;
        const qualityTag = format === 'mp4' ? `_${quality}` : '';
        const filename = `${safeTitle}_${timestamp}_${hash}${qualityTag}.${extension}`;
        const outputPath = path.join(TEMP_DIR, `${safeTitle}_${timestamp}_${hash}${qualityTag}.%(ext)s`);
        
        // Download the file
        await downloadVideo(url, outputPath, format, quality);
        
        // Find the actual downloaded file
        const files = await fs.readdir(TEMP_DIR);
        console.log('Files in temp directory:', files);
        console.log('Looking for files containing:', `${safeTitle}_${timestamp}_${hash}`);
        
        const downloadedFile = files.find(file => {
            const matchesPattern = file.includes(`${safeTitle}_${timestamp}_${hash}`);
            const hasCorrectExtension = file.endsWith(`.${extension}`);
            console.log(`Checking file: ${file}, matches pattern: ${matchesPattern}, correct extension: ${hasCorrectExtension}`);
            return matchesPattern && hasCorrectExtension;
        });
        
        if (!downloadedFile) {
            // Try to find any file with the timestamp and hash (in case extension differs)
            const alternativeFile = files.find(file => 
                file.includes(`${timestamp}_${hash}`)
            );
            
            if (alternativeFile) {
                console.log('Found alternative file:', alternativeFile);
                const actualExtension = path.extname(alternativeFile).substring(1);
                const downloadUrl = `/temp/${alternativeFile}`;
                
                return res.json({
                    success: true,
                    filename: alternativeFile,
                    downloadUrl: downloadUrl,
                    title: info.title,
                    quality: quality,
                    format: actualExtension,
                    note: `Downloaded as ${actualExtension} instead of requested ${extension}`
                });
            }
            
            throw new Error(`Downloaded file not found. Available files: ${files.join(', ')}`);
        }
        
        const downloadUrl = `/temp/${downloadedFile}`;
        
        res.json({
            success: true,
            filename: downloadedFile,
            downloadUrl: downloadUrl,
            title: info.title,
            quality: quality,
            format: format
        });
        
    } catch (error) {
        console.error('Error downloading:', error);
        console.error('Error stack:', error.stack);
        
        // Try to list files in temp directory for debugging
        try {
            const files = await fs.readdir(TEMP_DIR);
            console.log('Available files in temp directory:', files);
        } catch (fsError) {
            console.error('Could not read temp directory:', fsError);
        }
        
        res.status(500).json({ 
            error: error.message,
            details: 'Check server console for more information'
        });
    }
});

// Start server
app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    await ensureTempDir();
    
    // Clean up old files every 15 minutes
    setInterval(cleanupOldFiles, 15 * 60 * 1000);
    
    console.log('YouTube Downloader Server is ready!');
    console.log('Note: Make sure ffmpeg is installed and available in your PATH for best results');
});

module.exports = app;