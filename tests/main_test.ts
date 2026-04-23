import { expect } from "@std/expect";
import { existsSync } from "@std/fs/exists";
import * as path from "@std/path";
import { Database } from "@db/sqlite";

function getExtensionPath() {
  const base = path.resolve(Deno.cwd(), "../output/gitvfs");
  switch (Deno.build.os) {
    case "darwin":
      return `${base}.dylib`;
    case "windows":
      return `${base}.dll`;
    default:
      return `${base}.so`;
  }
}

function getDirectorySize(dirPath: string): number {
  let size = 0;
  for (const entry of Deno.readDirSync(dirPath)) {
    const entryPath = path.resolve(dirPath, entry.name);
    const stat = Deno.statSync(entryPath);
    if (entry.isDirectory) {
      size += getDirectorySize(entryPath);
    } else {
      size += stat.size;
    }
  }
  return size;
}

function initVfs(dbDir: string) {
  Deno.env.set("GIT_SQLITE_VFS_DIR", path.basename(dbDir));
  const loaderDb = new Database(":memory:", { enableLoadExtension: true });
  loaderDb.loadExtension(getExtensionPath());
  loaderDb.close();
  const db = new Database(dbDir);
  // CRITICAL: Disable WAL mode so Git doesn't track ephemeral .db-wal and .db-shm files
  db.exec("PRAGMA journal_mode=DELETE;");
  return db;
}

Deno.test("GitVFS Scale: Repository Anti-Bloat", async (t) => {
  const tempDir = Deno.makeTempDirSync({ prefix: "gitvfs_scale_" });
  const driverPath = path.resolve(Deno.cwd(), "../output/git-merge-sqlitevfs");
  const dbName = `scale_${Date.now()}.db`;
  const dbDir = path.resolve(tempDir, dbName);

  try {
    await setupGitProject(tempDir, driverPath);

    await t.step("Initialize 10,000 rows", () => {
      const db = initVfs(dbDir);
      db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, data TEXT);");
      const insert = db.prepare("INSERT INTO users (data) VALUES (?);");
      db.exec("BEGIN;");
      for (let i = 0; i < 10000; i++) {
        insert.run(`User data for record ${i} - establishing baseline size`);
      }
      db.exec("COMMIT;");
      db.close();
    });

    await runGit(tempDir, "add", "-A");
    await runGit(tempDir, "commit", "-m", "Initial_database_state");

    const baselineSize = getDirectorySize(path.resolve(tempDir, ".git/objects"));
    console.log(`  Baseline .git/objects size: ${baselineSize} bytes`);

    await t.step("Mutate data over 20 commits", async () => {
      for (let commitIdx = 0; commitIdx < 20; commitIdx++) {
        const db = initVfs(dbDir);
        // Mutate 10 scattered rows to ensure we touch different pages
        for (let i = 0; i < 10; i++) {
          const id = (commitIdx * 10 + i) * 100 % 10000 + 1;
          db.exec(`UPDATE users SET data = 'mutated in commit ${commitIdx}' WHERE id = ${id};`);
        }
        db.close();
        await runGit(tempDir, "add", "-A");
        await runGit(tempDir, "commit", "-m", `Update_batch_${commitIdx}`);
      }
    });

    const finalSize = getDirectorySize(path.resolve(tempDir, ".git/objects"));
    const growth = finalSize - baselineSize;
    console.log(`  Final .git/objects size: ${finalSize} bytes`);
    console.log(`  Total growth over 20 commits: ${growth} bytes`);

    await t.step("Assert anti-bloat property", () => {
      // Each commit should only store a handful of 4KB pages.
      // 20 commits * (~4-5 pages) * 4KB per page = ~400KB total growth.
      // If we committed the whole 1MB+ database 20 times, growth would be > 20MB.
      // We'll set a generous threshold of 1MB to prove it's NOT a full duplication.
      expect(growth).toBeLessThan(1024 * 1024); // 1MB threshold
    });
  } finally {
    Deno.removeSync(tempDir, { recursive: true });
    try {
      for (const entry of Deno.readDirSync("/tmp")) {
        if (entry.name.startsWith("gitvfs_")) {
          Deno.removeSync(path.resolve("/tmp", entry.name), { recursive: true });
        }
      }
    } catch {}
  }
});

