import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import process from 'node:process';
import { downloadOrBuild } from './downloader.js';

let _dirname;
if (typeof __dirname !== 'undefined') {
    _dirname = __dirname;
} else {
    // Hide import.meta from the CJS parser
    let getMetaUrl;
    try {
        getMetaUrl = new Function('return import.meta.url');
    } catch (e) {}

    if (getMetaUrl) {
        _dirname = path.dirname(fileURLToPath(getMetaUrl()));
    } else {
        const match = new Error().stack.match(/(file:\/\/[^\s]+?):\d+:\d+/);
        _dirname = match ? path.dirname(fileURLToPath(match[1])) : process.cwd();
    }
}

// Determine the correct extension based on OS
const platform = os.platform();
let ext = 'so';
if (platform === 'darwin') {
    ext = 'dylib';
} else if (platform === 'win32') {
    ext = 'dll';
}

const extensionPathBase = path.resolve(_dirname, 'c', 'output', 'gitvfs');
const extensionPath = `${extensionPathBase}.${ext}`;

export const GITVFS_EXTENSION_PATH = extensionPath;

let _initialized = false;

async function ensureInitialized(options = {}) {
    if (_initialized) return;

    let currentExtPath = extensionPath;
    let loadPath = extensionPathBase;

    if (!fs.existsSync(currentExtPath)) {
        const writableDir = path.join(_dirname, '.git-sqlite-vfs-bin');
        currentExtPath = path.join(writableDir, `gitvfs.${ext}`);
        loadPath = path.join(writableDir, 'gitvfs');
    }

    // Dynamically import libsql so that we load the extension into its isolated native memory space.
    let Database;
    if (options.libsql) {
        Database = options.libsql.default || options.libsql.Database || options.libsql;
    } else {
        // Use bare specifier for compatibility with Node and Deno's Node-compat mode
        const lib = await import('libsql');
        Database = lib.default || lib.Database || lib;
    }

    const db = new Database(':memory:');
    // We pass loadPath (no extension) because libsql's loadExtension appends the platform-specific extension automatically.
    db.loadExtension(loadPath);
    db.close();

    _initialized = true;
}

export async function createVFSClient(options) {
    await ensureInitialized(options);

    const vfsDir = options.dir || '.db';
    if (typeof Deno !== 'undefined') {
        Deno.env.set('GIT_SQLITE_VFS_DIR', vfsDir);
    } else {
        process.env.GIT_SQLITE_VFS_DIR = vfsDir;
    }

    let createClientFn = options.createClient;
    if (!createClientFn) {
        if (typeof Deno !== 'undefined') {
            // Use bare specifier; Deno will resolve this via import map or its NPM resolution
            const mod = await import('@libsql/client/node');
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
    let driverDir = path.resolve(_dirname, 'c', 'output');
    let driverPath = path.join(driverDir, 'git-merge-sqlitevfs');
    if (platform === 'win32' && !fs.existsSync(driverPath) && fs.existsSync(driverPath + '.exe')) {
        driverPath += '.exe';
    }

    if (!fs.existsSync(driverPath)) {
        driverDir = path.join(_dirname, '.git-sqlite-vfs-bin');
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
