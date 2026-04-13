#!/usr/usr/bin/env node

import path from 'node:path';
import { parseArgs } from 'node:util';
import { configureGitIntegration } from '../index.js';
import { migrateDatabase } from './migrate.js';

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
       git-sqlite-setup migrate <source_legacy_db_file> <target_vfs_directory>

Configure the current Git repository to use the git-sqlite-vfs merge driver.
This natively intercepts merge conflicts on your SQLite B-Tree binary shards.

Options:
  -r, --repo-dir <path>   Path to the Git repository (default: current working directory)
  -v, --vfs-dir <path>    The VFS shard directory to apply the merge driver to (default: .db)
  -h, --help              Show this help message
`);
    process.exit(0);
}

if (positionals[0] === 'migrate') {
    const sourceLegacyDb = positionals[1];
    const targetVfsDir = positionals[2];

    if (!sourceLegacyDb || !targetVfsDir) {
        console.error('Usage: npx git-sqlite-vfs migrate <source_legacy_db_file> <target_vfs_directory>');
        process.exit(1);
    }

    migrateDatabase(sourceLegacyDb, targetVfsDir)
        .then(() => process.exit(0))
        .catch(err => {
            console.error('Migration failed:', err);
            process.exit(1);
        });
} else {
    const repoDir = values['repo-dir'] ? path.resolve(values['repo-dir']) : process.cwd();
    const vfsDir = values['vfs-dir'] || '.db';

    console.log(`Configuring Git Integration...`);
    console.log(`Repository: ${repoDir}`);
    console.log(`VFS Target Directory: ${vfsDir}`);

    try {
        await configureGitIntegration({ repoDir, vfsDir });
        console.log(`\nSuccessfully configured the SQLite VFS merge driver!`);
        console.log(`Git will now use the custom C merge driver for conflicts inside: ${vfsDir}/*`);
    } catch (err) {
        console.error(`\nFailed to configure Git integration:`, err.message);
        process.exit(1);
    }
}