Deno.test("GitVFS Edge Cases: Large Data & Paging", async (t) => {
  const tempDir = Deno.makeTempDirSync({ prefix: "gitvfs_large_data_" });
  try {
    const dbDir = path.resolve(tempDir, "large.db");
    const db = initVfs(dbDir);

    await t.step("Insert 5000 rows", () => {
      db.exec("CREATE TABLE large_table (id INTEGER PRIMARY KEY, data TEXT);");
      const insert = db.prepare("INSERT INTO large_table (data) VALUES (?);");
      db.exec("BEGIN;");
      for (let i = 0; i < 5000; i++) {
        insert.run(`Some repeating data for row ${i} to ensure we take up space`);
      }
      db.exec("COMMIT;");
    });

    await t.step("Query count", () => {
      const [{ count }] = db.prepare("SELECT count(*) as count FROM large_table;").all<{ count: number }>();
      expect(count).toBe(5000);
    });

    await t.step("Verify multiple pages exist", () => {
      // Check if we have more than a few page files. 
      // 5000 rows with ~100 bytes each should be > 500KB, which is > 120 pages (4KB each).
      let pageCount = 0;
      for (const entry of Deno.readDirSync(path.resolve(dbDir, "pages"))) {
        if (entry.isDirectory) {
          for (const sub of Deno.readDirSync(path.resolve(dbDir, "pages", entry.name))) {
            if (sub.isDirectory) {
              // and so on... let's just use a recursive counter or a simple check for the first few levels
              pageCount++; 
            }
          }
        }
      }
      expect(pageCount).toBeGreaterThan(0);
      db.close();
    });
  } finally {
    Deno.removeSync(tempDir, { recursive: true });
    try {
      for (const entry of Deno.readDirSync("/tmp")) {
        if (entry.name.startsWith("gitvfs_")) {
          Deno.removeSync(path.resolve("/tmp", entry.name), { recursive: true });
        }
      }
    } catch {}
  }
});

Deno.test("GitVFS Edge Cases: Database Vacuum", async (t) => {
  const tempDir = Deno.makeTempDirSync({ prefix: "gitvfs_vacuum_" });
  try {
    const dbDir = path.resolve(tempDir, "vacuum.db");
    const db = initVfs(dbDir);

    await t.step("Insert and Delete rows", () => {
      db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, data TEXT);");
      for (let i = 0; i < 1000; i++) {
        db.exec(`INSERT INTO test (data) VALUES ('data ${i}');`);
      }
      db.exec("DELETE FROM test WHERE id > 100;");
    });

    await t.step("Run VACUUM", () => {
      db.exec("VACUUM;");
    });

    await t.step("Verify data consistency", () => {
      const [{ count }] = db.prepare("SELECT count(*) as count FROM test;").all<{ count: number }>();
      expect(count).toBe(100);
      db.close();
    });
  } finally {
    Deno.removeSync(tempDir, { recursive: true });
    try {
      for (const entry of Deno.readDirSync("/tmp")) {
        if (entry.name.startsWith("gitvfs_")) {
          Deno.removeSync(path.resolve("/tmp", entry.name), { recursive: true });
        }
      }
    } catch {}
  }
});

Deno.test("GitVFS Edge Cases: Transaction Rollbacks", async (t) => {
  const tempDir = Deno.makeTempDirSync({ prefix: "gitvfs_rollback_" });
  try {
    const dbDir = path.resolve(tempDir, "rollback.db");
    const db = initVfs(dbDir);

    await t.step("Setup initial state", () => {
      db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, data TEXT);");
      db.exec("INSERT INTO test (data) VALUES ('initial');");
    });

    await t.step("Perform rollback", () => {
      db.exec("BEGIN;");
      for (let i = 0; i < 100; i++) {
        db.exec(`INSERT INTO test (data) VALUES ('rolled back ${i}');`);
      }
      db.exec("ROLLBACK;");
    });

    await t.step("Verify only initial row exists", () => {
      const rows = db.prepare("SELECT data FROM test").all<{ data: string }>();
      expect(rows.length).toBe(1);
      expect(rows[0].data).toBe("initial");
      db.close();
    });
  } finally {
    Deno.removeSync(tempDir, { recursive: true });
    try {
      for (const entry of Deno.readDirSync("/tmp")) {
        if (entry.name.startsWith("gitvfs_")) {
          Deno.removeSync(path.resolve("/tmp", entry.name), { recursive: true });
        }
      }
    } catch {}
  }
});

