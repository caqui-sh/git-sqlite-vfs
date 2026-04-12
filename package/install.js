const os = require('os');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const pkg = require('./package.json');

const REPO = 'fur-tea-laser/git-sqlite-vfs'; 
const VERSION = `v${pkg.version}`;
const PLATFORM = os.platform();
const ARCH = os.arch();

// Target filename from GitHub Release: e.g., git-sqlite-vfs-v1.0.0-linux-x64.tar.gz
const ASSET_NAME = `git-sqlite-vfs-${VERSION}-${PLATFORM}-${ARCH}.tar.gz`;
const DOWNLOAD_URL = `https://github.com/${REPO}/releases/download/${VERSION}/${ASSET_NAME}`;

const OUT_DIR = path.join(__dirname, 'c', 'output');

function buildFromSource() {
    console.log('Building from source as fallback...');
    try {
        execSync('npm run build', { stdio: 'inherit', cwd: __dirname });
        console.log('Successfully built from source.');
    } catch (e) {
        console.error('Failed to build from source.', e.message);
        process.exit(1);
    }
}

function downloadAndExtract() {
    // If the SKIP_DOWNLOAD env var is set, or if we are building locally from the repo root
    // we should just build from source.
    if (process.env.SKIP_DOWNLOAD || !__dirname.includes('node_modules')) {
        return buildFromSource();
    }

    console.log(`Attempting to download prebuilt binary: ${DOWNLOAD_URL}`);
    
    try {
        if (!fs.existsSync(OUT_DIR)) {
            fs.mkdirSync(OUT_DIR, { recursive: true });
        }
        
        // Use native curl and tar to download and extract without requiring NPM dependencies.
        // This is supported out-of-the-box on modern Linux, macOS, and Windows 10+
        execSync(`curl -sLf ${DOWNLOAD_URL} | tar -xz -C "${OUT_DIR}"`, { stdio: 'inherit' });
        console.log('Prebuilt binary successfully downloaded and extracted!');
    } catch (err) {
        console.log('Prebuilt binary not found or download failed. Falling back to source compilation...');
        buildFromSource();
    }
}

downloadAndExtract();
