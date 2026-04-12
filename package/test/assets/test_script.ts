import { createClient } from 'npm:@libsql/client/node';
import { drizzle } from 'npm:drizzle-orm/libsql';
import { sqliteTable, integer } from 'npm:drizzle-orm/sqlite-core';
import { bootstrapGitVFS } from 'npm:git-sqlite-vfs';

try {
    Deno.mkdirSync('.test-db');
} catch(e) {
    if (!(e instanceof Deno.errors.AlreadyExists)) throw e;
}

await bootstrapGitVFS({ dir: '.test-db' });
const client = createClient({ url: 'file:.test-db/test.db' });
const db = drizzle(client);
const users = sqliteTable('users', { id: integer('id').primaryKey() });

await client.execute('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY)');
await db.insert(users).values({ id: 200 });
const result = await db.select().from(users);

if (result.length !== 1 || result[0].id !== 200) {
    throw new Error('Database query failed');
}
client.close();
console.log('Success Deno E2E');
