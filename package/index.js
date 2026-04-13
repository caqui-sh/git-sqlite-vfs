import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import process from 'node:process';
import { downloadOrBuild } from './downloader.js';

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

    let currentExtPath = extensionPath;
    if (!fs.existsSync(currentExtPath)) {
        const writableDir = path.join(__dirname, '.git-sqlite-vfs-bin');
        await downloadOrBuild(writableDir);
        currentExtPath = path.join(writableDir, `gitvfs.${ext}`);
    }

    // Dynamically import libsql so that we load the extension into its isolated native memory space.
    let Database;
    if (options.libsql) {
        Database = options.libsql.default || options.libsql.Database || options.libsql;
    } else if (typeof Deno !== 'undefined') {
        // Deno environment
        const lib = await import('npm:libsql');
        Database = lib.default || lib.Database || lib;
    } else {
        // Node.js environment
        const lib = await import('libsql');
        Database = lib.default || lib.Database || lib;
    }

    const db = new Database(':memory:');
    db.loadExtension(currentExtPath);
    db.close();

    try {
        const repoDir = typeof Deno !== 'undefined' ? Deno.cwd() : process.cwd();
        const vfsDir = options.dir || '.db';
        await configureGitIntegration({ repoDir, vfsDir });
    } catch (e) {
        // Ignore errors if git is not available or not in a git repository
    }
}

export async function createVFSClient(options) {
    let createClientFn = options.createClient;
    if (!createClientFn) {
        if (typeof Deno !== 'undefined') {
            // Gracefully default to Node native bindings in Deno to prevent bypassing the VFS
            const mod = await import('npm:@libsql/client/node');
            createClientFn = mod.createClient;
        } else {
            const mod = await import('@libsql/client');
            createClientFn = mod.createClient;
        }
    }

    const client = createClientFn(options.clientOptions || options);
    
    // Execute required PRAGMAs for the VFS to actively split and compact out-of-bounds shards
    await client.execute('PRAGMA auto_vacuum = FULL;');
    await client.execute('PRAGMA journal_mode = DELETE;');

    return client;
}

export async function configureGitIntegration({ repoDir, vfsDir }) {
    let driverDir = path.resolve(__dirname, 'c', 'output');
    let driverPath = path.join(driverDir, 'git-merge-sqlitevfs');
    if (platform === 'win32' && !fs.existsSync(driverPath) && fs.existsSync(driverPath + '.exe')) {
        driverPath += '.exe';
    }

    if (!fs.existsSync(driverPath)) {
        driverDir = path.join(__dirname, '.git-sqlite-vfs-bin');
        await downloadOrBuild(driverDir);
        driverPath = path.join(driverDir, 'git-merge-sqlitevfs');
        if (platform === 'win32' && !fs.existsSync(driverPath) && fs.existsSync(driverPath + '.exe')) {
            driverPath += '.exe';
        }
    }
    
    // Set the merge driver
    execSync(`git config merge.sqlitevfs.name "SQLite VFS Merge Driver"`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`git config merge.sqlitevfs.driver "${driverPath} %O %A %B %P"`, { cwd: repoDir, stdio: 'ignore' });

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

    // Create or update .gitignore in the repo root to ignore SQLite transient files
    const gitignorePath = path.join(repoDir, '.gitignore');
    const ignoreLines = [
        `${vfsDir}/*-journal`,
        `${vfsDir}/*-wal`,
        `${vfsDir}/*-shm`
    ];

    let gitignoreContent = '';
    if (fs.existsSync(gitignorePath)) {
        gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
    }
    
    const linesToAdd = ignoreLines.filter(line => !gitignoreContent.includes(line));
    if (linesToAdd.length > 0) {
        fs.appendFileSync(gitignorePath, (gitignoreContent.endsWith('\n') || gitignoreContent === '' ? '' : '\n') + linesToAdd.join('\n') + '\n');
    }
}
