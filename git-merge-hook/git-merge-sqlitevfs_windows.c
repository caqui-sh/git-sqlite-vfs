#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <string.h>
#include <sqlite3.h>

#ifndef WEXITSTATUS
#define WEXITSTATUS(x) (x)
#endif

extern int sqlite3_gitvfs_init_impl(void*);

int conflict_handler(void *pCtx, int eConflict, sqlite3_changeset_iter *pIter) {
    (void)pCtx; (void)pIter;
    // We favor the local changes (Branch A) upon conflict.
    return SQLITE_CHANGESET_OMIT; 
}

int main(int argc, char *argv[]) {
    char cmd_merge_recursive[4096] = "git merge-recursive";
    
    char base_commit[256] = "";
    char local_commit[256] = "";
    char remote_commit[256] = "";
    
    int is_dash_dash = 0;
    int local_idx = -1;
    int remote_idx = -1;

    for (int i = 1; i < argc; i++) {
        strcat(cmd_merge_recursive, " ");
        strcat(cmd_merge_recursive, argv[i]);
        
        if (strcmp(argv[i], "--") == 0) {
            is_dash_dash = 1;
            continue;
        }
        
        if (!is_dash_dash) {
            if (strlen(base_commit) == 0) {
                strncpy(base_commit, argv[i], sizeof(base_commit) - 1);
            }
        } else {
            if (local_idx == -1) {
                local_idx = i;
                strncpy(local_commit, argv[i], sizeof(local_commit) - 1);
            } else if (remote_idx == -1) {
                remote_idx = i;
                strncpy(remote_commit, argv[i], sizeof(remote_commit) - 1);
            }
        }
    }

    if (strlen(base_commit) == 0 || strlen(local_commit) == 0 || strlen(remote_commit) == 0) {
        fprintf(stderr, "Invalid arguments to git-merge-sqlitevfs strategy.\n");
        return 1;
    }

    // 1. Delegate tree-level merging to git merge-recursive
    int merge_status = system(cmd_merge_recursive);
    int exit_code = WEXITSTATUS(merge_status);

    // 2. Find all GitVFS databases dynamically via git ls-files
    system("git ls-files | findstr \"/pages/size.meta\" > \\tmp\\gitvfs_dbs.txt");

    FILE *f = fopen("\\tmp\\gitvfs_dbs.txt", "r");
    if (!f) return exit_code;

    char line[1024];
    while (fgets(line, sizeof(line), f)) {
        line[strcspn(line, "\n")] = 0;
        char *pages_ptr = strstr(line, "/pages/size.meta");
        if (!pages_ptr) continue;
        
        *pages_ptr = '\0';
        const char *base_dir = line;

        printf("SQLite VFS Strategy Reconciling: %s\n", base_dir);

        // Prepare isolated environments
        system("rmdir /s /q \\tmp\\gitvfs_base_db \\tmp\\gitvfs_local_db \\tmp\\gitvfs_remote_db 2>nul");
        system("mkdir \\tmp\\gitvfs_base_db \\tmp\\gitvfs_local_db \\tmp\\gitvfs_remote_db 2>nul");

        char cmd_extract[1024];
        snprintf(cmd_extract, sizeof(cmd_extract), "git archive %s \"%s/pages/\" | tar -x -C \\tmp\\gitvfs_base_db 2>nul", base_commit, base_dir);
        system(cmd_extract);
        snprintf(cmd_extract, sizeof(cmd_extract), "git archive %s \"%s/pages/\" | tar -x -C \\tmp\\gitvfs_local_db 2>nul", local_commit, base_dir);
        system(cmd_extract);
        snprintf(cmd_extract, sizeof(cmd_extract), "git archive %s \"%s/pages/\" | tar -x -C \\tmp\\gitvfs_remote_db 2>nul", remote_commit, base_dir);
        system(cmd_extract);

        // Setup VFS configuration to handle the isolated directories
        _putenv("GIT_SQLITE_VFS_DIR=gitvfs_");
        
        sqlite3 *db_local;
        char local_db_path[1024];
        snprintf(local_db_path, sizeof(local_db_path), "\\tmp\\gitvfs_local_db\\%s", base_dir);

        sqlite3_gitvfs_init_impl(NULL);

        if (sqlite3_open_v2(local_db_path, &db_local, SQLITE_OPEN_READWRITE, "gitvfs") != SQLITE_OK) {
            fprintf(stderr, "Failed to open local DB: %s\n", sqlite3_errmsg(db_local));
            continue;
        }

        char attach_base[1024];
        snprintf(attach_base, sizeof(attach_base), "ATTACH DATABASE '\\tmp\\gitvfs_base_db\\%s' AS ancestor;", base_dir);
        sqlite3_exec(db_local, attach_base, NULL, 0, NULL);

        char attach_remote[1024];
        snprintf(attach_remote, sizeof(attach_remote), "ATTACH DATABASE '\\tmp\\gitvfs_remote_db\\%s' AS other;", base_dir);
        sqlite3_exec(db_local, attach_remote, NULL, 0, NULL);

        // Schema Reconciliation: Phase 1 (Drops)
        sqlite3_exec(db_local, "CREATE TEMP TABLE drops AS SELECT type, name FROM main.sqlite_schema WHERE name IN (SELECT name FROM ancestor.sqlite_schema EXCEPT SELECT name FROM other.sqlite_schema) AND name NOT LIKE 'sqlite_%';", NULL, 0, NULL);
        
        sqlite3_stmt *stmt;
        if (sqlite3_prepare_v2(db_local, "SELECT type, name FROM drops;", -1, &stmt, NULL) == SQLITE_OK) {
            while (sqlite3_step(stmt) == SQLITE_ROW) {
                const char *type = (const char *)sqlite3_column_text(stmt, 0);
                const char *name = (const char *)sqlite3_column_text(stmt, 1);
                char drop_sql[512];
                snprintf(drop_sql, sizeof(drop_sql), "DROP %s IF EXISTS \"%s\";", type, name);
                sqlite3_exec(db_local, drop_sql, NULL, 0, NULL);
            }
            sqlite3_finalize(stmt);
        }
        sqlite3_exec(db_local, "DROP TABLE drops;", NULL, 0, NULL);

        // Schema Reconciliation: Phase 2 (Adds)
        sqlite3_exec(db_local, "CREATE TEMP TABLE adds AS SELECT sql FROM other.sqlite_schema WHERE sql IS NOT NULL AND name IN (SELECT name FROM other.sqlite_schema EXCEPT SELECT name FROM ancestor.sqlite_schema) AND name NOT IN (SELECT name FROM main.sqlite_schema) ORDER BY CASE WHEN type='table' THEN 1 ELSE 2 END;", NULL, 0, NULL);
        
        if (sqlite3_prepare_v2(db_local, "SELECT sql FROM adds;", -1, &stmt, NULL) == SQLITE_OK) {
            while (sqlite3_step(stmt) == SQLITE_ROW) {
                const char *sql = (const char *)sqlite3_column_text(stmt, 0);
                sqlite3_exec(db_local, sql, NULL, 0, NULL);
            }
            sqlite3_finalize(stmt);
        }
        sqlite3_exec(db_local, "DROP TABLE adds;", NULL, 0, NULL);

        // Data Reconciliation using SQLite Session
        if (sqlite3_prepare_v2(db_local, "SELECT name FROM main.sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%';", -1, &stmt, NULL) == SQLITE_OK) {
            while (sqlite3_step(stmt) == SQLITE_ROW) {
                const char *table_name = (const char *)sqlite3_column_text(stmt, 0);
                
                sqlite3_session *pSession;
                if (sqlite3session_create(db_local, "other", &pSession) == SQLITE_OK) {
                    if (sqlite3session_attach(pSession, table_name) == SQLITE_OK) {
                        char *zErrMsg = NULL;
                        if (sqlite3session_diff(pSession, "ancestor", table_name, &zErrMsg) == SQLITE_OK) {
                            int nChangeset = 0;
                            void *pChangeset = NULL;
                            sqlite3session_changeset(pSession, &nChangeset, &pChangeset);
                            if (nChangeset > 0) {
                                sqlite3changeset_apply(db_local, nChangeset, pChangeset, NULL, conflict_handler, NULL);
                            }
                            sqlite3_free(pChangeset);
                        } else {
                            sqlite3_free(zErrMsg);
                        }
                    }
                    sqlite3session_delete(pSession);
                }
            }
            sqlite3_finalize(stmt);
        }

        sqlite3_close(db_local);

        // Copy Reconciled Database back into Working Tree
        char cmd_cp[1024];
        snprintf(cmd_cp, sizeof(cmd_cp), "rmdir /s /q \"%s\\pages\" 2>nul & xcopy /e /i /h /y \"\\tmp\\gitvfs_local_db\\%s\\pages\" \"%s\\pages\"", base_dir, base_dir, base_dir);
        system(cmd_cp);

        // Stage the resolved directory into the Git index
        char cmd_add[1024];
        snprintf(cmd_add, sizeof(cmd_add), "git add -A -f \"%s/pages/\"", base_dir);
        system(cmd_add);
    }
    fclose(f);

    if (exit_code != 0) {
        int unmerged = system("git ls-files -u | grep -q .");
        if (WEXITSTATUS(unmerged) != 0) {
            // grep found nothing, meaning NO unmerged files are left!
            exit_code = 0;
            printf("SQLite VFS Strategy successfully resolved all conflicts.\n");
        } else {
            printf("SQLite VFS Strategy finished, but other file conflicts remain.\n");
        }
    }

    return exit_code;
}
