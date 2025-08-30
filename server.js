const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const app = express();

const PORT = process.env.PORT || 3000;
const TEMP_DIR = path.join(__dirname, 'temp');

// Dynamic User Agent Pool - rotates automatically
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:109.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15'
];

// Get random user agent
function getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// Dynamic configuration that adapts
function getYtDlpConfig() {
    const userAgent = getRandomUserAgent();
    const randomDelay = Math.floor(Math.random() * 3) + 1; // 1-3 seconds
    
    return {
        userAgent,
        commonArgs: [
            '--user-agent', userAgent,
            '--referer', 'https://www.youtube.com/',
            '--add-header', 'Accept-Language:en-US,en;q=0.9',
            '--add-header', 'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            '--sleep-interval', randomDelay.toString(),
            '--max-sleep-interval', '5',
            '--extractor-args', 'youtube:player_skip=webpage,configs',
            '--no-check-certificate',
            '--geo-bypass',
            '--socket-timeout', '30',
            '--retries', '3',
            '--fragment-retries', '3'
        ]
    };
}

// Auto-update yt-dlp periodically
let lastUpdateCheck = 0;
const UPDATE_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

async function updateYtDlp() {
    const now = Date.now();
    if (now - lastUpdateCheck < UPDATE_INTERVAL) {
        return; // Skip if updated recently
    }
    
    try {
        console.log('Checking for yt-dlp updates...');
        const updateProcess = spawn('pip3', ['install', '--upgrade', 'yt-dlp'], {
            stdio: 'pipe'
        });
        
        updateProcess.on('close', (code) => {
            if (code === 0) {
                console.log('yt-dlp updated successfully');
                lastUpdateCheck = now;
            } else {
                console.log('yt-dlp update check completed');
            }
        });
    } catch (error) {
        console.error('Error updating yt-dlp:', error.message);
    }
}

// Fallback strategies for different error types
function getRetryArgs(attempt = 0) {
    const config = getYtDlpConfig();
    let additionalArgs = [];
    
    switch (attempt) {
        case 1:
            // First retry: Use IPv4 only
            additionalArgs = ['--force-ipv4'];
            break;
        case 2:
            // Second retry: Try different extraction method
            additionalArgs = ['--force-ipv6', '--extractor-args', 'youtube:player_client=web'];
            break;
        // case 3:
        //     // Third retry: More aggressive approach
        //     additionalArgs = [
        //         '--cookies-from-browser', 'chrome',
        //         '--extractor-args', 'youtube:player_client=android'
        //     ];
        //     break;
        default:
            break;
    }
    
    return [...config.commonArgs, ...additionalArgs];
}


// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use('/temp', express.static(TEMP_DIR));

// Serve static files from root for background image
app.use(express.static(__dirname));

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

