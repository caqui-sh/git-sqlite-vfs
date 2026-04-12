# git-sqlite-vfs

A Git-Versioned SQLite Database via a Custom Virtual File System (VFS).

This project bridges the mathematical robustness of SQLite's B-Tree engine with the distributed version control capabilities of Git, neutralizing the fundamental friction between binary databases and text-based source control.

## The Architecture

By default, standard monolithic SQLite databases undergo "cascading byte shifts" during standard operations (e.g., page splits, rebalancing). This destroys Git's ability to efficiently delta-compress the binary, causing massive repository bloat.

**The GitVFS Sharding Engine:**
We solve this by replacing the POSIX I/O layer with a custom SQLite Virtual File System (VFS) written in C. Instead of writing to a single `.db` file, `gitvfs` dynamically shards the database into isolated, deterministic 4KB hexadecimal `.bin` pages (e.g., `.db/pages/0A/1B/0A1B2C.bin`). 

Because changes are mathematically isolated to specific physical files, Git's `xdelta` sliding window algorithm achieves near-perfect binary compression. Operations like `VACUUM` naturally trigger `xTruncate`, unlinking dead pages and shrinking the physical directory footprint.

## The Custom Merge Strategy

Standard Git auto-merges (`ort`) operate on a file-by-file basis. Merging isolated binary pages from divergent branches silently corrupts the mathematical integrity of a B-Tree graph.

This package provides a **Native Git Merge Strategy** (`git-merge-sqlitevfs`) that elevates the merge context from the file level to the database level. When Git encounters a branch merge, it delegates the entire operation to our C executable:
1. `git-merge-sqlitevfs` uses `git archive` to safely reconstruct `MERGE_HEAD` and the Ancestor database states without index-lock collisions.
2. It uses `ATTACH DATABASE` to instantly mount all three branches (Local, Remote, Ancestor) into a single unified SQLite VDBE engine.
3. Using the `EXCEPT` operator, it calculates full-row tuples and structural DDL schema diffs instantly.
4. It performs a true mathematically sound 3-Way Logical Merge—resolving schema evolutions, propagating insertions/deletions, and mitigating exact row-level conflicts (preferring `HEAD`)—then stages the physically reconciled `.bin` pages back to Git.

## Usage

Install the package via npm (requires `better-sqlite3` and `make`):

```bash
npm install git-sqlite-vfs
```

Initialize your version-controlled connection in Node.js:

```javascript
const GitSQLite = require('git-sqlite-vfs');

// Configure Git optimizations and register the VFS merge driver
GitSQLite.setupGit();

// Open a connection. Our Node wrapper automatically loads the C extension 
// and routes the URI query via better-sqlite3.
const db = GitSQLite.open('.db');

// Execute standard SQL natively
db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);");
db.exec("INSERT INTO users (name) VALUES ('Alice');");

const row = db.prepare("SELECT * FROM users WHERE name = ?").get('Alice');
console.log(row.name); // 'Alice'

db.close();
```

Because the underlying files are flawlessly tracked, you can seamlessly branch, commit, and `git reset --hard HEAD~1` to time travel instantly!
