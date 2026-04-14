import { test } from 'jsr:@std/testing/bdd';
import { expect } from 'jsr:@std/expect';
import { existsSync } from 'jsr:@std/fs/exists';
import * as path from 'jsr:@std/path';
import { drizzle } from 'npm:drizzle-orm/libsql';
import { sqliteTable, text, integer } from 'npm:drizzle-orm/sqlite-core';
import { createVFSClient, configureGitIntegration } from '../index.js';

Deno.test('Deno: Git VFS intercepts files via @libsql/client and drizzle-orm', async () => {
    // 1. Configure Git integration
    await configureGitIntegration({ repoDir: Deno.cwd(), vfsDir: '.test-db' });

    // 2. Initialize VFS-enabled client
    const client = await createVFSClient({
        dir: '.test-db',
        url: 'file:.test-db'
    });

    // 3. Wrap with drizzle
    const db = drizzle(client);

    // 4. Define simple schema
    const users = sqliteTable('users', {
        id: integer('id').primaryKey(),
        name: text('name')
    });

    // 5. Create table, insert row, query
    await client.execute('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT)');
    await client.execute('DELETE FROM users');

    await db.insert(users).values({ id: 2, name: 'Bob Deno' });

    const result = await db.select().from(users);

    // Assertions for query result
    expect(result.length).toBe(1);
    expect(result[0].name).toBe('Bob Deno');

    // 6. Assert Git VFS intercepted files
    // The VFS implementation outputs to a folder matching the DB filename ('.test-db/pages')
    const pagesDir = path.resolve(Deno.cwd(), '.test-db', 'pages');
    expect(existsSync(pagesDir)).toBe(true);
    
    const sizeMeta = path.resolve(pagesDir, 'size.meta');
    expect(existsSync(sizeMeta)).toBe(true);
    
    client.close();
});