// Get video info with retry logic
function getVideoInfo(url, attempt = 0) {
    return new Promise((resolve, reject) => {
        if (attempt >= 3) {
            console.error(`[VIDEO_INFO] Max attempts reached for URL: ${url}`);
            return reject(new Error('Max retry attempts reached'));
        }

        console.log(`[VIDEO_INFO] Attempt ${attempt + 1} for URL: ${url}`);

        const args = ['--dump-json', '--no-playlist', ...getRetryArgs(attempt), url];
        console.log(`[VIDEO_INFO] yt-dlp command: yt-dlp ${args.join(' ')}`);

        const ytdlp = spawn('yt-dlp', args);

        let stdout = '';
        let stderr = '';

        ytdlp.stdout.on('data', (data) => {
            stdout += data.toString();
            console.log(`[VIDEO_INFO] stdout: ${data.toString().trim()}`);
        });

        ytdlp.stderr.on('data', (data) => {
            const dataStr = data.toString();
            stderr += dataStr;
            console.log(`[VIDEO_INFO] stderr: ${dataStr.trim()}`);
        });

        ytdlp.on('error', (error) => {
            console.error(`[VIDEO_INFO] Spawn error: ${error.message}`);
            console.error(`[VIDEO_INFO] Error code: ${error.code}, signal: ${error.signal}`);
        });

        ytdlp.on('close', (code) => {
            console.log(`[VIDEO_INFO] Process exited with code: ${code}`);

            if (code === 0) {
                try {
                    const info = JSON.parse(stdout);
                    console.log(`[VIDEO_INFO] Success on attempt ${attempt + 1}`);
                    resolve({
                        title: info.title,
                        duration: info.duration,
                        uploader: info.uploader,
                        thumbnail: info.thumbnail
                    });
                } catch (error) {
                    console.error(`[VIDEO_INFO] JSON parse error: ${error.message}`);
                    // Retry on parse error
                    setTimeout(() => {
                        getVideoInfo(url, attempt + 1).then(resolve).catch(reject);
                    }, (attempt + 1) * 2000); // Progressive delay
                }
            } else {
                console.error(`[VIDEO_INFO] Failed with code ${code}`);
                console.error(`[VIDEO_INFO] Full stderr: ${stderr}`);
                console.error(`[VIDEO_INFO] Full stdout: ${stdout}`);

                // Check if it's a bot detection error
                if (stderr.includes('Sign in to confirm') || stderr.includes('bot')) {
                    console.log(`[VIDEO_INFO] Bot detection detected, retrying...`);
                    setTimeout(() => {
                        getVideoInfo(url, attempt + 1).then(resolve).catch(reject);
                    }, (attempt + 1) * 3000); // Progressive delay for bot detection
                } else {
                    reject(new Error(`Failed to get video info (code ${code}): ${stderr.trim()}`));
                }
            }
        });
    });
}

