import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Determine the correct extension based on OS
const platform = os.platform();
let ext = 'so';
if (platform === 'darwin') {
    ext = 'dylib';
} else if (platform === 'win32') {
    ext = 'dll';
}

const extensionPath = path.resolve(__dirname, 'c', 'output', `gitvfs.${ext}`);

export const GITVFS_EXTENSION_PATH = extensionPath;

export async function bootstrapGitVFS() {
    // Dynamically import libsql so that we load the extension into its isolated native memory space.
    let Database;
    if (typeof Deno !== 'undefined') {
        // Deno environment
        const lib = await import('npm:libsql');
        Database = lib.default || lib.Database || lib;
    } else {
        // Node.js environment
        const lib = await import('libsql');
        Database = lib.default || lib.Database || lib;
    }

    const db = new Database(':memory:');
    db.loadExtension(extensionPath);
    db.close();
}
