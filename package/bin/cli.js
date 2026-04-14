#!/usr/bin/env node

import path from 'node:path';
import { parseArgs } from 'node:util';
import { configureGitIntegration } from '../index.js';

const options = {
    'repo-dir': {
        type: 'string',
        short: 'r',
    },
    'vfs-dir': {
        type: 'string',
        short: 'v',
    },
    help: {
        type: 'boolean',
        short: 'h',
    },
};

const { values, positionals } = parseArgs({ options, allowPositionals: true });

if (values.help) {
    console.log(`
Usage: git-sqlite-setup [options]

Initialize and configure the current Git repository to use the git-sqlite-vfs.
This command ensures the necessary binaries are present and sets up the Git merge driver.

Options:
  -r, --repo-dir <path>   Path to the Git repository (default: current working directory)
  -v, --vfs-dir <path>    The VFS shard directory to apply the merge driver to (default: .db)
  -h, --help              Show this help message
`);
    process.exit(0);
}

const repoDir = values['repo-dir'] ? path.resolve(values['repo-dir']) : process.cwd();
const vfsDir = values['vfs-dir'] || '.db';

console.log(`Initializing Git SQLite VFS...`);
console.log(`Repository: ${repoDir}`);
console.log(`VFS Target Directory: ${vfsDir}`);

try {
    // This will trigger downloadOrBuild if binaries are missing
    await configureGitIntegration({ repoDir, vfsDir });
    console.log(`\nSuccessfully initialized Git SQLite VFS!`);
    console.log(`Git will now use the custom C merge driver for conflicts inside: ${vfsDir}/*`);
    console.log(`\nTo use it in your code, use 'createVFSClient' from 'git-sqlite-vfs'.`);
} catch (err) {
    console.error(`\nFailed to initialize Git integration:`, err.message);
    process.exit(1);
}