// Download video with retry logic
function downloadVideo(url, outputPath, format = 'mp4', attempt = 0) {
    return new Promise((resolve, reject) => {
        if (attempt >= 3) {
            console.error(`[DOWNLOAD] Max attempts reached for URL: ${url}`);
            return reject(new Error('Max download attempts reached'));
        }

        console.log(`[DOWNLOAD] Attempt ${attempt + 1} for URL: ${url}, format: ${format}`);

        let formatArgs = [];
        const retryArgs = getRetryArgs(attempt);

        if (format === 'mp3') {
            formatArgs = [
                '--extract-audio',
                '--audio-format', 'mp3',
                '--audio-quality', '0',
                '--embed-thumbnail',
                '--add-metadata'
            ];
        } else {
            formatArgs = [
                '-f', 'best[ext=mp4]/best',
                '--merge-output-format', 'mp4'
            ];
        }

        const args = [
            ...formatArgs,
            ...retryArgs,
            '-o', outputPath,
            '--no-playlist',
            url
        ];

        console.log(`[DOWNLOAD] yt-dlp command: yt-dlp ${args.join(' ')}`);

        const ytdlp = spawn('yt-dlp', args);

        let stderr = '';
        let stdout = '';

        ytdlp.stdout.on('data', (data) => {
            stdout += data.toString();
            console.log(`[DOWNLOAD] stdout: ${data.toString().trim()}`);
        });

        ytdlp.stderr.on('data', (data) => {
            const dataStr = data.toString();
            stderr += dataStr;
            console.log(`[DOWNLOAD] stderr: ${dataStr.trim()}`);
        });

        ytdlp.on('error', (error) => {
            console.error(`[DOWNLOAD] Spawn error: ${error.message}`);
            console.error(`[DOWNLOAD] Error code: ${error.code}, signal: ${error.signal}`);
        });

        ytdlp.on('close', (code) => {
            console.log(`[DOWNLOAD] Process exited with code: ${code}`);

            if (code === 0) {
                console.log(`[DOWNLOAD] Success on attempt ${attempt + 1}`);
                resolve();
            } else {
                console.error(`[DOWNLOAD] Failed with code ${code}`);
                console.error(`[DOWNLOAD] Full stderr: ${stderr}`);
                console.error(`[DOWNLOAD] Full stdout: ${stdout}`);

                // Check if it's a bot detection error and retry
                if ((stderr.includes('Sign in to confirm') || stderr.includes('bot')) && attempt < 2) {
                    console.log(`[DOWNLOAD] Bot detection detected, retrying...`);
                    setTimeout(() => {
                        downloadVideo(url, outputPath, format, attempt + 1).then(resolve).catch(reject);
                    }, (attempt + 1) * 5000);
                } else {
                    reject(new Error(`Download failed (code ${code}): ${stderr.trim()}`));
                }
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

app.post('/api/download', async (req, res) => {
    try {
        const { url, format } = req.body;
        
        if (!url || !isValidYouTubeURL(url)) {
            return res.status(400).json({ error: 'Invalid YouTube URL' });
        }
        
        if (!['mp4', 'mp3'].includes(format)) {
            return res.status(400).json({ error: 'Invalid format. Use mp4 or mp3' });
        }
        
        // Get video info first
        const info = await getVideoInfo(url);
        const safeTitle = info.title.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_');
        
        // Generate unique filename
        const timestamp = Date.now();
        const hash = crypto.randomBytes(4).toString('hex');
        const extension = format;
        const filename = `${safeTitle}_${timestamp}_${hash}.${extension}`;
        const outputPath = path.join(TEMP_DIR, `${safeTitle}_${timestamp}_${hash}.%(ext)s`);
        
        // Download the file
        await downloadVideo(url, outputPath, format);
        
        // Find the actual downloaded file
        const files = await fs.readdir(TEMP_DIR);
        const downloadedFile = files.find(file => 
            file.includes(`${safeTitle}_${timestamp}_${hash}`) && 
            file.endsWith(`.${extension}`)
        );
        
        if (!downloadedFile) {
            throw new Error('Downloaded file not found');
        }
        
        const downloadUrl = `/temp/${downloadedFile}`;
        
        res.json({
            success: true,
            filename: downloadedFile,
            downloadUrl: downloadUrl,
            title: info.title
        });
        
    } catch (error) {
        console.error('Error downloading:', error);
        res.status(500).json({ error: error.message });
    }
});

// Start server
app.listen(PORT, async () => {
    console.log(`[STARTUP] Server running on port ${PORT}`);
    console.log(`[STARTUP] Node version: ${process.version}`);
    console.log(`[STARTUP] Platform: ${process.platform}`);
    console.log(`[STARTUP] Environment: ${process.env.NODE_ENV || 'development'}`);

    // Log environment details
    try {
        const { spawn } = require('child_process');
        console.log('[STARTUP] Checking yt-dlp installation...');

        const ytCheck = spawn('yt-dlp', ['--version']);
        ytCheck.stdout.on('data', (data) => {
            console.log(`[STARTUP] yt-dlp version: ${data.toString().trim()}`);
        });
        ytCheck.stderr.on('data', (data) => {
            console.log(`[STARTUP] yt-dlp stderr: ${data.toString().trim()}`);
        });
        ytCheck.on('close', (code) => {
            console.log(`[STARTUP] yt-dlp check exit code: ${code}`);
        });

        const pyCheck = spawn('python3', ['--version']);
        pyCheck.stdout.on('data', (data) => {
            console.log(`[STARTUP] Python version: ${data.toString().trim()}`);
        });
        pyCheck.on('close', (code) => {
            console.log(`[STARTUP] Python check exit code: ${code}`);
        });

    } catch (error) {
        console.error(`[STARTUP] Error checking versions: ${error.message}`);
    }

    await ensureTempDir();

    // Update yt-dlp on startup
    await updateYtDlp();

    // Clean up old files every 15 minutes
    setInterval(cleanupOldFiles, 15 * 60 * 1000);

    // Check for yt-dlp updates every 6 hours
    setInterval(updateYtDlp, 6 * 60 * 60 * 1000);

    console.log('[STARTUP] VOID\'s YT LOADER Server is ready with smart anti-detection!');
});

module.exports = app;