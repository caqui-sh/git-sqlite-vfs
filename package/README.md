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

## CLI Usage

The `git-sqlite-vfs` CLI provides essential commands for managing your versioned database. It is designed to replace `drizzle-kit` commands when working with the VFS to ensure changes are correctly applied to the sharded database.

### Setup
Initialize and configure the current Git repository to use the VFS merge driver. This command ensures the necessary binaries are present and configures the Git merge driver for sharded pages.
```bash
npx git-sqlite-vfs setup
```

### Schema & Migrations
These commands integrate with your `drizzle.config` file to automatically detect paths.

**Generate Migrations:**
Wraps `drizzle-kit generate` to create SQL migration files.
```bash
npx git-sqlite-vfs generate
```

**Push Schema:**
Generates a new migration and applies it directly to the VFS-enabled database. Use this for rapid development.
```bash
npx git-sqlite-vfs push
```

**Run Migrations:**
Applies pending migrations from your migrations folder to the database.
```bash
npx git-sqlite-vfs migrate
```

## Usage

### libSQL Client

The `createVFSClient` function automatically ensures that the VFS extension is loaded and initialized.

```javascript
import { createVFSClient } from 'git-sqlite-vfs';

// Initialize the VFS-enabled client
const client = await createVFSClient({
    url: 'file:.db/main.db'
});

await client.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
```

### Drizzle ORM

```javascript
import { createVFSClient } from 'git-sqlite-vfs';
import { drizzle } from 'drizzle-orm/libsql';

const client = await createVFSClient({ url: 'file:.db/main.db' });
const db = drizzle(client);
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
