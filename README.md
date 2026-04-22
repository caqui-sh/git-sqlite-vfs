# git-sqlite-vfs

> **Note:** This project is an experimental distributed database architecture. It bridges SQLite VFS, POSIX syscalls, and Git merge drivers.

`git-sqlite-vfs` is a Git-versioned SQLite database utilizing a custom Virtual File System (VFS) written in C.

Standard SQLite databases are stored as a single file. This limits version control compatibility, as minor insertions cause cascading byte shifts, negating delta-compression and creating unresolvable binary merge conflicts.

This project provides a SQLite C extension that overrides default file system behavior. It shards the database into deterministic 4KB binary pages within a specified directory. During Git operations, a custom `git-merge-sqlitevfs` C driver integrates with Git's conflict resolution to reconcile B-Tree page conflicts.

## Project Structure

- `git-vfs/`: Contains the SQLite Virtual File System (VFS) C extension source code.
- `git-merge-hook/`: Contains the Git merge driver C source code for reconciling conflicts.
- `scripts/`: Contains helper scripts, such as for downloading SQLite source code for the build.
- `tests/`: A Deno project dedicated to verifying, asserting, and documenting the C code's behavior.

## Building

The project uses a standard `Makefile`. To build the binaries, simply run:

```bash
make
```

This will automatically:
1. Download the required SQLite amalgamation source code (`sqlite3.c` and `sqlite3.h`).
2. Compile the `gitvfs` shared library (`.so`, `.dylib`, or `.dll`).
3. Compile the `git-merge-sqlitevfs` executable.
4. Compile the `gitvfs_test` test executable.

All compiled artifacts will be placed in the `output/` directory.

## Testing

Tests are written in TypeScript using Deno to verify the behavior of the compiled C binaries. To run the tests, ensure you have Deno installed and run:

```bash
cd tests
deno test -A
```

## Usage

As a standard loadable SQLite C extension, `gitvfs` can be utilized in any environment that supports SQLite extensions (e.g., Python, Rust, Go, or native C applications).

You can load the compiled `.so`/`.dylib`/`.dll` via `sqlite3_load_extension()`. Upon loading, it registers as a Virtual File System. Subsequent `sqlite3_open()` calls using this VFS will be intercepted, sharded into 4KB pages, and structured for Git versioning.

### Setting up the Merge Driver

To configure Git to use the custom merge driver for your database files, you will need to register the `git-merge-sqlitevfs` binary in your Git configuration and assign it to your database files via `.gitattributes`.

```bash
git config merge.sqlitevfs.name "SQLite VFS Merge Driver"
git config merge.sqlitevfs.driver "/path/to/output/git-merge-sqlitevfs %O %A %B %L %P"
```

## Future Testing Work

While the current test suite provides significant coverage for functional correctness and scale, the following scenarios are planned for future verification:

- [ ] **VFS: Large BLOBs (Overflow Pages)**: Assert that single rows exceeding the 4KB page size (e.g., 10MB images or JSON) are correctly sharded into linked overflow pages across the file system without corruption.
- [ ] **VFS: Concurrency & File Locking**: Assert that OS-level file locking works correctly across the sharded `.bin` file architecture when multiple database connections attempt simultaneous read/write operations.
- [ ] **Merge Driver: Incremental Memory Management**: Investigate replacing the fixed 1MB schema buffer in `git-merge-sqlitevfs.c` with dynamic allocation to handle extremely complex schema migrations.

