#!/bin/bash
set -e

cd package/c
echo "=== Cleaning up old state ==="
make clean

echo "=== Compiling executables ==="
make
cd ../..
rm -rf .db .git

echo "=== Initializing git repository ==="
git init --initial-branch=master
git config user.email "test@example.com"
git config user.name "Test User"
# Optimize Git for 4KB binary pages to guarantee xdelta works nicely
git config core.bigFileThreshold 10m

echo "=== Initializing database ==="
./package/c/output/gitvfs_test init

echo "=== Committing initial database state (Snapshot 1) ==="
git add -f .db/pages/
git commit -m "Snapshot 1: Initial DB state"

echo "=== Mutating database (Snapshot 2) ==="
./package/c/output/gitvfs_test "UPDATE test_data SET value = randomblob(100) WHERE id = 5;"

echo "=== Committing mutated database state (Snapshot 2) ==="
git add -f .db/pages/
git commit -m "Snapshot 2: Mutated row id = 5"

echo "=== Forcing Git's xdelta packfile generation ==="
git gc --aggressive --prune=now

echo "=== Analyzing sizes ==="
echo "Size of Git objects pack:"
du -sh .git/objects/pack
echo "Size of .db/pages:"
du -sh .db/pages

echo "=== The Merge Test ==="
echo "Creating and checking out conflict_branch..."
git checkout -b conflict_branch

echo "Mutating database on conflict_branch..."
./package/c/output/gitvfs_test "INSERT INTO test_data (id, name, value) VALUES (10001, 'conflict', randomblob(100));"
./package/c/output/gitvfs_test "INSERT INTO test_settings (config_key, config_val) VALUES ('plugin', 'enabled');"
./package/c/output/gitvfs_test "UPDATE test_data SET name = 'branch_update' WHERE id = 10;"
./package/c/output/gitvfs_test "DELETE FROM test_data WHERE id = 15;"
./package/c/output/gitvfs_test "UPDATE test_data SET name = 'branch_wins' WHERE id = 500;"
./package/c/output/gitvfs_test "CREATE TABLE new_feature (id INTEGER PRIMARY KEY, feature_name TEXT);"
./package/c/output/gitvfs_test "INSERT INTO new_feature (id, feature_name) VALUES (1, 'version_control');"
./package/c/output/gitvfs_test "CREATE INDEX idx_test_name ON test_data(name);"
./package/c/output/gitvfs_test "DROP TABLE test_settings;"

echo "Committing mutation on conflict_branch..."
git add -f .db/pages/
git commit -m "conflict_branch: Inserted rows, updated id 10, deleted id 15, updated id 500, evolved schema"

echo "Checking out master..."
git checkout master

echo "Mutating database on master..."
./package/c/output/gitvfs_test "INSERT INTO test_data (id, name, value) VALUES (10002, 'master', randomblob(100));"
./package/c/output/gitvfs_test "INSERT INTO test_settings (config_key, config_val) VALUES ('mode', 'expert');"
./package/c/output/gitvfs_test "UPDATE test_data SET name = 'master_update' WHERE id = 20;"
./package/c/output/gitvfs_test "UPDATE test_data SET name = 'master_wins' WHERE id = 500;"

echo "Committing mutation on master..."
git add -f .db/pages/
git commit -m "master: Inserted rows, updated id 20, updated id 500"

echo "Merging conflict_branch into master..."
PATH=$PATH:$(pwd)/package/c/output git merge -s sqlitevfs conflict_branch -m "Merge conflict_branch into master"

echo "=== Verifying Logical Merge ==="
echo "--- test_data (expecting id 10 to be branch_update, id 15 missing, id 20 to be master_update, id 500 to be master_wins) ---"
./package/c/output/gitvfs_test "SELECT id, name FROM test_data WHERE id IN (10, 15, 20, 500);"
echo "--- test_settings (should be dropped, expecting 0) ---"
./package/c/output/gitvfs_test "SELECT count(*) AS settings_exists FROM sqlite_schema WHERE name='test_settings';"
echo "--- new_feature (expecting 1 row: version_control) ---"
./package/c/output/gitvfs_test "SELECT * FROM new_feature;"
echo "--- index (expecting idx_test_name) ---"
./package/c/output/gitvfs_test "SELECT name AS index_name FROM sqlite_schema WHERE type='index' AND name='idx_test_name';"

echo "=== Testing Python SQLite Extension Binding ==="
cat << 'EOF' > test_python_binding.py
import sqlite3
# Load the custom VFS extension into a temporary memory connection first
temp_conn = sqlite3.connect(':memory:')
temp_conn.enable_load_extension(True)
temp_conn.load_extension('./package/c/output/gitvfs.so')
temp_conn.close()

# Now connect to the sharded directory database using the registered VFS via URI
conn = sqlite3.connect('file:.db?vfs=gitvfs', uri=True)
cursor = conn.cursor()
cursor.execute("SELECT count(*) FROM test_data;")
print(f"Python successfully queried via gitvfs.so! Total rows: {cursor.fetchone()[0]}")
EOF
python3 test_python_binding.py

echo "=== Demonstrating VACUUM and Shrinkage ==="
./package/c/output/gitvfs_test "DELETE FROM test_data WHERE id > 50;"
./package/c/output/gitvfs_test "VACUUM;"
echo "Size after VACUUM (xTruncate should have unlinked files):"
du -sh .db/pages
git add -A -f .db/pages/ && git commit -m "Snapshot: Vacuumed database"

echo "=== Demonstrating Time Travel ==="
./package/c/output/gitvfs_test "DROP TABLE new_feature;"
./package/c/output/gitvfs_test "SELECT count(*) AS feature_exists FROM sqlite_schema WHERE name='new_feature';"
git add -A -f .db/pages/ && git commit -m "Oops, dropped new_feature"
echo "Rolling back to previous state..."
git reset --hard HEAD~1
./package/c/output/gitvfs_test "SELECT count(*) AS feature_exists FROM sqlite_schema WHERE name='new_feature';"

echo "=== Testing Native SQLite CLI Integration ==="
cat << 'EOF' > test_cli.sql
.load ./package/c/output/gitvfs.so
.open file:.db?vfs=gitvfs
SELECT 'Success! The official SQLite CLI queried ' || count(*) || ' rows directly from the Git-sharded VFS pages!' FROM test_data;
EOF
sqlite3 < test_cli.sql

echo "=== Test Complete ==="