import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { downloadOrBuild } from './downloader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function run() {
    const targetDir = path.join(__dirname, 'c', 'output');
    await downloadOrBuild(targetDir);
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
