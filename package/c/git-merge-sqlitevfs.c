#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <string.h>
#include <sqlite3.h>
#include "gitvfs.h"

int main(int argc, char *argv[]) {
    // A Git Driver receives: %O %A %B %P
    if (argc < 5) {
        fprintf(stderr, "Usage: %s %%O %%A %%B %%P\n", argv[0]);
        return 1;
    }

    const char *path_out = argv[2]; // %A
    const char *path_repo = argv[4]; // %P

    char base_dir[512];
    strncpy(base_dir, path_repo, sizeof(base_dir) - 1);
    base_dir[sizeof(base_dir) - 1] = '\0';
    char *pages_ptr = strstr(base_dir, "/pages/");
    if (!pages_ptr) {
        fprintf(stderr, "Failed to parse base_dir from %s\n", path_repo);
        return 1;
    }
    *pages_ptr = '\0';

    // We only need to run the logical merge once per merge operation.
    // We can use a lock file.
    char lock_file[512];
    snprintf(lock_file, sizeof(lock_file), "/tmp/gitvfs_merge_%s.lock", base_dir);
    for (size_t i=0; i<sizeof(lock_file); i++) {
        if (lock_file[i] == '/') lock_file[i] = '_';
    }
    
    if (access(lock_file, F_OK) != 0) {
        // Create lock
        FILE *lf = fopen(lock_file, "w");
        if (lf) fclose(lf);

        printf("VFS Merge Driver Invoked: Whole-DB Logical Merge Initiated for %s...\n", base_dir);

        system("env > /tmp/gitvfs_env.txt");
        system("ls -la .git > /tmp/gitvfs_ls.txt");
        
        char merge_head_hash[64] = "";
        extern char **environ;
        for (char **env = environ; *env != 0; env++) {
            if (strncmp(*env, "GITHEAD_", 8) == 0) {
                strncpy(merge_head_hash, *env + 8, 40);
                merge_head_hash[40] = '\0';
                break;
            }
        }
        
        if (strlen(merge_head_hash) == 0) {
            fprintf(stderr, "Could not find GITHEAD_ environment variable to determine other commit.\n");
            return 1;
        }

        char cmd_other[1024];
        snprintf(cmd_other, sizeof(cmd_other), "git archive %s \"%s/pages/\" | tar -x -C /tmp/gitvfs_other_db", merge_head_hash, base_dir);
        if (system(cmd_other) != 0) {
            fprintf(stderr, "Failed to extract other database. Command: %s\n", cmd_other);
        }

        system("rm -rf /tmp/gitvfs_ancestor_db && mkdir -p /tmp/gitvfs_ancestor_db");
        char cmd_ancestor[1024];
        snprintf(cmd_ancestor, sizeof(cmd_ancestor), "git archive $(git merge-base HEAD %s) \"%s/pages/\" | tar -x -C /tmp/gitvfs_ancestor_db", merge_head_hash, base_dir);
        if (system(cmd_ancestor) != 0) {
            fprintf(stderr, "Failed to extract ancestor database. Command: %s\n", cmd_ancestor);
        }

        // The Logical Merge via ATTACH
        sqlite3 *db_local;
        sqlite3_gitvfs_init_impl(NULL);
        
        // Ensure VFS env var is set for gitvfs_Open
#ifdef _WIN32
        char env_str[1024];
        snprintf(env_str, sizeof(env_str), "GIT_SQLITE_VFS_DIR=%s", base_dir);
        _putenv(env_str);
#else
        setenv("GIT_SQLITE_VFS_DIR", base_dir, 1);
#endif
        
        if (sqlite3_open_v2(base_dir, &db_local, SQLITE_OPEN_READWRITE, "gitvfs") != SQLITE_OK) {
            fprintf(stderr, "Failed to open local DB: %s\n", sqlite3_errmsg(db_local));
        }

        char attach_other[1024];
        snprintf(attach_other, sizeof(attach_other), "ATTACH DATABASE '/tmp/gitvfs_other_db/%s' AS other;", base_dir);
        sqlite3_exec(db_local, attach_other, NULL, 0, NULL);

        char attach_ancestor[1024];
        snprintf(attach_ancestor, sizeof(attach_ancestor), "ATTACH DATABASE '/tmp/gitvfs_ancestor_db/%s' AS ancestor;", base_dir);
        sqlite3_exec(db_local, attach_ancestor, NULL, 0, NULL);

        // Phase 1 (Propagate Drops)
        sqlite3_exec(db_local, "CREATE TEMP TABLE drops AS SELECT type, name FROM main.sqlite_schema WHERE name IN (SELECT name FROM ancestor.sqlite_schema EXCEPT SELECT name FROM other.sqlite_schema) AND name NOT LIKE 'sqlite_%';", NULL, 0, NULL);
        
        sqlite3_stmt *drop_stmt;
        char *drops_to_execute = calloc(1, 1024 * 1024); // 1MB buffer
        if (sqlite3_prepare_v2(db_local, "SELECT type, name FROM drops;", -1, &drop_stmt, NULL) == SQLITE_OK) {
            while (sqlite3_step(drop_stmt) == SQLITE_ROW) {
                const char *type = (const char *)sqlite3_column_text(drop_stmt, 0);
                const char *name = (const char *)sqlite3_column_text(drop_stmt, 1);
                if (type && name) {
                    char drop_sql[512];
                    snprintf(drop_sql, sizeof(drop_sql), "DROP %s IF EXISTS \"%s\";\n", type, name);
                    strcat(drops_to_execute, drop_sql);
                }
            }
            sqlite3_finalize(drop_stmt);
        }
        if (strlen(drops_to_execute) > 0) {
            sqlite3_exec(db_local, drops_to_execute, NULL, 0, NULL);
        }
        free(drops_to_execute);
        sqlite3_exec(db_local, "DROP TABLE drops;", NULL, 0, NULL);

        // Phase 2 (Propagate Additions)
        sqlite3_exec(db_local, "CREATE TEMP TABLE adds AS SELECT sql FROM other.sqlite_schema WHERE sql IS NOT NULL AND name IN (SELECT name FROM other.sqlite_schema EXCEPT SELECT name FROM ancestor.sqlite_schema) AND name NOT IN (SELECT name FROM main.sqlite_schema) ORDER BY CASE WHEN type='table' THEN 1 ELSE 2 END;", NULL, 0, NULL);
        
        sqlite3_stmt *add_stmt;
        char *adds_to_execute = calloc(1, 1024 * 1024); // 1MB buffer
        if (sqlite3_prepare_v2(db_local, "SELECT sql FROM adds;", -1, &add_stmt, NULL) == SQLITE_OK) {
            while (sqlite3_step(add_stmt) == SQLITE_ROW) {
                const char *sql = (const char *)sqlite3_column_text(add_stmt, 0);
                if (sql) {
                    strcat(adds_to_execute, sql);
                    strcat(adds_to_execute, ";\n");
                }
            }
            sqlite3_finalize(add_stmt);
        }
        if (strlen(adds_to_execute) > 0) {
            sqlite3_exec(db_local, adds_to_execute, NULL, 0, NULL);
        }
        free(adds_to_execute);
        sqlite3_exec(db_local, "DROP TABLE adds;", NULL, 0, NULL);

        // Dynamically discover and merge tables
        sqlite3_stmt *stmt;
        const char *query_schema = "SELECT name FROM main.sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%';";
        
        if (sqlite3_prepare_v2(db_local, query_schema, -1, &stmt, NULL) == SQLITE_OK) {
            while (sqlite3_step(stmt) == SQLITE_ROW) {
                const char *table_name = (const char *)sqlite3_column_text(stmt, 0);
                if (table_name) {
                    char pragma_query[512];
                    snprintf(pragma_query, sizeof(pragma_query), "PRAGMA main.table_info(\"%s\");", table_name);
                    sqlite3_stmt *pragma_stmt;
                    char pk_col[256] = {0};
                    int has_pk = 0;

                    if (sqlite3_prepare_v2(db_local, pragma_query, -1, &pragma_stmt, NULL) == SQLITE_OK) {
                        while (sqlite3_step(pragma_stmt) == SQLITE_ROW) {
                            int pk = sqlite3_column_int(pragma_stmt, 5); 
                            if (pk > 0) {
                                const char *col_name = (const char *)sqlite3_column_text(pragma_stmt, 1);
                                if (col_name) {
                                    strncpy(pk_col, col_name, sizeof(pk_col) - 1);
                                    has_pk = 1;
                                    break; 
                                }
                            }
                        }
                        sqlite3_finalize(pragma_stmt);
                    }

                    if (has_pk) {
                        int exists_in_ancestor = 0;
                        char check_anc[256];
                        snprintf(check_anc, sizeof(check_anc), "SELECT 1 FROM ancestor.sqlite_schema WHERE type='table' AND name='%s';", table_name);
                        sqlite3_stmt *anc_stmt;
                        if (sqlite3_prepare_v2(db_local, check_anc, -1, &anc_stmt, NULL) == SQLITE_OK) {
                            if (sqlite3_step(anc_stmt) == SQLITE_ROW) exists_in_ancestor = 1;
                            sqlite3_finalize(anc_stmt);
                        }

                        if (exists_in_ancestor) {
                            char drop_conflict[256];
                            snprintf(drop_conflict, sizeof(drop_conflict), "DROP TABLE IF EXISTS temp.\"conflicted_pks_%s\";", table_name);
                            sqlite3_exec(db_local, drop_conflict, NULL, 0, NULL);
                            
                            char conflict_query[1024];
                            snprintf(conflict_query, sizeof(conflict_query), 
                                "CREATE TEMP TABLE \"conflicted_pks_%s\" AS "
                                "SELECT \"%s\" FROM (SELECT * FROM main.\"%s\" EXCEPT SELECT * FROM ancestor.\"%s\") "
                                "INTERSECT "
                                "SELECT \"%s\" FROM (SELECT * FROM other.\"%s\" EXCEPT SELECT * FROM ancestor.\"%s\");",
                                table_name,
                                pk_col, table_name, table_name,
                                pk_col, table_name, table_name);
                            
                            sqlite3_exec(db_local, conflict_query, NULL, 0, NULL);

                            char q1[1024];
                            char q2[1024];

                            // Query 1: Propagate Deletions from MERGE_HEAD
                            snprintf(q1, sizeof(q1), 
                                "DELETE FROM main.\"%s\" WHERE \"%s\" IN (SELECT \"%s\" FROM ancestor.\"%s\" EXCEPT SELECT \"%s\" FROM other.\"%s\");", 
                                table_name, pk_col, pk_col, table_name, pk_col, table_name);
                            sqlite3_exec(db_local, q1, NULL, 0, NULL);

                            // Query 2: Propagate Inserts & Updates from MERGE_HEAD, omitting row conflicts
                            snprintf(q2, sizeof(q2), 
                                "REPLACE INTO main.\"%s\" SELECT * FROM other.\"%s\" WHERE \"%s\" IN (SELECT \"%s\" FROM (SELECT * FROM other.\"%s\" EXCEPT SELECT * FROM ancestor.\"%s\")) "
                                "AND \"%s\" NOT IN (SELECT \"%s\" FROM \"conflicted_pks_%s\");", 
                                table_name, table_name, pk_col, pk_col, table_name, table_name, pk_col, pk_col, table_name);
                            sqlite3_exec(db_local, q2, NULL, 0, NULL);
                            
                            sqlite3_exec(db_local, drop_conflict, NULL, 0, NULL);
                        } else {
                            char merge_query[512];
                            snprintf(merge_query, sizeof(merge_query), "INSERT OR IGNORE INTO main.\"%s\" SELECT * FROM other.\"%s\";", table_name, table_name);
                            sqlite3_exec(db_local, merge_query, NULL, 0, NULL);
                        }
                    } else {
                        char merge_query[512];
                        snprintf(merge_query, sizeof(merge_query), "INSERT OR IGNORE INTO main.\"%s\" SELECT * FROM other.\"%s\";", table_name, table_name);
                        sqlite3_exec(db_local, merge_query, NULL, 0, NULL);
                    }
                }
            }
            sqlite3_finalize(stmt);
        }

        sqlite3_close(db_local);
        
        char git_add_cmd[1024];
        snprintf(git_add_cmd, sizeof(git_add_cmd), "git add -A -f \"%s/pages/\"", base_dir);
        if (system(git_add_cmd) != 0) {}
        
        printf("Logical Merge Complete! VFS physical pages reconciled.\n");
    }

    // Now, copy the resulting file from the working tree to path_out (%A) so Git considers this file resolved!
    // If the file doesn't exist anymore (deleted), we can just create an empty file or remove it.
    char cp_cmd[1024];
    if (access(path_repo, F_OK) == 0) {
        snprintf(cp_cmd, sizeof(cp_cmd), "cp \"%s\" \"%s\"", path_repo, path_out);
        if (system(cp_cmd) != 0) {
            fprintf(stderr, "Failed to copy %s to %s\n", path_repo, path_out);
        }
    } else {
        snprintf(cp_cmd, sizeof(cp_cmd), "rm -f \"%s\"", path_out);
        if (system(cp_cmd) != 0) {}
    }

    return 0;
}