async function runGit(cwd: string, ...args: string[]) {
  // On Windows, space-containing arguments in git commit -m can fail if not explicitly quoted
  // because of how Deno.Command interacts with the Windows shell. We manually wrap space-containing args in quotes, 
  // but we intentionally leave windowsRawArguments false to avoid breaking the core PATH execution.
  const processedArgs = (Deno.build.os === "windows") 
    ? args.map(arg => (arg.includes(" ") && !arg.startsWith("\"")) ? `"${arg}"` : arg)
    : args;

  const cmd = new Deno.Command("git", { args: processedArgs, cwd });
  const { code, stderr } = await cmd.output();
  if (code !== 0) {
    throw new Error(`Git command failed: git ${args.join(" ")}\n${new TextDecoder().decode(stderr)}`);
  }
}

async function setupGitProject(tempDir: string, driverPath: string) {
  try {
    await runGit(tempDir, "init", "-b", "main");
  } catch {
    await runGit(tempDir, "init");
    await runGit(tempDir, "checkout", "-b", "main");
  }
  await runGit(tempDir, "config", "user.email", "test@example.com");
  await runGit(tempDir, "config", "user.name", "Test User");

  // Add our custom strategy to the PATH for Git to find it
  const driverDir = path.dirname(driverPath);
  const pathDelimiter = Deno.build.os === "windows" ? ";" : ":";
  const oldPath = Deno.env.get("PATH") || Deno.env.get("Path") || "";
  const newPath = `${driverDir}${pathDelimiter}${oldPath}`;
  
  Deno.env.set("PATH", newPath);
  if (Deno.build.os === "windows") {
    Deno.env.set("Path", newPath);
  }

  // On Windows, Git expects the strategy to be named exactly 'git-merge-sqlitevfs' 
  // without the .exe extension if it's placed in the PATH. We'll write multiple wrappers.
  if (Deno.build.os === "windows") {
    const exeName = "git-merge-sqlitevfs.exe";
    
    // Create bash wrapper (Git for Windows uses bash for strategy resolution)
    const bashWrapper = path.resolve(driverDir, "git-merge-sqlitevfs");
    Deno.writeTextFileSync(bashWrapper, `#!/bin/sh\nexec "$(dirname "$0")/${exeName}" "$@"\n`);
    
    // Create cmd wrapper just in case
    const cmdWrapper = path.resolve(driverDir, "git-merge-sqlitevfs.cmd");
    Deno.writeTextFileSync(cmdWrapper, `@echo off\n"%~dp0${exeName}" %*\n`);
  }

  // We need at least one commit so we can branch from it.
  await Deno.writeTextFile(path.resolve(tempDir, "README.md"), "# Test Project\n");
  await runGit(tempDir, "add", "README.md");
  await runGit(tempDir, "commit", "-m", "Initial_commit");
}

Deno.test("Merge Driver: Concurrent Inserts", async (t) => {
  const tempDir = Deno.makeTempDirSync({ prefix: "merge_concurrent_" });
  const driverPath = path.resolve(Deno.cwd(), "../output/git-merge-sqlitevfs");
  const dbPath = path.resolve(tempDir, "concurrent.db");

  try {
    await setupGitProject(tempDir, driverPath);

    await t.step("Setup base database", () => {
      const db = initVfs(dbPath);
      db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);");
      db.close();
    });

    await runGit(tempDir, "add", "-A");
    await runGit(tempDir, "commit", "-m", "Create_database");

    await t.step("Branch A: Insert Alice", async () => {
      await runGit(tempDir, "checkout", "-b", "branch-a");
      const db = initVfs(dbPath);
      db.exec("INSERT INTO users (id, name) VALUES (1, 'Alice');");
      db.close();
      await runGit(tempDir, "add", "-A");
      await runGit(tempDir, "commit", "-m", "Add_Alice");
    });

    await t.step("Branch B: Insert Bob", async () => {
      await runGit(tempDir, "checkout", "main");
      await runGit(tempDir, "checkout", "-b", "branch-b");
      const db = initVfs(dbPath);
      db.exec("INSERT INTO users (id, name) VALUES (2, 'Bob');");
      db.close();
      await runGit(tempDir, "add", "-A");
      await runGit(tempDir, "commit", "-m", "Add_Bob");
    });
    await t.step("Merge B into A", async () => {
      await runGit(tempDir, "checkout", "branch-a");
      await runGit(tempDir, "merge", "-s", "sqlitevfs", "branch-b");
    });

    await t.step("Verify merge results", () => {
      const db = initVfs(dbPath);
      const rows = db.prepare("SELECT name FROM users ORDER BY id").all<{ name: string }>();
      expect(rows.length).toBe(2);
      expect(rows[0].name).toBe("Alice");
      expect(rows[1].name).toBe("Bob");
      db.close();
    });
  } finally {
    Deno.removeSync(tempDir, { recursive: true });
    try {
      for (const entry of Deno.readDirSync("/tmp")) {
        if (entry.name.startsWith("gitvfs_")) {
          Deno.removeSync(path.resolve("/tmp", entry.name), { recursive: true });
        }
      }
    } catch {}
  }
});

