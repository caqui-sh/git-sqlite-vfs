const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

if (!fs.existsSync('sqlite3.c') || !fs.existsSync('sqlite3.h') || !fs.existsSync('sqlite3ext.h')) {
    console.log('Downloading SQLite source...');
    try {
        execSync('curl -L -O https://www.sqlite.org/2024/sqlite-autoconf-3450200.tar.gz', { stdio: 'inherit' });
        execSync('tar -xzf sqlite-autoconf-3450200.tar.gz', { stdio: 'inherit' });
        fs.copyFileSync('sqlite-autoconf-3450200/sqlite3.c', 'sqlite3.c');
        fs.copyFileSync('sqlite-autoconf-3450200/sqlite3.h', 'sqlite3.h');
        fs.copyFileSync('sqlite-autoconf-3450200/sqlite3ext.h', 'sqlite3ext.h');
    } catch (e) {
        console.error('Failed to download or extract SQLite:', e.message);
        process.exit(1);
    }
}
