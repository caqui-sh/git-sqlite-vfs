import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { bootstrapGitVFS } from './index.js';

test('Node.js: Git VFS intercepts files via @libsql/client and drizzle-orm', async () => {
    // 1. Execute bootstrap function to load VFS
    await bootstrapGitVFS();

    // 2. Initialize @libsql/client using local database URL
    const client = createClient({
        url: 'file:test.db'
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
    
    await db.insert(users).values({ id: 1, name: 'Alice Node' });
    
    const result = await db.select().from(users);
    
    // Assertions for query result
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, 'Alice Node');

    // 6. Assert Git VFS intercepted files
    // The VFS implementation outputs to a folder matching the DB filename ('test.db/pages')
    const pagesDir = path.resolve(process.cwd(), 'test.db', 'pages');
    assert.strictEqual(fs.existsSync(pagesDir), true, 'Git VFS did not create test.db/pages directory');
    
    const sizeMeta = path.resolve(pagesDir, 'size.meta');
    assert.strictEqual(fs.existsSync(sizeMeta), true, 'Git VFS did not create size.meta');
    
    client.close();
});
