import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import process from 'node:process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function downloadOrBuild(targetDir) {
    let pkgVersion = '0.0.2';
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
        pkgVersion = pkg.version;
    } catch(e) {}

    const platform = os.platform();
    const arch = os.arch();
    
    const repo = 'fur-tea-laser/git-sqlite-vfs';
    const assetName = `git-sqlite-vfs-${platform}-${arch}.tar.gz`;
    const url = `https://github.com/${repo}/releases/download/v${pkgVersion}/${assetName}`;

    try {
        console.log(`Attempting to download prebuilt binary: ${url}`);
        
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }
        
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Failed to fetch: ${res.status} ${res.statusText}`);
        }
        
        const arrayBuffer = await res.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        
        const tarballPath = path.join(targetDir, 'temp.tar.gz');
        fs.writeFileSync(tarballPath, buffer);
        
        execSync(`tar -xzf temp.tar.gz`, { cwd: targetDir });
        fs.unlinkSync(tarballPath);
        
        console.log('Successfully downloaded and extracted prebuilt binary.');
    } catch (err) {
        console.warn(`Download failed: ${err.message}`);
        console.log('Falling back to building from source...');
        try {
            execSync('npm run build', { stdio: 'inherit', cwd: __dirname });
            
            const defaultOutDir = path.join(__dirname, 'c', 'output');
            if (path.resolve(defaultOutDir) !== path.resolve(targetDir)) {
                fs.cpSync(defaultOutDir, targetDir, { recursive: true });
            }
            
            console.log('Successfully built from source.');
        } catch (buildErr) {
            console.error('Failed to build from source.', buildErr.message);
        }
    }
}
