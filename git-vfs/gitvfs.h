#ifndef GITVFS_H
#define GITVFS_H

#include <sqlite3.h>

/**
 * Initializes and registers the Git VFS with SQLite.
 *
 * @param base_dir Optional. The base directory for the database. 
 *                 Can be passed in context or managed per connection.
 * @return SQLITE_OK on success, or an SQLite error code.
 */
int sqlite3_gitvfs_init_impl(const char *base_dir);

#endif // GITVFS_H