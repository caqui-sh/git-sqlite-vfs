import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function buildFromSource() {
    console.log('Building from source...');
    try {
        execSync('npm run build', { stdio: 'inherit', cwd: __dirname });
        console.log('Successfully built from source.');
    } catch (e) {
        console.error('Failed to build from source.', e.message);
        process.exit(1);
    }
}

buildFromSource();
