#!/usr/bin/env node

import path from 'node:path';
import { parseArgs } from 'node:util';
import { configureGitIntegration, createVFSClient } from '../index.js';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { drizzle } from 'drizzle-orm/libsql';

const helpText = `
Usage: git-sqlite-vfs <command> [options]

Commands:
  setup     Initialize and configure the Git repository for the VFS
  push      Push your schema to the database (requires a schema file)
  migrate   Run migrations against the database

General Options:
  -h, --help    Show this help message

Run 'git-sqlite-vfs <command> --help' for more information on a specific command.
`;

const setupHelpText = `
Usage: git-sqlite-vfs setup [options]

Initialize and configure the current Git repository to use the git-sqlite-vfs.

Options:
  -r, --repo-dir <path>   Path to the Git repository (default: current working directory)
  -v, --vfs-dir <path>    The VFS shard directory (default: .db)
  -h, --help              Show this help message
`;

const pushHelpText = `
Usage: git-sqlite-vfs push [options]

Synchronize your schema directly to the database. 
Note: This command currently requires a JS/TS file that exports your drizzle schema.

Options:
  --schema <path>   Path to your drizzle schema file (required)
  --url <url>      Database URL (default: file:.db/main.db)
  -v, --vfs-dir <path>  The VFS shard directory (default: .db)
  -h, --help       Show this help message
`;

const migrateHelpText = `
Usage: git-sqlite-vfs migrate [options]

Run migrations against the database.

Options:
  --migrations <path>   Path to your migrations folder (required)
  --url <url>          Database URL (default: file:.db/main.db)
  -v, --vfs-dir <path>      The VFS shard directory (default: .db)
  -h, --help           Show this help message
`;

async function main() {
    const { values, positionals } = parseArgs({
        options: {
            help: { type: 'boolean', short: 'h' },
            'repo-dir': { type: 'string', short: 'r' },
            'vfs-dir': { type: 'string', short: 'v' },
            schema: { type: 'string' },
            url: { type: 'string' },
            migrations: { type: 'string' },
        },
        allowPositionals: true,
        strict: false
    });

    const command = positionals[0];

    if (values.help || !command) {
        if (command === 'setup') console.log(setupHelpText);
        else if (command === 'push') console.log(pushHelpText);
        else if (command === 'migrate') console.log(migrateHelpText);
        else console.log(helpText);
        process.exit(0);
    }

    if (command === 'setup') {
        const repoDir = values['repo-dir'] ? path.resolve(values['repo-dir']) : process.cwd();
        const vfsDir = values['vfs-dir'] || '.db';

        console.log(`Initializing Git SQLite VFS...`);
        console.log(`Repository: ${repoDir}`);
        console.log(`VFS Target Directory: ${vfsDir}`);

        try {
            await configureGitIntegration({ repoDir, vfsDir });
            console.log(`\nSuccessfully initialized Git SQLite VFS!`);
            console.log(`Git will now use the custom C merge driver for conflicts inside: ${vfsDir}/*`);
        } catch (err) {
            console.error(`\nFailed to initialize Git integration:`, err.message);
            process.exit(1);
        }
    } else if (command === 'migrate') {
        const migrationsFolder = values.migrations;
        if (!migrationsFolder) {
            console.error('Error: --migrations <path> is required');
            process.exit(1);
        }

        const url = values.url || 'file:.db/main.db';
        const vfsDir = values['vfs-dir'] || '.db';

        console.log(`Running migrations...`);
        console.log(`Database: ${url}`);
        console.log(`Migrations: ${migrationsFolder}`);

        const client = await createVFSClient({ url, dir: vfsDir });
        const db = drizzle(client);

        try {
            await migrate(db, { migrationsFolder });
            console.log('Migrations completed successfully.');
        } catch (err) {
            console.error('Migration failed:', err.message);
            process.exit(1);
        } finally {
            client.close();
        }
    } else if (command === 'push') {
        console.error("Error: 'push' command is not fully implemented yet due to complexity of schema diffing. Please use 'migrate' with generated migrations.");
        process.exit(1);
    } else {
        console.error(`Unknown command: ${command}`);
        console.log(helpText);
        process.exit(1);
    }
}

main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
