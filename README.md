# git-sqlite-vfs

> **Note:** This project is predominantly an **AI-researched and AI-coded** experiment in distributed database architecture. It demonstrates how AI can assist in seamlessly bridging low-level C programming (SQLite VFS, POSIX syscalls, Git merge drivers) with modern TypeScript/JavaScript ecosystems (Deno, Node.js, Drizzle ORM, libSQL).

`git-sqlite-vfs` is a native Git-Versioned SQLite Database powered by a custom Virtual File System (VFS). 

Traditional SQLite databases are stored as a single, monolithic file. This makes them difficult to version control because a simple 1-byte insertion can trigger a cascading byte shift across the entire file, rendering Git's delta-compression useless and causing binary merge conflicts that cannot be resolved.

This project solves that by dynamically loading a specialized SQLite C Extension that overrides the default file system behavior. It transparently shards your database into deterministic 4KB binary pages inside a targeted directory. When you branch and merge, a custom `git-merge-sqlitevfs` C driver hooks into Git's conflict resolution pipeline to properly reconcile the B-Tree page conflicts, ensuring absolute data integrity!

## How it is Packaged

This repository is distributed as a highly optimized, isomorphic **NPM Package** designed to work seamlessly in both **Node.js** and **Deno**.

To ensure a frictionless developer experience:
- **No Local Compilation Required:** We use a GitHub Actions CI/CD pipeline to automatically cross-compile the SQLite C Extension (`.so`, `.dylib`, `.dll`) and the Git Merge Driver (`.exe` on Windows) for Linux (x64/ARM64), macOS, and Windows.
- **Smart Isomorphic Downloader:** When you run `npm install`, a custom installer script safely fetches the exact pre-built binary for your OS/Architecture from GitHub Releases.
- **Deno Self-Healing:** Deno's read-only global cache skips traditional `npm install` scripts. To counter this, our JS wrapper features self-healing runtime logic that detects the missing binary, downloads it locally, and dynamically injects it into the SQLite engine on the fly.

## Tailored Use Case: libSQL + Drizzle ORM

The primary JavaScript wrapper in this package is specifically tailored to work flawlessly with the modern TypeScript stack: **`@libsql/client`** and **`Drizzle ORM`**. 

Because `libsql` runs its own statically linked copy of SQLite in an isolated native memory space, our wrapper handles the complex bootstrapping required to inject the VFS extension globally before your ORM connects to the local database.

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

// 1. Load the native extension process-wide and target your directory
await bootstrapGitVFS({ dir: '.my-db' });

// 2. Initialize your database connection
const client = createClient({ url: 'file:.my-db/local.db' });
const db = drizzle(client);

// 3. Define schema & Query natively!
const users = sqliteTable('users', { id: integer('id').primaryKey(), name: text('name') });
await db.insert(users).values({ id: 1, name: 'Alice' });
const allUsers = await db.select().from(users);

console.log(allUsers);
```

## Adaptability & Core C Architecture

While the NPM package and JavaScript wrappers are tailored for `libSQL` and `Drizzle`, the underlying technology is completely language-agnostic. 

The core of this project lives in `package/c/gitvfs.c` and `package/c/git-merge-sqlitevfs.c`. Because it is implemented as a standard, loadable SQLite C Extension, **it can be adapted to work for almost any use-case or language**.

If you are using Python, Rust, Go, or standard `better-sqlite3`, you can compile the `.so`/`.dylib`/`.dll` and load it via `sqlite3_load_extension()`. Once loaded, it registers itself globally as a Virtual File System, and any subsequent `sqlite3_open()` calls directed at your configured directory will automatically be intercepted, sharded, and Git-versioned without changing a single line of your application's SQL!
