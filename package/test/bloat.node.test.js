import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { configureGitIntegration, createVFSClient } from '../index.js';

function getDirSize(dirPath) {
    let size = 0;
    const files = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const file of files) {
        const fullPath = path.join(dirPath, file.name);
        if (file.isDirectory()) {
            size += getDirSize(fullPath);
        } else {
            size += fs.statSync(fullPath).size;
        }
    }
    return size;
}

function countShards(dirPath) {
    let count = 0;
    const files = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const file of files) {
        const fullPath = path.join(dirPath, file.name);
        if (file.isDirectory()) {
            count += countShards(fullPath);
        } else if (file.name.endsWith('.bin')) {
            count++;
        }
    }
    return count;
}

test('Robustness: VFS chunking prevents Git repository bloat on scattered updates', async () => {
    const repoDir = path.join(process.cwd(), '.bloat-repo');
    const vfsDir = '.db';
    const dbPath = path.join(repoDir, vfsDir, 'bloat.db');

    if (fs.existsSync(repoDir)) {
        fs.rmSync(repoDir, { recursive: true, force: true });
    }
    fs.mkdirSync(repoDir, { recursive: true });

    execSync('git init --initial-branch=main', { cwd: repoDir });
    execSync('git config user.name "Test Bloat User"', { cwd: repoDir });
    execSync('git config user.email "bloat@example.com"', { cwd: repoDir });

    await configureGitIntegration({ repoDir, vfsDir });
    
    execSync('git add .gitattributes .gitignore', { cwd: repoDir });
    execSync('git commit -m "chore: setup"', { cwd: repoDir });

    const client = await createVFSClient({ 
        dir: vfsDir,
        url: `file:${dbPath}` 
    });

    await client.execute('CREATE TABLE large_table (id INTEGER PRIMARY KEY, payload TEXT)');

    // 1. Initial Load: Insert 20,000 rows
    const NUM_ROWS = 20000;
    
    await client.execute('BEGIN TRANSACTION');
    for (let i = 1; i <= NUM_ROWS; i++) {
        const padding = crypto.randomBytes(250).toString('hex'); // 500 bytes of high-entropy hex
        await client.execute({
            sql: 'INSERT INTO large_table (id, payload) VALUES (?, ?)',
            args: [i, `Initial data ${i} - ${padding}`]
        });
    }
    await client.execute('COMMIT');

    // Initial measurement
    execSync('git add .', { cwd: repoDir });
    execSync('git commit -m "baseline"', { cwd: repoDir });
    
    const initialGitSize = getDirSize(path.join(repoDir, '.git', 'objects'));
    const initialDbSize = getDirSize(path.join(repoDir, vfsDir));
    const initialShardCount = countShards(path.join(repoDir, vfsDir));

    // 2. Scattered Updates: Update ~20% of rows and delete 10%
    await client.execute('BEGIN TRANSACTION');
    for (let i = 1; i <= NUM_ROWS; i++) {
        if (i % 10 === 0) { // Delete 10%
            await client.execute({
                sql: 'DELETE FROM large_table WHERE id = ?',
                args: [i]
            });
        } else if (i % 5 === 0) { // Update 20%
            const padding = crypto.randomBytes(250).toString('hex');
            await client.execute({
                sql: 'UPDATE large_table SET payload = ? WHERE id = ?',
                args: [`Updated data ${i} - ${padding}`, i]
            });
        }
    }
    await client.execute('COMMIT');

    // 3. Compaction
    await client.execute('VACUUM;');

    // Final measurement
    execSync('git add .', { cwd: repoDir });
    execSync('git commit -m "updates"', { cwd: repoDir });
    execSync('git gc --prune=now --aggressive', { cwd: repoDir }); // Force garbage collection

    const finalGitSize = getDirSize(path.join(repoDir, '.git', 'objects'));
    const finalShardCount = countShards(path.join(repoDir, vfsDir));

    client.close();

    const gitGrowth = finalGitSize - initialGitSize;
    
    // Assertions
    // The growth in Git should be extremely small compared to full DB size. 
    // Git should efficiently delta compress only the updated 64KB/4KB shards.
    assert.ok(gitGrowth < initialDbSize * 0.5, `Git repository bloat detected! Growth (${gitGrowth} bytes) is too large relative to DB size (${initialDbSize} bytes). VFS chunking failed to prevent massive byte shifts.`);
    
    // Prove xTruncate works by ensuring shard count does not endlessly grow after VACUUM.
    // Given we deleted 10% and vacuumed, the shard count should be bounded or decreased.
    assert.ok(finalShardCount <= initialShardCount + 5, `Shard count increased excessively! Dead shards were not truncated. Initial: ${initialShardCount}, Final: ${finalShardCount}`);

    fs.rmSync(repoDir, { recursive: true, force: true });
});
