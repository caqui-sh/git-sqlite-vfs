const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const GitSQLite = require('./index.js');

// Helper to run git commands synchronously
const runGit = (cmd) => execSync(cmd, { stdio: 'pipe' }).toString().trim();

// Helper to recursively calculate total directory size
const getDirSize = (dirPath) => {
    let total = 0;
    if (!fs.existsSync(dirPath)) return 0;
    
    const files = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const file of files) {
        const fullPath = path.join(dirPath, file.name);
        if (file.isDirectory()) {
            total += getDirSize(fullPath);
        } else {
            total += fs.statSync(fullPath).size;
        }
    }
    return total;
};

describe('GitSQLite Architecture Validation', () => {
    let db;

    before(() => {
        // Initialize Git repo optimizations and register driver configurations
        GitSQLite.setupGit();
    });

    it('Test 1: Initialization & VFS Sharding', () => {
        db = GitSQLite.open('.db');

        // Create initial schema
        db.exec(`
            CREATE TABLE test_data (id INTEGER PRIMARY KEY, name TEXT, value BLOB);
            CREATE TABLE test_settings (config_key TEXT PRIMARY KEY, config_val TEXT);
        `);

        // Insert initial baseline data using parameterized transactions
        const insertData = db.prepare("INSERT INTO test_data (name, value) VALUES (?, randomblob(100))");
        const insertSettings = db.prepare("INSERT INTO test_settings (config_key, config_val) VALUES (?, ?)");

        db.exec('BEGIN TRANSACTION;');
        for (let i = 1; i <= 50; i++) {
            insertData.run(`Initial ${i}`);
        }
        insertSettings.run('theme', 'dark');
        db.exec('COMMIT;');

        // Close to flush SQLite connections (VFS sync)
        db.close(); 

        // Assert our C VFS dynamically intercepted physical I/O and sharded the B-Tree!
        assert.ok(fs.existsSync('.db/pages'), 'Pages directory should exist');
        assert.ok(fs.existsSync('.db/pages/size.meta'), 'size.meta persistence state should exist');

        // Verify git tracking structure
        assert.ok(fs.existsSync('.db/.gitignore'), '.gitignore should be generated');
        assert.ok(fs.existsSync('.db/pages/.gitattributes'), '.gitattributes should be generated');

        // Stage and Commit Snapshot 1
        runGit('git add -A -f .db/');
        runGit('git commit -m "Snapshot 1: Initial DB state"');
    });

    it('Test 2: VACUUM and Physical B-Tree Shrinkage', () => {
        db = GitSQLite.open('.db');

        // Insert a massive amount of rows to forcibly expand the B-Tree footprint
        db.exec('BEGIN TRANSACTION;');
        const insertData = db.prepare("INSERT INTO test_data (name, value) VALUES ('Bulk', randomblob(100))");
        for (let i = 0; i < 10000; i++) {
            insertData.run();
        }
        db.exec('COMMIT;');
        db.close();

        // Capture total file system footprint of the expanded sharded VFS
        const sizeBefore = getDirSize('.db/pages');

        // Reopen, execute a massive deletion, and trigger a vacuum
        db = GitSQLite.open('.db');
        db.exec("DELETE FROM test_data WHERE id > 50;");
        db.exec("VACUUM;");
        db.close();

        // Capture total file system footprint post-vacuum
        const sizeAfter = getDirSize('.db/pages');

        // Assert mathematical shrinkage: our xTruncate implementation successfully unlinked dead pages!
        assert.ok(sizeAfter < sizeBefore, `Directory size must shrink after VACUUM. Before: ${sizeBefore}, After: ${sizeAfter}`);

        // Stage and Commit Snapshot 2 (Unlinked files must be natively staged as Git deletions)
        runGit('git add -A -f .db/');
        runGit('git commit -m "Snapshot 2: Vacuumed database"');
    });

    it('Test 3: Git Branching & True 3-Way Merge (DDL + Row Conflicts)', () => {
        // --- CONFLICT BRANCH MUTATIONS ---
        runGit('git checkout -b conflict_branch');
        db = GitSQLite.open('.db');
        db.exec(`
            INSERT INTO test_data (id, name, value) VALUES (10001, 'conflict_branch', randomblob(100));
            INSERT INTO test_settings (config_key, config_val) VALUES ('plugin', 'enabled');
            UPDATE test_data SET name = 'branch_update' WHERE id = 10;
            DELETE FROM test_data WHERE id = 15;
            UPDATE test_data SET name = 'branch_wins' WHERE id = 50;
            CREATE TABLE new_feature (id INTEGER PRIMARY KEY, feature_name TEXT);
            INSERT INTO new_feature (id, feature_name) VALUES (1, 'version_control');
            CREATE INDEX idx_test_name ON test_data(name);
            DROP TABLE test_settings;
        `);
        db.close();
        runGit('git add -A -f .db/');
        runGit('git commit -m "conflict_branch: Schema evolution and row updates"');

        // --- MASTER BRANCH MUTATIONS ---
        runGit('git checkout master');
        db = GitSQLite.open('.db');
        db.exec(`
            INSERT INTO test_data (id, name, value) VALUES (10002, 'master', randomblob(100));
            CREATE TABLE unrelated_table (id INTEGER);
            UPDATE test_data SET name = 'master_update' WHERE id = 20;
            UPDATE test_data SET name = 'master_wins' WHERE id = 50;
        `);
        db.close();
        runGit('git add -A -f .db/');
        runGit('git commit -m "master: Insertions and row updates"');

        // --- THE CUSTOM GIT MERGE STRATEGY ---
        const binPath = path.resolve(__dirname, 'c/output');
        try {
            // By utilizing the -s sqlitevfs strategy and augmenting our PATH, Git natively
            // delegates the entire branch resolution to our SQLite C engine!
            execSync(`PATH=$PATH:${binPath} git merge -s sqlitevfs conflict_branch -m "Merge conflict_branch into master"`, { stdio: 'pipe' });
        } catch (e) {
            console.error("Merge failed:\n", e.stdout?.toString(), e.stderr?.toString());
            throw e;
        }

        // --- ASSERTIONS (Mathematical verification of 3-Way Logical Merge) ---
        db = GitSQLite.open('.db');
        
        // Assert True Row Conflict Resolution (Master Wins)
        const row50 = db.prepare("SELECT name FROM test_data WHERE id = 50").get();
        assert.strictEqual(row50.name, 'master_wins', 'Master must win true row-level collisions by Custom Merge Strategy logic');

        // Assert standard branch updates
        const row10 = db.prepare("SELECT name FROM test_data WHERE id = 10").get();
        assert.strictEqual(row10.name, 'branch_update');

        const row20 = db.prepare("SELECT name FROM test_data WHERE id = 20").get();
        assert.strictEqual(row20.name, 'master_update');

        // Assert branch deletions
        const row15 = db.prepare("SELECT name FROM test_data WHERE id = 15").get();
        assert.strictEqual(row15, undefined, 'Row 15 must have been deleted by conflict_branch');

        // Assert 3-Way Schema Evolution (DDL Merge)
        const settingsTable = db.prepare("SELECT count(*) as cnt FROM sqlite_schema WHERE name='test_settings'").get();
        assert.strictEqual(settingsTable.cnt, 0, 'test_settings table must be mathematically DROPPED');

        const newFeatureRow = db.prepare("SELECT feature_name FROM new_feature WHERE id = 1").get();
        assert.strictEqual(newFeatureRow.feature_name, 'version_control', 'new_feature table and its row data must exist');

        const idx = db.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND name='idx_test_name'").get();
        assert.ok(idx, 'idx_test_name index must have been created');

        db.close();
    });

    it('Test 4: Time Travel (Disaster Recovery via Git)', () => {
        db = GitSQLite.open('.db');
        
        // Assert initial baseline existence
        let featureTable = db.prepare("SELECT count(*) as cnt FROM sqlite_schema WHERE name='new_feature'").get();
        assert.strictEqual(featureTable.cnt, 1);

        // Execute a catastrophic, destructive operation
        db.exec("DROP TABLE new_feature;");
        featureTable = db.prepare("SELECT count(*) as cnt FROM sqlite_schema WHERE name='new_feature'").get();
        assert.strictEqual(featureTable.cnt, 0, 'Table must be completely dropped from SQLite');
        db.close();

        // Commit the disaster
        runGit('git add -A -f .db/');
        runGit('git commit -m "Oops, accidentally dropped new_feature"');

        // Initiate Time Travel (Git Reset)
        // Because the database is perfectly versioned, Git instantly restores the .bin files
        runGit('git reset --hard HEAD~1');

        // Reopen DB and Verify absolute recovery
        db = GitSQLite.open('.db');
        featureTable = db.prepare("SELECT count(*) as cnt FROM sqlite_schema WHERE name='new_feature'").get();
        assert.strictEqual(featureTable.cnt, 1, 'Table schema must be fully resurrected natively by Git!');
        
        const row = db.prepare("SELECT feature_name FROM new_feature WHERE id = 1").get();
        assert.strictEqual(row.feature_name, 'version_control', 'Physical row data must be fully intact after time travel!');

        db.close();
    });
});
