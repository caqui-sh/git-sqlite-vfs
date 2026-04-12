#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <string.h>
#include <sqlite3.h>
#include "gitvfs.h"

int main(int argc, char *argv[]) {
    // A Git Strategy receives: <base> -- <head> <remote>
    if (argc < 5) {
        fprintf(stderr, "Usage: %s <base> -- <head> <remote>\n", argv[0]);
        return 1;
    }

    const char *base = argv[1];
    const char *other = argv[4];

    printf("VFS Merge Driver Invoked: Whole-DB Logical Merge Initiated...\n");

    // 2. Extract MERGE_HEAD and Ancestor without triggering index-lock failures
    system("rm -rf /tmp/gitvfs_other_db && mkdir -p /tmp/gitvfs_other_db");
    
    char cmd_other[512];
    snprintf(cmd_other, sizeof(cmd_other), "git archive %s .db/pages/ | tar -x -C /tmp/gitvfs_other_db", other);
    int ret_other = system(cmd_other);
    if (ret_other != 0) {
        fprintf(stderr, "Failed to extract other database. Command: %s\n", cmd_other);
    }

    system("rm -rf /tmp/gitvfs_ancestor_db && mkdir -p /tmp/gitvfs_ancestor_db");
    char cmd_ancestor[512];
    snprintf(cmd_ancestor, sizeof(cmd_ancestor), "git archive %s .db/pages/ | tar -x -C /tmp/gitvfs_ancestor_db", base);
    int ret_ancestor = system(cmd_ancestor);
    if (ret_ancestor != 0) {
        fprintf(stderr, "Failed to extract ancestor database. Command: %s\n", cmd_ancestor);
    }

    // 3. The Logical Merge via ATTACH
    sqlite3 *db_local;

    sqlite3_gitvfs_init_impl(NULL);
    sqlite3_open_v2(".db", &db_local, SQLITE_OPEN_READWRITE, "gitvfs");

    sqlite3_exec(db_local, "ATTACH DATABASE '/tmp/gitvfs_other_db/.db' AS other;", NULL, 0, NULL);
    sqlite3_exec(db_local, "ATTACH DATABASE '/tmp/gitvfs_ancestor_db/.db' AS ancestor;", NULL, 0, NULL);

    // 3-Way DDL Merge
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
        printf("Propagating Drops:\n%s", drops_to_execute);
        char *err_msg = NULL;
        if (sqlite3_exec(db_local, drops_to_execute, NULL, 0, &err_msg) != SQLITE_OK) {
            fprintf(stderr, "Error executing drop: %s\n", err_msg);
            sqlite3_free(err_msg);
        }
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
        printf("Propagating Additions:\n%s", adds_to_execute);
        char *err_msg = NULL;
        if (sqlite3_exec(db_local, adds_to_execute, NULL, 0, &err_msg) != SQLITE_OK) {
            fprintf(stderr, "Error executing addition: %s\n", err_msg);
            sqlite3_free(err_msg);
        }
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
                printf("Merging table: %s\n", table_name);

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
                } else {
                    fprintf(stderr, "Failed to prepare PRAGMA query for table %s: %s\n", table_name, sqlite3_errmsg(db_local));
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
                        
                        char *err_msg = NULL;
                        if (sqlite3_exec(db_local, conflict_query, NULL, 0, &err_msg) != SQLITE_OK) {
                            fprintf(stderr, "Error executing conflict query: %s\n", err_msg);
                            sqlite3_free(err_msg);
                        }

                        // Identify Row-Level Clashes
                        sqlite3_stmt *conflict_stmt;
                        char select_conflict[256];
                        snprintf(select_conflict, sizeof(select_conflict), "SELECT * FROM \"conflicted_pks_%s\";", table_name);
                        if (sqlite3_prepare_v2(db_local, select_conflict, -1, &conflict_stmt, NULL) == SQLITE_OK) {
                            while (sqlite3_step(conflict_stmt) == SQLITE_ROW) {
                                const char *conflicted_pk_val = (const char *)sqlite3_column_text(conflict_stmt, 0);
                                printf("WARNING: True Row Conflict detected on table '%s', PK '%s'. Preserving HEAD state.\n", table_name, conflicted_pk_val ? conflicted_pk_val : "NULL");
                            }
                            sqlite3_finalize(conflict_stmt);
                        }

                        char q1[1024];
                        char q2[1024];

                        // Query 1: Propagate Deletions from MERGE_HEAD
                        snprintf(q1, sizeof(q1), 
                            "DELETE FROM main.\"%s\" WHERE \"%s\" IN (SELECT \"%s\" FROM ancestor.\"%s\" EXCEPT SELECT \"%s\" FROM other.\"%s\");", 
                            table_name, pk_col, pk_col, table_name, pk_col, table_name);
                        if (sqlite3_exec(db_local, q1, NULL, 0, &err_msg) != SQLITE_OK) {
                            fprintf(stderr, "Error executing deletion merge query: %s\n", err_msg);
                            sqlite3_free(err_msg);
                        }

                        // Query 2: Propagate Inserts & Updates from MERGE_HEAD, omitting row conflicts
                        snprintf(q2, sizeof(q2), 
                            "REPLACE INTO main.\"%s\" SELECT * FROM other.\"%s\" WHERE \"%s\" IN (SELECT \"%s\" FROM (SELECT * FROM other.\"%s\" EXCEPT SELECT * FROM ancestor.\"%s\")) "
                            "AND \"%s\" NOT IN (SELECT \"%s\" FROM \"conflicted_pks_%s\");", 
                            table_name, table_name, pk_col, pk_col, table_name, table_name, pk_col, pk_col, table_name);
                        if (sqlite3_exec(db_local, q2, NULL, 0, &err_msg) != SQLITE_OK) {
                            fprintf(stderr, "Error executing insert/update merge query: %s\n", err_msg);
                            sqlite3_free(err_msg);
                        }
                        
                        sqlite3_exec(db_local, drop_conflict, NULL, 0, NULL);
                    } else {
                        // Fallback to naive 2-way append (table is new)
                        char merge_query[512];
                        snprintf(merge_query, sizeof(merge_query), 
                                 "INSERT OR IGNORE INTO main.\"%s\" SELECT * FROM other.\"%s\";", 
                                 table_name, table_name);
                        sqlite3_exec(db_local, merge_query, NULL, 0, NULL);
                    }
                } else {
                    char merge_query[512];
                    snprintf(merge_query, sizeof(merge_query), 
                             "INSERT OR IGNORE INTO main.\"%s\" SELECT * FROM other.\"%s\";", 
                             table_name, table_name);
                    sqlite3_exec(db_local, merge_query, NULL, 0, NULL);
                }
            }
        }
        sqlite3_finalize(stmt);
    } else {
        fprintf(stderr, "Failed to prepare schema query: %s\n", sqlite3_errmsg(db_local));
    }

    sqlite3_close(db_local);

    if (system("git add -A -f .db/pages/") != 0) {}
    if (system("rm -rf /tmp/gitvfs_other_db /tmp/gitvfs_ancestor_db") != 0) {}

    printf("Logical Merge Complete! VFS physical pages reconciled.\n");
    return 0;
}
