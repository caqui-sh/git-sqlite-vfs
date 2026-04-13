import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

async function run() {
    const targetDir = path.join(_dirname, 'c', 'output');
    await downloadOrBuild(targetDir);
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
