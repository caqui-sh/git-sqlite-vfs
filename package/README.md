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

To ensure the VFS correctly intercepts database connections and executes required PRAGMAs, use `createVFSClient` to initialize your connection instead of `@libsql/client`'s `createClient`.

### Native Binding Isolation (libsql version mismatch)

`git-sqlite-vfs` internally loads the `libsql` native C extension. If your project uses a different version of `@libsql/client` (and thus a different `libsql` binding), Node/Deno may spawn two isolated native C instances in memory, causing the VFS registration to fail silently.

To prevent this, you can inject your own `libsql` instance directly into the VFS via `options.libsql`:

```typescript
import * as myLibsql from 'libsql';
import { bootstrapGitVFS } from 'git-sqlite-vfs';

await bootstrapGitVFS({ dir: '.my-db', libsql: myLibsql });
```

### Example with `@libsql/client` and Drizzle ORM

> **Note:** Because `createVFSClient` executes required asynchronous PRAGMAs and dynamically resolves bindings, it is an `async` function. You must `await` it, unlike the synchronous `createClient` from `@libsql/client`.

```typescript
import { bootstrapGitVFS, createVFSClient } from 'git-sqlite-vfs';
import { drizzle } from 'drizzle-orm/libsql';
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';

// Load the native extension process-wide and set the VFS directory
await bootstrapGitVFS({ dir: '.my-db' });

// Initialize the database connection (automates required PRAGMAs and natively supports Deno)
const client = await createVFSClient({
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

### Usage with Deno

By default, Deno resolves `npm:@libsql/client` to its browser-compatible implementation, which bypasses native C extensions entirely. This means the VFS never runs. 

To work around this, lock the dependency directly to the Node environment. `createVFSClient` will gracefully default to the Node native bindings under the hood (`npm:@libsql/client/node`).

If you still need to bypass `createVFSClient`, import using the `/node` path directly:
```typescript
import { createClient } from 'npm:@libsql/client@0.14.0/node';
```

## Database Compaction

SQLite often zeroes out deleted data pages rather than shrinking the file size, causing unneeded `.bin` pages to remain. To allow the Git VFS to remove these unused shards, it requires `FULL` auto-vacuuming and `DELETE` journaling to actively split and compact out-of-bounds shards.

When you use `createVFSClient()`, it automatically executes these PRAGMAs for you upon connection initialization.

If you create your client manually without `createVFSClient`, you must run them yourself:

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
_directory>
```

For example:
```bash
npx git-sqlite-setup migrate ./my-old-db.sqlite ./.my-new-vfs-db
```

This will automatically:
1. Connect to both databases.
2. Transfer your schema.
3. Migrate all rows in safe, memory-efficient batches.
4. Execute a final `VACUUM;` to ensure the new VFS physically chunks the freshly inserted data.

## Compatibility

- **Node.js**: v22.5+ (using the internal `node:sqlite` API) or fallback to `better-sqlite3`.
- **Deno**: Supported natively (loads the extension dynamically via `jsr:@db/sqlite`).

## License

ISC