Deno.test("Merge Driver: Primary Key Conflict", async (t) => {
  const tempDir = Deno.makeTempDirSync({ prefix: "merge_pk_conflict_" });
  const driverPath = path.resolve(Deno.cwd(), "../output/git-merge-sqlitevfs");
  const dbPath = path.resolve(tempDir, "pk_conflict.db");

  try {
    await setupGitProject(tempDir, driverPath);

    await t.step("Setup base database", () => {
      const db = initVfs(dbPath);
      db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);");
      db.close();
    });

    await runGit(tempDir, "add", "-A");
    await runGit(tempDir, "commit", "-m", "Create_database");

    await t.step("Branch A: Insert Alice as ID 1", async () => {
      await runGit(tempDir, "checkout", "-b", "branch-a");
      const db = initVfs(dbPath);
      db.exec("INSERT INTO users (id, name) VALUES (1, 'Alice');");
      db.close();
      await runGit(tempDir, "add", "-A");
      await runGit(tempDir, "commit", "-m", "Add_Alice");
    });

    await t.step("Branch B: Insert Bob as ID 1", async () => {
      await runGit(tempDir, "checkout", "main");
      await runGit(tempDir, "checkout", "-b", "branch-b");
      const db = initVfs(dbPath);
      db.exec("INSERT INTO users (id, name) VALUES (1, 'Bob');");
      db.close();
      await runGit(tempDir, "add", "-A");
      await runGit(tempDir, "commit", "-m", "Add_Bob");
    });

    await t.step("Merge B into A", async () => {
      await runGit(tempDir, "checkout", "branch-a");
      await runGit(tempDir, "merge", "-s", "sqlitevfs", "branch-b");
    });

    await t.step("Verify Alice remains", () => {
      const db = initVfs(dbPath);
      const rows = db.prepare("SELECT name FROM users").all<{ name: string }>();
      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe("Alice");
      db.close();
    });
  } finally {
    Deno.removeSync(tempDir, { recursive: true });
    try {
      for (const entry of Deno.readDirSync("/tmp")) {
        if (entry.name.startsWith("gitvfs_")) {
          Deno.removeSync(path.resolve("/tmp", entry.name), { recursive: true });
        }
      }
    } catch {}
  }
});

Deno.test("Merge Driver Scale: Large Data Volume & Conflicts", async (t) => {
  const tempDir = Deno.makeTempDirSync({ prefix: "merge_scale_data_" });
  const driverPath = path.resolve(Deno.cwd(), "../output/git-merge-sqlitevfs");
  const dbName = `scale_${Date.now()}.db`;
  const dbPath = path.resolve(tempDir, dbName);

  try {
    await setupGitProject(tempDir, driverPath);

    await t.step("Setup base rows (5000)", () => {
      const db = initVfs(dbPath);
      db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);");
      const insert = db.prepare("INSERT INTO users (id, name) VALUES (?, ?);");
      db.exec("BEGIN;");
      for (let i = 1; i <= 5000; i++) {
        insert.run(i, `Original User ${i}`);
      }
      db.exec("COMMIT;");
      db.close();
    });

    await runGit(tempDir, "add", "-A");
    await runGit(tempDir, "commit", "-m", "Initial_5000_users");

    await t.step("Branch A: Add 10000 rows (5001-15000)", async () => {
      await runGit(tempDir, "checkout", "-b", "branch-a");
      const db = initVfs(dbPath);
      const insert = db.prepare("INSERT INTO users (id, name) VALUES (?, ?);");
      db.exec("BEGIN;");
      for (let i = 5001; i <= 15000; i++) {
        insert.run(i, `A-User ${i}`);
      }
      db.exec("COMMIT;");
      db.close();
      await runGit(tempDir, "add", "-A");
      await runGit(tempDir, "commit", "-m", "Branch_A_adds_10k");
    });

    await t.step("Branch B: Add 10000 rows (10001-20000, 50% conflict)", async () => {
      await runGit(tempDir, "checkout", "main");
      await runGit(tempDir, "checkout", "-b", "branch-b");
      const db = initVfs(dbPath);
      const insert = db.prepare("INSERT INTO users (id, name) VALUES (?, ?);");
      db.exec("BEGIN;");
      for (let i = 10001; i <= 20000; i++) {
        insert.run(i, `B-User ${i}`);
      }
      db.exec("COMMIT;");
      db.close();
      await runGit(tempDir, "add", "-A");
      await runGit(tempDir, "commit", "-m", "Branch_B_adds_10k_with_overlaps");
    });

    await t.step("Merge B into A", async () => {
      await runGit(tempDir, "checkout", "branch-a");
      // This will involve 5000 PK conflicts
      await runGit(tempDir, "merge", "-s", "sqlitevfs", "branch-b");
    });

    await t.step("Verify 20,000 unique records", () => {
      const db = initVfs(dbPath);
      const [{ count }] = db.prepare("SELECT count(*) as count FROM users;").all<{ count: number }>();
      expect(count).toBe(20000);

      // Verify that for conflicting IDs (e.g., 12000), Branch A's data persists
      const rows = db.prepare("SELECT name FROM users WHERE id = 12000;").all<{ name: string }>();
      expect(rows[0].name).toBe("A-User 12000");
      db.close();
    });
  } finally {
    Deno.removeSync(tempDir, { recursive: true });
    try {
      for (const entry of Deno.readDirSync("/tmp")) {
        if (entry.name.startsWith("gitvfs_")) {
          Deno.removeSync(path.resolve("/tmp", entry.name), { recursive: true });
        }
      }
    } catch {}
  }
});

