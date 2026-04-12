# git-sqlite-vfs

A Git-Versioned SQLite Database powered by a custom native Virtual File System (VFS).

By combining the robustness of native SQLite, Drizzle ORM, and libSQL with the distributed tracking power of Git, `git-sqlite-vfs` enables you to version, diff, and merge your application's database exactly like your source code. It works out-of-the-box in both **Node.js** and **Deno**.

## Architecture

Traditional SQLite databases are stored as a single flat file, making them difficult to version control because a 1-byte insertion can trigger a cascading byte shift across the entire file, rendering delta-compression useless.

This package dynamically loads a specialized SQLite C Extension that overrides the default VFS. It shards your database into 4KB deterministic binary pages inside a targeted directory (e.g. `.my-db`).

When you merge branches, our custom `git-merge-sqlitevfs` driver is natively hooked into Git's conflict resolution pipeline to properly reconcile binary B-Tree page conflicts, ensuring absolute data integrity!

## Installation

Install the VFS package alongside your libSQL and Drizzle tools:

```bash
npm install git-sqlite-vfs @libsql/client drizzle-orm
```

## Git Setup

To enable Git versioning and binary merging, you must configure your repository to use the custom merge driver. We provide a convenient CLI to wire everything up:

```bash
npx git-sqlite-setup --vfs-dir .my-db
```

This will:
1. Register `git-merge-sqlitevfs` as a custom Git merge driver in your local `.git/config`.
2. Create or append to a `.gitattributes` file in your repo root to route all files in `.my-db/*` through the custom merge driver.

## Usage (Isomorphic)

The VFS works transparently in both Node.js and Deno. By using the `bootstrapGitVFS()` method before you initialize `@libsql/client`, the native memory spaces are perfectly synchronized.

### Using `@libsql/client` with Drizzle ORM

```typescript
import { createClient } from '@libsql/client'; // In Deno: 'npm:@libsql/client/node'
import { drizzle } from 'drizzle-orm/libsql';
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';
import { bootstrapGitVFS } from 'git-sqlite-vfs';

// 1. Load the native extension process-wide and set the VFS directory
await bootstrapGitVFS({ dir: '.my-db' });

// 2. Initialize your database connection using a standard file: URL
const client = createClient({
    url: 'file:.my-db/local.db'
});

// 3. Wrap with Drizzle ORM
const db = drizzle(client);

// 4. Define your schema
const users = sqliteTable('users', {
    id: integer('id').primaryKey(),
    name: text('name')
});

// 5. Query natively! All I/O is safely intercepted by the Git VFS.
await db.insert(users).values({ id: 1, name: 'Alice' });
const allUsers = await db.select().from(users);

console.log(allUsers);
```

## Preventing Git Bloat

Because SQLite usually zeroes out deleted data pages rather than shrinking the file, you might accumulate "zombie" `.bin` pages in your repository over time. To ensure the Git VFS automatically garbage-collects these abandoned chunks, you must configure SQLite to run `FULL` auto-vacuuming and use `DELETE` journaling.

Run these PRAGMAs once when initializing your database connection:

```sql
PRAGMA auto_vacuum = FULL;
PRAGMA journal_mode = DELETE;
```

Or run `VACUUM;` periodically. When SQLite explicitly shrinks the database file, the underlying VFS `xTruncate` routine will physically `unlink()` the out-of-bounds `.bin` shards, keeping your Git tracking history perfectly compressed!

## Compatibility

- **Node.js**: v22.5+ (using the new `node:sqlite` API internally) or fallback to `better-sqlite3`.
- **Deno**: Supported automatically (loads the extension dynamically via `jsr:@db/sqlite`).

## License

ISC
