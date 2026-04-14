import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/libsql';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { createVFSClient, configureGitIntegration } from '../index.js';

function countFiles(dir) {
    if (!fs.existsSync(dir)) return 0;
    let count = 0;
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory()) {
            count += countFiles(fullPath);
        } else if (file.endsWith('.bin')) {
            count++;
        }
    }
    return count;
}

test('Compaction: Git VFS removes zombie pages on xTruncate', async () => {
    const vfsDir = '.compaction-db';
    await configureGitIntegration({ repoDir: process.cwd(), vfsDir });

    const client = await createVFSClient({ 
        dir: vfsDir,
        url: `file:${vfsDir}` 
    });
    const db = drizzle(client);

    const testData = sqliteTable('test_data', {
        id: integer('id').primaryKey(),
        value: text('value')
    });

    await client.execute('PRAGMA auto_vacuum = FULL;');
    await client.execute('PRAGMA journal_mode = DELETE;');
    await client.execute('CREATE TABLE test_data (id INTEGER PRIMARY KEY, value TEXT)');

    // Phase 1 (Grow): Insert 5000 rows of large text data
    const largeString = 'A'.repeat(1024);
    for (let i = 1; i <= 5000; i++) {
        await client.execute({ sql: 'INSERT INTO test_data (id, value) VALUES (?, ?)', args: [i, largeString] });
    }

    const pagesDir = path.join(process.cwd(), vfsDir, 'pages');
    const countAfterGrow = countFiles(pagesDir);
    assert.ok(countAfterGrow > 10, `Expected many chunks after growing, got ${countAfterGrow}`);

    // Phase 2 (Shrink): Delete 90% of rows
    await client.execute('DELETE FROM test_data WHERE id > 500');
    // Run an explicit VACUUM just in case auto_vacuum didn't run synchronously or needs help
    await client.execute('VACUUM;');

    // Phase 3 (Verify): Check that file count decreased
    const countAfterShrink = countFiles(pagesDir);
    assert.ok(countAfterShrink < countAfterGrow, `Expected file count to shrink, but went from ${countAfterGrow} to ${countAfterShrink}`);
    
    client.close();
});
