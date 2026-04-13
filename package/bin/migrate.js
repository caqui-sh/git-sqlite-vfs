import path from 'node:path';
import { bootstrapGitVFS, createVFSClient } from '../index.js';

export async function migrateDatabase(sourceLegacyDb, targetVfsDir) {
    console.log(`Migrating legacy DB: ${sourceLegacyDb}`);
    console.log(`Target VFS Directory: ${targetVfsDir}`);

    const sourcePath = path.resolve(sourceLegacyDb);
    const targetPath = path.resolve(targetVfsDir);
    
    const { createClient } = await import('@libsql/client');
    const sourceClient = createClient({ url: `file:${sourcePath}` });

    await bootstrapGitVFS({ dir: targetVfsDir });
    const targetClient = await createVFSClient({ url: `file:${path.join(targetPath, 'local.db')}` });

    await targetClient.execute('PRAGMA foreign_keys = OFF;');

    console.log('Reading and creating TABLE schemas...');
    const tableRes = await sourceClient.execute(`SELECT sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL AND name != 'sqlite_sequence';`);
    for (const row of tableRes.rows) {
        await targetClient.execute(row.sql);
    }

    const tablesRes = await sourceClient.execute(`SELECT name, sql FROM sqlite_master WHERE type='table' AND name != 'sqlite_sequence';`);
    
    for (const tableRow of tablesRes.rows) {
        const tableName = tableRow.name;
        const tableSql = tableRow.sql.toUpperCase();
        const withoutRowId = tableSql.includes('WITHOUT ROWID');
        const batchSize = 1000;
        
        let lastRowId = -1;
        let offset = 0;
        let hasMore = true;
        let batchNum = 1;

        while (hasMore) {
            console.log(`Migrating table: ${tableName} (batch ${batchNum})...`);
            let rowsRes;
            
            if (withoutRowId) {
                rowsRes = await sourceClient.execute(`SELECT * FROM "${tableName}" LIMIT ${batchSize} OFFSET ${offset}`);
            } else {
                rowsRes = await sourceClient.execute({
                    sql: `SELECT rowid, * FROM "${tableName}" WHERE rowid > ? ORDER BY rowid ASC LIMIT ${batchSize}`,
                    args: [lastRowId]
                });
            }
            
            if (rowsRes.rows.length === 0) {
                hasMore = false;
                break;
            }

            await targetClient.execute('BEGIN TRANSACTION');
            for (const row of rowsRes.rows) {
                let rowData = row;
                if (!withoutRowId) {
                    lastRowId = row.rowid;
                    const { rowid, ...rest } = row;
                    rowData = rest;
                }
                
                const columns = Object.keys(rowData).filter(k => isNaN(Number(k)));
                const values = columns.map(k => rowData[k]);
                
                const placeholders = columns.map(() => '?').join(', ');
                const query = `INSERT INTO "${tableName}" (${columns.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders})`;
                
                await targetClient.execute({
                    sql: query,
                    args: values
                });
            }
            await targetClient.execute('COMMIT');

            if (withoutRowId) {
                offset += batchSize;
            }
            batchNum++;
        }
    }

    // Migrate internal auto-increment sequences if they exist
    const seqCheck = await sourceClient.execute(`SELECT name FROM sqlite_master WHERE type='table' AND name='sqlite_sequence';`);
    if (seqCheck.rows.length > 0) {
        console.log('Migrating sqlite_sequence...');
        const seqRows = await sourceClient.execute(`SELECT * FROM sqlite_sequence`);
        if (seqRows.rows.length > 0) {
            await targetClient.execute('BEGIN TRANSACTION');
            for (const row of seqRows.rows) {
                await targetClient.execute({
                    sql: `INSERT OR REPLACE INTO sqlite_sequence (name, seq) VALUES (?, ?)`,
                    args: [row.name, row.seq]
                });
            }
            await targetClient.execute('COMMIT');
        }
    }

    console.log('Migrating INDEX schemas...');
    const indexRes = await sourceClient.execute(`SELECT sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL;`);
    for (const row of indexRes.rows) {
        await targetClient.execute(row.sql);
    }

    console.log('Migrating VIEW and TRIGGER schemas...');
    const viewTriggerRes = await sourceClient.execute(`SELECT sql FROM sqlite_master WHERE type IN ('view', 'trigger') AND sql IS NOT NULL;`);
    for (const row of viewTriggerRes.rows) {
        await targetClient.execute(row.sql);
    }

    console.log('Vacuuming target DB for out-of-bounds shard chunking...');
    await targetClient.execute('VACUUM;');
    await targetClient.execute('PRAGMA foreign_keys = ON;');

    console.log('Migration complete!');
}
