# git-sqlite-vfs

> **Note:** This project is an experimental distributed database architecture. It bridges SQLite VFS, POSIX syscalls, and Git merge drivers with TypeScript/JavaScript ecosystems (Deno, Node.js, Drizzle ORM, libSQL).

`git-sqlite-vfs` is a Git-versioned SQLite database utilizing a custom Virtual File System (VFS).

Standard SQLite databases are stored as a single file. This limits version control compatibility, as minor insertions cause cascading byte shifts, negating delta-compression and creating unresolvable binary merge conflicts.

This project provides a SQLite C extension that overrides default file system behavior. It shards the database into deterministic 4KB binary pages within a specified directory. During Git operations, a custom `git-merge-sqlitevfs` C driver integrates with Git's conflict resolution to reconcile B-Tree page conflicts.

## Packaging

This repository is distributed as an NPM package compatible with Node.js and Deno.

- **Pre-compiled Binaries:** A GitHub Actions CI/CD pipeline cross-compiles the SQLite C extension (`.so`, `.dylib`, `.dll`) and the Git merge driver (`.exe` on Windows) for Linux (x64/ARM64), macOS, and Windows.
- **Platform-specific Download:** During `npm install`, a script fetches the pre-built binary for the host OS/architecture from GitHub Releases.
- **Deno Compatibility:** The JS wrapper includes runtime logic to detect missing binaries and download them locally, accommodating Deno's global cache behavior which skips `npm install` scripts.

## Integration: libSQL + Drizzle ORM

The JavaScript wrapper is designed for use with `@libsql/client` and `Drizzle ORM`.

As `libsql` runs a statically linked copy of SQLite, the wrapper injects the VFS extension globally before the ORM connects to the database.

### Quick Start (Node & Deno)

```bash
npm install git-sqlite-vfs @libsql/client drizzle-orm
```

**1. Connect & Query**
```typescript
import { createClient } from '@libsql/client'; // Deno: 'npm:@libsql/client/node'
import { drizzle } from 'drizzle-orm/libsql';
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';
import { bootstrapGitVFS } from 'git-sqlite-vfs';

// Load the native extension process-wide and target the directory
await bootstrapGitVFS({ dir: '.my-db' });

// Initialize database connection
const client = createClient({ url: 'file:.my-db/local.db' });
const db = drizzle(client);

// Define schema and query
const users = sqliteTable('users', { id: integer('id').primaryKey(), name: text('name') });
await db.insert(users).values({ id: 1, name: 'Alice' });
const allUsers = await db.select().from(users);

console.log(allUsers);
```

## Architecture Adaptability

The core implementation is located in `package/c/gitvfs.c` and `package/c/git-merge-sqlitevfs.c`. As a standard loadable SQLite C extension, it can be utilized in other languages or environments.

For environments such as Python, Rust, Go, or `better-sqlite3`, the compiled `.so`/`.dylib`/`.dll` can be loaded via `sqlite3_load_extension()`. Upon loading, it registers as a Virtual File System. Subsequent `sqlite3_open()` calls to the configured directory will be intercepted, sharded, and Git-versioned.
