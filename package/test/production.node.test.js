import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('Production E2E Node.js: Installs from NPM and downloads prebuilt binary', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-sqlite-vfs-test-'));
    
    try {
        fs.copyFileSync(path.join(__dirname, 'assets', 'package.json'), path.join(tempDir, 'package.json'));
        fs.copyFileSync(path.join(__dirname, 'assets', 'test_script.js'), path.join(tempDir, 'test_script.js'));
        
        // Use --foreground-scripts to ensure we capture the download message from postinstall
        const installOut = execSync('npm install --foreground-scripts', { cwd: tempDir, encoding: 'utf-8' });
        
        assert.ok(installOut.includes('Successfully downloaded and extracted prebuilt binary'), 'Failed to download prebuilt binary');
        assert.ok(!installOut.includes('Falling back to building from source'), 'Package built from source instead of using prebuilt binary');

        const runOut = execSync('node test_script.js', { cwd: tempDir, encoding: 'utf-8' });
        assert.ok(runOut.includes('Success Node E2E'));
        
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
