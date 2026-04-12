# git-sqlite-vfs

A Git-versioned SQLite Database powered by a custom Virtual File System (VFS).

By integrating native SQLite, Drizzle ORM, and libSQL with Git's version control capabilities, `git-sqlite-vfs` allows you to version, diff, and merge your application's database in a manner similar to source code. It is compatible with both **Node.js** and **Deno**.

## Architecture

Standard SQLite databases are stored as a single flat file. This structure presents challenges for version control, as a minor insertion can result in widespread byte shifts across the file, reducing the effectiveness of delta-compression and making binary merge conflicts difficult to resolve.

This package provides a loadable SQLite C Extension that overrides the default VFS behavior. It shards the database into 4KB deterministic binary pages within a specified directory (e.g. `.my-db`).

During a Git merge, a provided `git-merge-sqlitevfs` driver integrates with Git's conflict resolution pipeline to reconcile binary B-Tree page conflicts, maintaining data integrity.

## Installation

Install the package alongside your libSQL and Drizzle ORM dependencies:

```bash
npm install git-sqlite-vfs @libsql/client drizzle-orm
```

## Git Configuration

To enable Git versioning and binary merging, the repository must be configured to use the custom merge driver. This is done **automatically** when you call `bootstrapGitVFS()`:

1. It registers `git-merge-sqlitevfs` as a custom Git merge driver in the local `.git/config`.
2. It adds or appends to a `.gitattributes` file in the repository root to route all files matching your configured directory (e.g., `.my-db/*`) through the custom merge driver.
3. It creates or updates a `.gitignore` to ignore SQLite transient files (`*-journal`, `*-wal`, `*-shm`).

### Safe alongside Source Code

The custom SQLite merge driver **will not interfere with the merging of standard source code or text files**. By utilizing the `.gitattributes` file, Git explicitly scopes the custom driver strictly to the files within your designated database directory (e.g., `.my-db/* merge=sqlitevfs`). All other files in your repository will continue to use Git's default text-based merge algorithms.

## Usage

The VFS works in both Node.js and Deno environments. By calling the `bootstrapGitVFS()` method prior to initializing `@libsql/client`, the extension is loaded process-wide.

### Example with `@libsql/client` and Drizzle ORM

```typescript
import { createClient } from '@libsql/client'; // In Deno: 'npm:@libsql/client/node'
import { drizzle } from 'drizzle-orm/libsql';
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';
import { bootstrapGitVFS } from 'git-sqlite-vfs';

// 1. Load the native extension process-wide and set the VFS directory
await bootstrapGitVFS({ dir: '.my-db' });

// 2. Initialize the database connection using a standard file: URL
const client = createClient({
    url: 'file:.my-db/local.db'
});

// 3. Wrap with Drizzle ORM
const db = drizzle(client);

// 4. Define the schema
const users = sqliteTable('users', {
    id: integer('id').primaryKey(),
    name: text('name')
});

// 5. Execute queries. File I/O is intercepted by the Git VFS.
await db.insert(users).values({ id: 1, name: 'Alice' });
const allUsers = await db.select().from(users);

console.log(allUsers);
```

## Preventing Repository Bloat

Because SQLite often zeroes out deleted data pages rather than shrinking the database file size, "zombie" `.bin` pages may accumulate in the repository over time. To allow the Git VFS to automatically garbage-collect these unused chunks, configure SQLite to use `FULL` auto-vacuuming and `DELETE` journaling.

Execute these PRAGMA statements when initializing the database connection:

```sql
PRAGMA auto_vacuum = FULL;
PRAGMA journal_mode = DELETE;
```

Alternatively, you can run `VACUUM;` periodically. When SQLite explicitly reduces the database file size, the underlying VFS `xTruncate` implementation will remove the out-of-bounds `.bin` shards, keeping the repository history compressed.

## Compatibility

- **Node.js**: v22.5+ (using the internal `node:sqlite` API) or fallback to `better-sqlite3`.
- **Deno**: Supported natively (loads the extension dynamically via `jsr:@db/sqlite`).

## License

ISC
