import { expect } from "@std/expect";
import { existsSync } from "@std/fs/exists";
import * as path from "@std/path";
import { Database } from "@db/sqlite";

function getExtensionPath() {
  const base = path.resolve(Deno.cwd(), "../output/gitvfs");
  switch (Deno.build.os) {
    case "darwin":
      return `${base}.dylib`;
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
  // 0x02 (READWRITE) | 0x04 (CREATE) | 0x40 (URI) = 0x46
  const db = new Database(`file:${dbDir}?vfs=git`, { flags: 0x46 });
  db.exec("PRAGMA journal_mode=DELETE;");
  return db;
}

async function runGit(cwd: string, ...args: string[]) {
  const cmd = new Deno.Command("git", { args, cwd });
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

  const driverDir = path.dirname(driverPath);
  Deno.env.set("PATH", `${driverDir}:${Deno.env.get("PATH")}`);

  await Deno.writeTextFile(path.resolve(tempDir, "README.md"), "# Test Project\n");
  await runGit(tempDir, "add", "README.md");
  await runGit(tempDir, "commit", "-m", "Initial commit");
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
    await runGit(tempDir, "commit", "-m", "Initial database state");

    const baselineSize = getDirectorySize(path.resolve(tempDir, ".git/objects"));
    console.log(`  Baseline .git/objects size: ${baselineSize} bytes`);

    await t.step("Mutate data over 20 commits", async () => {
      for (let commitIdx = 0; commitIdx < 20; commitIdx++) {
        const db = initVfs(dbDir);
        for (let i = 0; i < 10; i++) {
          const id = (commitIdx * 10 + i) * 100 % 10000 + 1;
          db.exec(`UPDATE users SET data = 'mutated in commit ${commitIdx}' WHERE id = ${id};`);
        }
        db.close();
        await runGit(tempDir, "add", "-A");
        await runGit(tempDir, "commit", "-m", `Update batch ${commitIdx}`);
      }
    });

    const finalSize = getDirectorySize(path.resolve(tempDir, ".git/objects"));
    const growth = finalSize - baselineSize;
    console.log(`  Final .git/objects size: ${finalSize} bytes`);
    console.log(`  Total growth over 20 commits: ${growth} bytes`);

    await t.step("Assert anti-bloat property", () => {
      expect(growth).toBeLessThan(1024 * 1024); // 1MB threshold
    });
  } finally {
    Deno.removeSync(tempDir, { recursive: true });
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
      let pageCount = 0;
      for (const entry of Deno.readDirSync(path.resolve(dbDir, "pages"))) {
        if (entry.isDirectory) {
          for (const sub of Deno.readDirSync(path.resolve(dbDir, "pages", entry.name))) {
            if (sub.isDirectory) {
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
  }
});

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
    await runGit(tempDir, "commit", "-m", "Create database");

    await t.step("Branch A: Insert Alice", async () => {
      await runGit(tempDir, "checkout", "-b", "branch-a");
      const db = initVfs(dbPath);
      db.exec("INSERT INTO users (id, name) VALUES (1, 'Alice');");
      db.close();
      await runGit(tempDir, "add", "-A");
      await runGit(tempDir, "commit", "-m", "Add Alice");
    });

    await t.step("Branch B: Insert Bob", async () => {
      await runGit(tempDir, "checkout", "main");
      await runGit(tempDir, "checkout", "-b", "branch-b");
      const db = initVfs(dbPath);
      db.exec("INSERT INTO users (id, name) VALUES (2, 'Bob');");
      db.close();
      await runGit(tempDir, "add", "-A");
      await runGit(tempDir, "commit", "-m", "Add Bob");
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
    await runGit(tempDir, "commit", "-m", "Create database");

    await t.step("Branch A: Insert Alice as ID 1", async () => {
      await runGit(tempDir, "checkout", "-b", "branch-a");
      const db = initVfs(dbPath);
      db.exec("INSERT INTO users (id, name) VALUES (1, 'Alice');");
      db.close();
      await runGit(tempDir, "add", "-A");
      await runGit(tempDir, "commit", "-m", "Add Alice");
    });

    await t.step("Branch B: Insert Bob as ID 1", async () => {
      await runGit(tempDir, "checkout", "main");
      await runGit(tempDir, "checkout", "-b", "branch-b");
      const db = initVfs(dbPath);
      db.exec("INSERT INTO users (id, name) VALUES (1, 'Bob');");
      db.close();
      await runGit(tempDir, "add", "-A");
      await runGit(tempDir, "commit", "-m", "Add Bob");
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
    await runGit(tempDir, "commit", "-m", "Initial 5000 users");

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
      await runGit(tempDir, "commit", "-m", "Branch A adds 10k");
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
      await runGit(tempDir, "commit", "-m", "Branch B adds 10k with overlaps");
    });

    await t.step("Merge B into A", async () => {
      await runGit(tempDir, "checkout", "branch-a");
      await runGit(tempDir, "merge", "-s", "sqlitevfs", "branch-b");
    });

    await t.step("Verify 20,000 unique records", () => {
      const db = initVfs(dbPath);
      const [{ count }] = db.prepare("SELECT count(*) as count FROM users;").all<{ count: number }>();
      expect(count).toBe(20000);

      const rows = db.prepare("SELECT name FROM users WHERE id = 12000;").all<{ name: string }>();
      expect(rows[0].name).toBe("A-User 12000");
      db.close();
    });
  } finally {
    Deno.removeSync(tempDir, { recursive: true });
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
    await runGit(tempDir, "commit", "-m", "Init baseline");

    await t.step("Branch A: Minor change", async () => {
      await runGit(tempDir, "checkout", "-b", "branch-a");
      const db = initVfs(dbPath);
      db.exec("CREATE TABLE a_marker (id INTEGER);");
      db.close();
      await runGit(tempDir, "add", "-A");
      await runGit(tempDir, "commit", "-m", "Branch A change");
    });

    await t.step("Branch B: 2000 Tables", async () => {
      await runGit(tempDir, "checkout", "main");
      await runGit(tempDir, "checkout", "-b", "branch-b");
      const db = initVfs(dbPath);
      db.exec("BEGIN;");
      for (let i = 0; i < 2000; i++) {
        db.exec(`CREATE TABLE big_schema_table_with_a_long_name_${i} (id INTEGER, data TEXT, more_data TEXT, even_more_data TEXT);`);
      }
      db.exec("COMMIT;");
      db.close();
      await runGit(tempDir, "add", "-A");
      await runGit(tempDir, "commit", "-m", "Branch B massive schema");
    });

    await t.step("Merge B into A", async () => {
      await runGit(tempDir, "checkout", "branch-a");
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
  }
});

Deno.test("Merge Driver: Update and Delete Conflicts", async (t) => {
  const tempDir = Deno.makeTempDirSync({ prefix: "merge_update_delete_" });
  const driverPath = path.resolve(Deno.cwd(), "../output/git-merge-sqlitevfs");
  const dbPath = path.resolve(tempDir, "update_delete.db");

  try {
    await setupGitProject(tempDir, driverPath);

    await t.step("Setup base database", () => {
      const db = initVfs(dbPath);
      db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);");
      db.exec("INSERT INTO users (id, name) VALUES (1, 'Base');");
      db.close();
    });

    await runGit(tempDir, "add", "-A");
    await runGit(tempDir, "commit", "-m", "Create database");

    await t.step("Branch A: Update row", async () => {
      await runGit(tempDir, "checkout", "-b", "branch-a");
      const db = initVfs(dbPath);
      db.exec("UPDATE users SET name = 'Alice' WHERE id = 1;");
      db.close();
      await runGit(tempDir, "add", "-A");
      await runGit(tempDir, "commit", "-m", "Update to Alice");
    });

    await t.step("Branch B: Delete row", async () => {
      await runGit(tempDir, "checkout", "main");
      await runGit(tempDir, "checkout", "-b", "branch-b");
      const db = initVfs(dbPath);
      db.exec("DELETE FROM users WHERE id = 1;");
      db.close();
      await runGit(tempDir, "add", "-A");
      await runGit(tempDir, "commit", "-m", "Delete row");
    });

    await t.step("Merge B into A", async () => {
      await runGit(tempDir, "checkout", "branch-a");
      await runGit(tempDir, "merge", "-s", "sqlitevfs", "branch-b");
    });

    await t.step("Verify Alice remains (local changes favored)", () => {
      const db = initVfs(dbPath);
      const rows = db.prepare("SELECT name FROM users").all<{ name: string }>();
      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe("Alice");
      db.close();
    });
  } finally {
    Deno.removeSync(tempDir, { recursive: true });
  }
});

Deno.test("Merge Driver: Schema Evolution and Migrations", async (t) => {
  const tempDir = Deno.makeTempDirSync({ prefix: "merge_schema_evolution_" });
  const driverPath = path.resolve(Deno.cwd(), "../output/git-merge-sqlitevfs");
  const dbPath = path.resolve(tempDir, "schema_evo.db");

  try {
    await setupGitProject(tempDir, driverPath);

    await t.step("Setup base database", () => {
      const db = initVfs(dbPath);
      db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);");
      db.exec("INSERT INTO users (id, name) VALUES (1, 'Base User');");
      db.close();
    });

    await runGit(tempDir, "add", "-A");
    await runGit(tempDir, "commit", "-m", "Create database");

    await t.step("Branch A: Alter table add column", async () => {
      await runGit(tempDir, "checkout", "-b", "branch-a");
      const db = initVfs(dbPath);
      db.exec("ALTER TABLE users ADD COLUMN age INTEGER;");
      db.exec("UPDATE users SET age = 30 WHERE id = 1;");
      db.close();
      await runGit(tempDir, "add", "-A");
      await runGit(tempDir, "commit", "-m", "Add age column");
    });

    await t.step("Branch B: Insert with old schema", async () => {
      await runGit(tempDir, "checkout", "main");
      await runGit(tempDir, "checkout", "-b", "branch-b");
      const db = initVfs(dbPath);
      db.exec("INSERT INTO users (id, name) VALUES (2, 'Bob');");
      db.close();
      await runGit(tempDir, "add", "-A");
      await runGit(tempDir, "commit", "-m", "Add Bob");
    });

    await t.step("Merge B into A", async () => {
      await runGit(tempDir, "checkout", "branch-a");
      await runGit(tempDir, "merge", "-s", "sqlitevfs", "branch-b");
    });

    await t.step("Verify both changes applied", () => {
      const db = initVfs(dbPath);
      const rows = db.prepare("SELECT id, name, age FROM users ORDER BY id").all<{ id: number, name: string, age: number | null }>();
      expect(rows.length).toBe(2);
      expect(rows[0].name).toBe("Base User");
      expect(rows[0].age).toBe(30);
      expect(rows[1].name).toBe("Bob");
      expect(rows[1].age).toBe(null);
      db.close();
    });
  } finally {
    Deno.removeSync(tempDir, { recursive: true });
  }
});

Deno.test("Merge Driver: Foreign Key Constraints", async (t) => {
  const tempDir = Deno.makeTempDirSync({ prefix: "merge_fk_constraints_" });
  const driverPath = path.resolve(Deno.cwd(), "../output/git-merge-sqlitevfs");
  const dbPath = path.resolve(tempDir, "fk_constraints.db");

  try {
    await setupGitProject(tempDir, driverPath);

    await t.step("Setup base database", () => {
      const db = initVfs(dbPath);
      db.exec("PRAGMA foreign_keys = ON;");
      db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);");
      db.exec("CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER, title TEXT, FOREIGN KEY(user_id) REFERENCES users(id));");
      db.close();
    });

    await runGit(tempDir, "add", "-A");
    await runGit(tempDir, "commit", "-m", "Create tables");

    await t.step("Branch A: Insert Alice and post", async () => {
      await runGit(tempDir, "checkout", "-b", "branch-a");
      const db = initVfs(dbPath);
      db.exec("PRAGMA foreign_keys = ON;");
      db.exec("INSERT INTO users (id, name) VALUES (1, 'Alice');");
      db.exec("INSERT INTO posts (id, user_id, title) VALUES (1, 1, 'Alice Post');");
      db.close();
      await runGit(tempDir, "add", "-A");
      await runGit(tempDir, "commit", "-m", "Add Alice");
    });

    await t.step("Branch B: Insert Bob and post", async () => {
      await runGit(tempDir, "checkout", "main");
      await runGit(tempDir, "checkout", "-b", "branch-b");
      const db = initVfs(dbPath);
      db.exec("PRAGMA foreign_keys = ON;");
      db.exec("INSERT INTO users (id, name) VALUES (2, 'Bob');");
      db.exec("INSERT INTO posts (id, user_id, title) VALUES (2, 2, 'Bob Post');");
      db.close();
      await runGit(tempDir, "add", "-A");
      await runGit(tempDir, "commit", "-m", "Add Bob");
    });

    await t.step("Merge B into A", async () => {
      await runGit(tempDir, "checkout", "branch-a");
      await runGit(tempDir, "merge", "-s", "sqlitevfs", "branch-b");
    });

    await t.step("Verify no FK violations and data intact", () => {
      const db = initVfs(dbPath);
      db.exec("PRAGMA foreign_keys = ON;");
      const violations = db.prepare("PRAGMA foreign_key_check;").all();
      expect(violations.length).toBe(0);

      const users = db.prepare("SELECT name FROM users ORDER BY id").all<{ name: string }>();
      expect(users.length).toBe(2);
      expect(users[0].name).toBe("Alice");
      expect(users[1].name).toBe("Bob");

      const posts = db.prepare("SELECT title FROM posts ORDER BY id").all<{ title: string }>();
      expect(posts.length).toBe(2);
      expect(posts[0].title).toBe("Alice Post");
      expect(posts[1].title).toBe("Bob Post");
      db.close();
    });
  } finally {
    Deno.removeSync(tempDir, { recursive: true });
  }
});

Deno.test("Merge Driver: Concurrent Text and DB Edits", async (t) => {
  const tempDir = Deno.makeTempDirSync({ prefix: "merge_text_and_db_" });
  const driverPath = path.resolve(Deno.cwd(), "../output/git-merge-sqlitevfs");
  const dbPath = path.resolve(tempDir, "mixed.db");

  try {
    await setupGitProject(tempDir, driverPath);

    await t.step("Setup base database and text file", async () => {
      const db = initVfs(dbPath);
      db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);");
      db.close();

      await Deno.writeTextFile(path.resolve(tempDir, "README.md"), "line1\nline2\nline3\n");
    });

    await runGit(tempDir, "add", "-A");
    await runGit(tempDir, "commit", "-m", "Create database and text file");

    await t.step("Branch A: Modify text file (top) and insert Alice", async () => {
      await runGit(tempDir, "checkout", "-b", "branch-a");
      const db = initVfs(dbPath);
      db.exec("INSERT INTO users (id, name) VALUES (1, 'Alice');");
      db.close();

      await Deno.writeTextFile(path.resolve(tempDir, "README.md"), "line0-branchA\nline1\nline2\nline3\n");

      await runGit(tempDir, "add", "-A");
      await runGit(tempDir, "commit", "-m", "Branch A changes");
    });

    await t.step("Branch B: Modify text file (bottom) and insert Bob", async () => {
      await runGit(tempDir, "checkout", "main");
      await runGit(tempDir, "checkout", "-b", "branch-b");
      const db = initVfs(dbPath);
      db.exec("INSERT INTO users (id, name) VALUES (2, 'Bob');");
      db.close();

      await Deno.writeTextFile(path.resolve(tempDir, "README.md"), "line1\nline2\nline3\nline4-branchB\n");

      await runGit(tempDir, "add", "-A");
      await runGit(tempDir, "commit", "-m", "Branch B changes");
    });

    await t.step("Merge B into A", async () => {
      await runGit(tempDir, "checkout", "branch-a");
      await runGit(tempDir, "merge", "-s", "sqlitevfs", "branch-b");
    });

    await t.step("Verify both changes applied", async () => {
      const db = initVfs(dbPath);
      const rows = db.prepare("SELECT name FROM users ORDER BY id").all<{ name: string }>();
      expect(rows.length).toBe(2);
      expect(rows[0].name).toBe("Alice");
      expect(rows[1].name).toBe("Bob");
      db.close();

      const textContent = await Deno.readTextFile(path.resolve(tempDir, "README.md"));
      expect(textContent).toBe("line0-branchA\nline1\nline2\nline3\nline4-branchB\n");
    });
  } finally {
    Deno.removeSync(tempDir, { recursive: true });
  }
});
