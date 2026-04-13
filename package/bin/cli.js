#!/usr/usr/bin/env node

import path from 'node:path';
import { parseArgs } from 'node:util';
import { configureGitIntegration, bootstrapGitVFS, createVFSClient } from '../index.js';

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

    console.log(`Migrating legacy DB: ${sourceLegacyDb}`);
    console.log(`Target VFS Directory: ${targetVfsDir}`);

    try {
        const sourcePath = path.resolve(sourceLegacyDb);
        const targetPath = path.resolve(targetVfsDir);
        
        const { createClient } = await import('@libsql/client');
        const sourceClient = createClient({ url: `file:${sourcePath}` });

        await bootstrapGitVFS({ dir: targetVfsDir });
        const targetClient = await createVFSClient({ url: `file:${path.join(targetPath, 'local.db')}` });

        console.log('Reading schema...');
        const schemaRes = await sourceClient.execute(`SELECT sql FROM sqlite_master WHERE type IN ('table', 'index') AND sql IS NOT NULL AND name != 'sqlite_sequence';`);

        for (const row of schemaRes.rows) {
            await targetClient.execute(row.sql);
        }

        const tablesRes = await sourceClient.execute(`SELECT name FROM sqlite_master WHERE type='table' AND name != 'sqlite_sequence';`);
        
        for (const tableRow of tablesRes.rows) {
            const tableName = tableRow.name;
            const batchSize = 1000;
            let offset = 0;
            let hasMore = true;
            let batchNum = 1;

            while (hasMore) {
                console.log(`Migrating table: ${tableName} (batch ${batchNum})...`);
                const rowsRes = await sourceClient.execute(`SELECT * FROM ${tableName} LIMIT ${batchSize} OFFSET ${offset}`);
                
                if (rowsRes.rows.length === 0) {
                    hasMore = false;
                    break;
                }

                // Chunk into smaller tx or individual inserts
                for (const row of rowsRes.rows) {
                    const columns = Object.keys(row).filter(k => isNaN(Number(k)));
                    const values = columns.map(k => row[k]);
                    
                    const placeholders = columns.map(() => '?').join(', ');
                    const query = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`;
                    
                    await targetClient.execute({
                        sql: query,
                        args: values
                    });
                }

                offset += batchSize;
                batchNum++;
            }
        }

        console.log('Vacuuming target DB for out-of-bounds shard chunking...');
        await targetClient.execute('VACUUM;');

        console.log('Migration complete!');
        process.exit(0);

    } catch (err) {
        console.error('Migration failed:', err);
        process.exit(1);
    }
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
