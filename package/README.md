# git-sqlite-vfs

A Git-versioned SQLite database utilizing a custom Virtual File System (VFS).

By integrating SQLite, Drizzle ORM, and libSQL with Git, `git-sqlite-vfs` enables versioning, diffing, and merging of SQLite databases. It is compatible with Node.js and Deno.

## Architecture

Standard SQLite databases are stored as a single file. This limits version control compatibility, as minor insertions cause cascading byte shifts, negating delta-compression and creating unresolvable binary merge conflicts.

This package provides a loadable SQLite C extension that overrides the default VFS behavior. It shards the database into deterministic 4KB binary pages within a specified directory (e.g. `.my-db`).

During a Git merge, a custom `git-merge-sqlitevfs` driver integrates with Git's conflict resolution pipeline to reconcile B-Tree page conflicts.

## Installation

```bash
npm install git-sqlite-vfs @libsql/client drizzle-orm
```

## Git Configuration

The repository must be configured to use the custom merge driver. This configuration occurs automatically when `bootstrapGitVFS()` is called:

1. Registers `git-merge-sqlitevfs` as a custom Git merge driver in the local `.git/config`.
2. Updates `.gitattributes` in the repository root to route files matching the configured directory (e.g., `.my-db/*`) through the custom merge driver.
3. Updates `.gitignore` to ignore SQLite transient files (`*-journal`, `*-wal`, `*-shm`).

### Source Code Compatibility

The custom SQLite merge driver scopes to the designated database directory via `.gitattributes`. Other repository files continue using Git's default text-based merge algorithms.

## Usage

The VFS operates in Node.js and Deno environments. Calling `bootstrapGitVFS()` prior to initializing `@libsql/client` loads the extension process-wide.

### Example with `@libsql/client` and Drizzle ORM

```typescript
import { createClient } from '@libsql/client'; // In Deno: 'npm:@libsql/client/node'
import { drizzle } from 'drizzle-orm/libsql';
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';
import { bootstrapGitVFS } from 'git-sqlite-vfs';

// Load the native extension process-wide and set the VFS directory
await bootstrapGitVFS({ dir: '.my-db' });

// Initialize the database connection using a file URL
const client = createClient({
    url: 'file:.my-db/local.db'
});

// Wrap with Drizzle ORM
const db = drizzle(client);

// Define the schema
const users = sqliteTable('users', {
    id: integer('id').primaryKey(),
    name: text('name')
});

// Execute queries
await db.insert(users).values({ id: 1, name: 'Alice' });
const allUsers = await db.select().from(users);

console.log(allUsers);
```

## Database Compaction

SQLite often zeroes out deleted data pages rather than shrinking the file size, causing unneeded `.bin` pages to remain. To allow the Git VFS to remove these unused shards, configure SQLite to use `FULL` auto-vacuuming and `DELETE` journaling.

Execute these PRAGMA statements during connection initialization:

```sql
PRAGMA auto_vacuum = FULL;
PRAGMA journal_mode = DELETE;
```

Alternatively, executing `VACUUM;` periodically reduces the database file size, and the VFS `xTruncate` implementation will remove out-of-bounds `.bin` shards.

## Compatibility

- **Node.js**: v22.5+ (using the internal `node:sqlite` API) or fallback to `better-sqlite3`.
- **Deno**: Supported natively (loads the extension dynamically via `jsr:@db/sqlite`).

## License

ISC
