const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

class GitSQLite {
    /**
     * Opens a SQLite database utilizing the custom Git Virtual File System (VFS).
     * By sharding the SQLite B-Tree into 4KB binary pages, it neutralizes cascading
     * byte shifts, allowing native Git xdelta to achieve near-perfect compression.
     * 
     * @param {string} dbPath - The path to the sharded database directory (e.g., '.db')
     * @returns {Database} - A native better-sqlite3 database connection
     */
    static open(dbPath) {
        // 1. Open a temporary in-memory database to act as an extension loader
        // better-sqlite3 requires an active connection to load an extension.
        const tempDb = new Database(':memory:');
        
        // 2. Enable extensions and load our compiled C VFS extension (.so)
        tempDb.loadExtension(path.resolve(__dirname, 'c/output/gitvfs'));
        
        // 3. Close tempDb. The SQLite runtime inside the Node process 
        // will permanently retain the global 'gitvfs' registration!
        tempDb.close();

        // 4. Instantiate and return the actual database connection.
        // Because our compiled extension registers itself as the default VFS, 
        // better-sqlite3 will automatically route all physical I/O for this DB
        // through our Git-sharded C engine!
        return new Database(dbPath);
    }

    /**
     * Configures the local Git repository with optimized binary thresholds 
     * and strictly wires up our custom C engine as a Git Merge Strategy.
     */
    static setupGit() {
        try {
            // Optimize Git for 4KB binary pages to guarantee xdelta works nicely
            // without prematurely terminating delta compression loops
            execSync('git config core.bigFileThreshold 10m', { stdio: 'ignore' });
            
            // Wire up the custom merge strategy driver with absolute paths
            // This natively binds our C executable to Git's conflict resolution pipeline
            const driverPath = path.resolve(__dirname, 'c/output/git-merge-sqlitevfs');
            execSync(`git config merge.sqlite_logical.name "SQLite Logical Merge Driver"`, { stdio: 'ignore' });
            execSync(`git config merge.sqlite_logical.driver "${driverPath} %O %A %B %P"`, { stdio: 'ignore' });
        } catch (err) {
            console.warn("Warning: Could not configure git attributes automatically.", err.message);
        }
    }
}

module.exports = GitSQLite;
