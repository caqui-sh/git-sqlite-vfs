#!/usr/bin/env node

import path from 'node:path';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { configureGitIntegration, createVFSClient } from '../index.js';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { drizzle } from 'drizzle-orm/libsql';

async function readConfig() {
    const paths = [
        'drizzle.config.ts',
        'drizzle.config.js',
        'drizzle.config.json'
    ];

    for (const p of paths) {
        const fullPath = path.resolve(process.cwd(), p);
        if (fs.existsSync(fullPath)) {
            try {
                const content = fs.readFileSync(fullPath, 'utf-8');
                
                // Simple regex-based parsing to avoid needing a TS runner
                const outMatch = content.match(/out:\s*['"`](.+?)['"`]/);
                const urlMatch = content.match(/url:\s*['"`](.+?)['"`]/);
                const schemaMatch = content.match(/schema:\s*['"`](.+?)['"`]/);

                return {
                    out: outMatch ? outMatch[1] : undefined,
                    url: urlMatch ? urlMatch[1] : undefined,
                    schema: schemaMatch ? schemaMatch[1] : undefined,
                };
            } catch (e) {
                // Ignore parsing errors
            }
        }
    }
    return {};
}

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
This command runs 'drizzle-kit generate' followed by 'migrate' to apply changes.

Options:
  --schema <path>       Path to your drizzle schema file
  --migrations <path>   Path to your migrations folder (default: 'out' from drizzle.config)
  --url <url>          Database URL (default: 'url' from drizzle.config or file:.db/main.db)
  -v, --vfs-dir <path>      The VFS shard directory (default: .db)
  -h, --help           Show this help message
`;

const migrateHelpText = `
Usage: git-sqlite-vfs migrate [options]

Run migrations against the database.

Options:
  --migrations <path>   Path to your migrations folder (default: 'out' from drizzle.config)
  --url <url>          Database URL (default: 'url' from drizzle.config or file:.db/main.db)
  -v, --vfs-dir <path>      The VFS shard directory (default: .db)
  -h, --help           Show this help message
`;

async function main() {
    const config = await readConfig();

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
        const migrationsFolder = values.migrations || config.out;
        if (!migrationsFolder) {
            console.error('Error: migrations folder not found. Please provide --migrations <path> or define it in drizzle.config');
            process.exit(1);
        }

        const url = values.url || config.url || 'file:.db/main.db';
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
        const url = values.url || config.url || 'file:.db/main.db';
        const vfsDir = values['vfs-dir'] || '.db';
        const migrationsFolder = values.migrations || config.out || './drizzle';

        console.log(`Pushing schema changes...`);
        console.log(`Database: ${url}`);

        try {
            const { execSync } = await import('node:child_process');
            
            console.log('Step 1: Generating migration from schema...');
            let genCmd = `npx drizzle-kit generate`;
            if (values.schema) genCmd += ` --schema ${values.schema}`;
            if (values.migrations) genCmd += ` --out ${values.migrations}`;
            else if (config.out) genCmd += ` --out ${config.out}`;
            // If no config.out and no values.migrations, it defaults to ./drizzle in drizzle-kit
            
            execSync(genCmd, { stdio: 'inherit' });

            console.log('Step 2: Applying migration to VFS database...');
            const client = await createVFSClient({ url, dir: vfsDir });
            const db = drizzle(client);
            await migrate(db, { migrationsFolder });
            client.close();

            console.log('\nPush completed successfully!');
        } catch (err) {
            console.error('\nPush failed:', err.message);
            process.exit(1);
        }
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
