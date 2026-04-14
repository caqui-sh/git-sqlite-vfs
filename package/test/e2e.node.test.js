import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { drizzle } from 'drizzle-orm/libsql';
import { sqliteTable, integer } from 'drizzle-orm/sqlite-core';
import { configureGitIntegration, createVFSClient } from '../index.js';

test('E2E: Git merge seamlessly resolves SQLite binary conflicts', async () => {
    const repoDir = path.join(process.cwd(), '.e2e-repo');
    const vfsDir = '.db';

    // Clean up previous run
    if (fs.existsSync(repoDir)) {
        fs.rmSync(repoDir, { recursive: true, force: true });
    }
    fs.mkdirSync(repoDir);

    // Initialize Git
    execSync('git init --initial-branch=main', { cwd: repoDir });
    execSync('git config user.name "Test User"', { cwd: repoDir });
    execSync('git config user.email "test@example.com"', { cwd: repoDir });

    // Configure our custom VFS driver
    await configureGitIntegration({ repoDir, vfsDir });
    
    // Commit the config
    execSync('git add .gitattributes .gitignore', { cwd: repoDir });
    execSync('git commit -m "chore: setup git-sqlite-vfs merge driver"', { cwd: repoDir });

    // -----------------------------------------------------
    // MAIN BRANCH
    // -----------------------------------------------------
    const clientMain = await createVFSClient({ 
        dir: vfsDir,
        url: `file:${path.join(repoDir, vfsDir, 'test.db')}`
 
    });
    const dbMain = drizzle(clientMain);
    const users = sqliteTable('users', { id: integer('id').primaryKey() });

    await clientMain.execute('CREATE TABLE users (id INTEGER PRIMARY KEY)');
    await dbMain.insert(users).values({ id: 1 });
    clientMain.close();

    execSync('git add .', { cwd: repoDir });
    execSync('git commit -m "feat: add user 1 on main"', { cwd: repoDir });

    // -----------------------------------------------------
    // BRANCH A
    // -----------------------------------------------------
    execSync('git checkout -b branch-a', { cwd: repoDir });
    const clientA = await createVFSClient({ 
        dir: vfsDir,
        url: `file:${path.join(repoDir, vfsDir, 'test.db')}`
 
    });
    const dbA = drizzle(clientA);
    await dbA.insert(users).values({ id: 2 });
    clientA.close();

    execSync('git add .', { cwd: repoDir });
    execSync('git commit -m "feat: add user 2 on branch-a"', { cwd: repoDir });

    // -----------------------------------------------------
    // BRANCH B
    // -----------------------------------------------------
    execSync('git checkout main', { cwd: repoDir });
    execSync('git checkout -b branch-b', { cwd: repoDir });
    const clientB = await createVFSClient({ 
        dir: vfsDir,
        url: `file:${path.join(repoDir, vfsDir, 'test.db')}`
 
    });
    const dbB = drizzle(clientB);
    await dbB.insert(users).values({ id: 3 });
    clientB.close();

    execSync('git add .', { cwd: repoDir });
    execSync('git commit -m "feat: add user 3 on branch-b"', { cwd: repoDir });

    // -----------------------------------------------------
    // MERGE (The ultimate test)
    // -----------------------------------------------------
    // We are on branch-b. Merge branch-a. This will trigger the git-merge-sqlitevfs driver!
    execSync('git merge branch-a --no-edit', { cwd: repoDir, stdio: 'inherit' });

    // Verify
    const clientMerged = await createVFSClient({ 
        dir: vfsDir,
        url: `file:${path.join(repoDir, vfsDir, 'test.db')}`
 
    });
    const dbMerged = drizzle(clientMerged);
    const allUsers = await dbMerged.select().from(users);
    
    const ids = allUsers.map(u => u.id).sort((a, b) => a - b);
    assert.deepStrictEqual(ids, [1, 2, 3], 'Merge failed: not all IDs are present in the final database.');
    
    clientMerged.close();

    // Clean up
    fs.rmSync(repoDir, { recursive: true, force: true });
});
