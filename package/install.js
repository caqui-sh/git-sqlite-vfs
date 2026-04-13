import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { downloadOrBuild } from './downloader.js';

const _dirname = typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));

async function run() {
    const targetDir = path.join(_dirname, 'c', 'output');
    await downloadOrBuild(targetDir);
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
