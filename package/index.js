import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Determine the correct extension based on OS
const platform = os.platform();
let ext = 'so';
if (platform === 'darwin') {
    ext = 'dylib';
} else if (platform === 'win32') {
    ext = 'dll';
}

const extensionPath = path.resolve(__dirname, 'c', 'output', `gitvfs.${ext}`);

export const GITVFS_EXTENSION_PATH = extensionPath;

export async function bootstrapGitVFS(options = {}) {
    if (options.dir) {
        if (typeof Deno !== 'undefined') {
            Deno.env.set('GIT_SQLITE_VFS_DIR', options.dir);
        } else {
            process.env.GIT_SQLITE_VFS_DIR = options.dir;
        }
    }

    // Dynamically import libsql so that we load the extension into its isolated native memory space.
    let Database;
    if (typeof Deno !== 'undefined') {
        // Deno environment
        const lib = await import('npm:libsql');
        Database = lib.default || lib.Database || lib;
    } else {
        // Node.js environment
        const lib = await import('libsql');
        Database = lib.default || lib.Database || lib;
    }

    const db = new Database(':memory:');
    db.loadExtension(extensionPath);
    db.close();
}

export function configureGitIntegration({ repoDir, vfsDir }) {
    const driverPath = path.resolve(__dirname, 'c', 'output', 'git-merge-sqlitevfs');
    
    // Set the merge driver
    execSync(`git config merge.sqlitevfs.name "SQLite VFS Merge Driver"`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`git config merge.sqlitevfs.driver "${driverPath} %O %A %B"`, { cwd: repoDir, stdio: 'ignore' });

    // Append to .gitattributes
    const gitattributesPath = path.join(repoDir, '.gitattributes');
    const attributeLine = `${vfsDir}/* merge=sqlitevfs\n`;
    
    let content = '';
    if (fs.existsSync(gitattributesPath)) {
        content = fs.readFileSync(gitattributesPath, 'utf-8');
    }
    if (!content.includes(attributeLine.trim())) {
        fs.appendFileSync(gitattributesPath, attributeLine);
    }
}
