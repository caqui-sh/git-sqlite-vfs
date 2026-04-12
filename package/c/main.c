#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sqlite3.h>
#include "gitvfs.h"

// Callback to print SELECT results
static int select_callback(void *NotUsed, int argc, char **argv, char **azColName) {
    (void)NotUsed;
    for (int i = 0; i < argc; i++) {
        printf("%s = %s  ", azColName[i], argv[i] ? argv[i] : "NULL");
    }
    printf("\n");
    return 0;
}

int main(int argc, char *argv[]) {
    sqlite3 *db;
    char *err_msg = 0;
    int rc;

    if (argc < 2) {
        fprintf(stderr, "Usage: %s [init | <sql_statement>]\n", argv[0]);
        return 1;
    }

    // 1. Initialize our custom Git VFS
    // We pass ".db" as our base directory. This will map to .db/pages/...
    rc = sqlite3_gitvfs_init_impl(".db");
    if (rc != SQLITE_OK) {
        fprintf(stderr, "Failed to initialize gitvfs: %d\n", rc);
        return 1;
    }

    // 2. Open the database using our custom VFS
    // Note the "gitvfs" parameter at the end
    rc = sqlite3_open_v2(".db", &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, "gitvfs");
    if (rc != SQLITE_OK) {
        fprintf(stderr, "Cannot open database: %s\n", sqlite3_errmsg(db));
        sqlite3_close(db);
        return 1;
    }

    // 3. Set page size to 4096 to match our VFS assumptions
    rc = sqlite3_exec(db, "PRAGMA page_size = 4096;", 0, 0, &err_msg);
    if (rc != SQLITE_OK) {
        fprintf(stderr, "PRAGMA error: %s\n", err_msg);
        sqlite3_free(err_msg);
    }

    if (strcmp(argv[1], "init") == 0) {
        // 4. Create test tables
        const char *sql_create = "CREATE TABLE IF NOT EXISTS test_data (id INTEGER PRIMARY KEY, name TEXT, value BLOB);";
        rc = sqlite3_exec(db, sql_create, 0, 0, &err_msg);
        if (rc != SQLITE_OK) {
            fprintf(stderr, "SQL error (CREATE test_data): %s\n", err_msg);
            sqlite3_free(err_msg);
        } else {
            printf("Table 'test_data' ensured.\n");
        }
        
        const char *sql_create_settings = "CREATE TABLE IF NOT EXISTS test_settings (config_key TEXT PRIMARY KEY, config_val TEXT);";
        rc = sqlite3_exec(db, sql_create_settings, 0, 0, &err_msg);
        if (rc != SQLITE_OK) {
            fprintf(stderr, "SQL error (CREATE test_settings): %s\n", err_msg);
            sqlite3_free(err_msg);
        } else {
            printf("Table 'test_settings' ensured.\n");
        }

        // 5. Insert test data
        sqlite3_exec(db, "BEGIN TRANSACTION;", 0, 0, &err_msg);
        const char *sql_insert = "INSERT INTO test_data (name, value) VALUES ('Hello GitVFS', randomblob(100));";
        
        // Let's insert a few rows to force some data across pages eventually
        for (int i = 0; i < 10000; i++) {
            rc = sqlite3_exec(db, sql_insert, 0, 0, &err_msg);
            if (rc != SQLITE_OK) {
                fprintf(stderr, "SQL error (INSERT test_data): %s\n", err_msg);
                sqlite3_free(err_msg);
                break;
            }
        }
        sqlite3_exec(db, "COMMIT;", 0, 0, &err_msg);
        printf("Inserted 10000 rows of test_data.\n");
        
        const char *sql_insert_settings = "INSERT INTO test_settings (config_key, config_val) VALUES ('theme', 'dark');";
        rc = sqlite3_exec(db, sql_insert_settings, 0, 0, &err_msg);
        if (rc != SQLITE_OK) {
            fprintf(stderr, "SQL error (INSERT test_settings): %s\n", err_msg);
            sqlite3_free(err_msg);
        } else {
            printf("Inserted baseline row into test_settings.\n");
        }
    } else {
        // Execute the provided SQL
        // Include the select_callback to print output for queries
        rc = sqlite3_exec(db, argv[1], select_callback, 0, &err_msg);
        if (rc != SQLITE_OK) {
            fprintf(stderr, "SQL error: %s\n", err_msg);
            sqlite3_free(err_msg);
        } else {
            printf("Executed SQL: %s\n", argv[1]);
        }
    }

    // 6. Close the connection
    sqlite3_close(db);

    return 0;
}