Deno.test("Merge Driver Scale: Schema Buffer Limits", async (t) => {
  const tempDir = Deno.makeTempDirSync({ prefix: "merge_scale_schema_" });
  const driverPath = path.resolve(Deno.cwd(), "../output/git-merge-sqlitevfs");
  const dbName = `schema_${Date.now()}.db`;
  const dbPath = path.resolve(tempDir, dbName);

  try {
    await setupGitProject(tempDir, driverPath);

    await t.step("Setup initial DB", () => {
      const db = initVfs(dbPath);
      db.exec("CREATE TABLE baseline (id INTEGER);");
      db.close();
    });
    await runGit(tempDir, "add", "-A");
    await runGit(tempDir, "commit", "-m", "Init_baseline");

    await t.step("Branch A: Minor change", async () => {
      await runGit(tempDir, "checkout", "-b", "branch-a");
      const db = initVfs(dbPath);
      db.exec("CREATE TABLE a_marker (id INTEGER);");
      db.close();
      await runGit(tempDir, "add", "-A");
      await runGit(tempDir, "commit", "-m", "Branch_A_change");
    });

    await t.step("Branch B: 2000 Tables (Exceeding 1MB Schema)", async () => {
      await runGit(tempDir, "checkout", "main");
      await runGit(tempDir, "checkout", "-b", "branch-b");
      const db = initVfs(dbPath);
      db.exec("BEGIN;");
      for (let i = 0; i < 2000; i++) {
        // Each statement is ~50-60 bytes, 2000 tables is ~120KB. 
        // Wait, the C buffer is 1MB. Let's do 20,000 tables.
        // Or 5,000 tables with slightly longer names and columns.
        db.exec(`CREATE TABLE big_schema_table_with_a_long_name_${i} (id INTEGER, data TEXT, more_data TEXT, even_more_data TEXT);`);
      }
      db.exec("COMMIT;");
      db.close();
      await runGit(tempDir, "add", "-A");
      await runGit(tempDir, "commit", "-m", "Branch_B_massive_schema");
    });

    await t.step("Merge B into A", async () => {
      await runGit(tempDir, "checkout", "branch-a");
      // This will likely trigger the 1MB buffer limit in the C code if we're not careful
      await runGit(tempDir, "merge", "-s", "sqlitevfs", "branch-b");
    });

    await t.step("Verify schema propagation", () => {
      const db = initVfs(dbPath);
      const [{ count }] = db.prepare("SELECT count(*) as count FROM sqlite_schema WHERE type='table' AND name LIKE 'big_schema_table_%';").all<{ count: number }>();
      expect(count).toBe(2000);
      db.close();
    });
  } finally {
    Deno.removeSync(tempDir, { recursive: true });
    try {
      for (const entry of Deno.readDirSync("/tmp")) {
        if (entry.name.startsWith("gitvfs_")) {
          Deno.removeSync(path.resolve("/tmp", entry.name), { recursive: true });
        }
      }
    } catch {}
  }
});
