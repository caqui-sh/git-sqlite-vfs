#include "gitvfs.h"
#ifdef COMPILE_SQLITE_EXTENSION
#include <sqlite3ext.h>
SQLITE_EXTENSION_INIT1
#else
#include <sqlite3.h>
#endif
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <fcntl.h>
#ifdef _WIN32
#include <io.h>
#include <windows.h>
#include <process.h>
#define ftruncate _chsize
#define getpid _getpid
#else
#include <unistd.h>
#endif
#include <errno.h>

#define GITVFS_PAGE_SIZE 4096
#define GITVFS_MAX_PATH 512

/* 
 * Custom sqlite3_file subclass to hold our internal state.
 * This structure tracks the file descriptor equivalents and the state
 * of the highest page written for bounds checking.
 */
typedef struct gitvfs_file {
    sqlite3_file base;              /* Base class. Must be first. */
    char base_dir[GITVFS_MAX_PATH]; /* The base directory for this database (e.g., ".db") */
    sqlite3_int64 max_page_number;  /* Highest page number written, used for xFileSize */
    int is_main_db;                 /* 1 if main DB (sharded), 0 if temp/journal (flat) */
    int flat_fd;                    /* POSIX file descriptor for temp/journal files */
} gitvfs_file;

#ifdef _WIN32
#include <direct.h>
#include <io.h>
#define MKDIR(p, m) _mkdir(p)

ssize_t pread(int fd, void *buf, size_t count, off_t offset) {
    off_t current = lseek(fd, 0, SEEK_CUR);
    if (lseek(fd, offset, SEEK_SET) == (off_t)-1) return -1;
    ssize_t ret = read(fd, buf, count);
    lseek(fd, current, SEEK_SET);
    return ret;
}

ssize_t pwrite(int fd, const void *buf, size_t count, off_t offset) {
    off_t current = lseek(fd, 0, SEEK_CUR);
    if (lseek(fd, offset, SEEK_SET) == (off_t)-1) return -1;
    ssize_t ret = write(fd, buf, count);
    lseek(fd, current, SEEK_SET);
    return ret;
}
#else
#define MKDIR(p, m) mkdir(p, m)
#endif
/*
 * Helps ensure our nested sharded directory structure exists before writing.
 */
static int mkdir_p(const char *path, mode_t mode) {
    (void)mode;
    char tmp[GITVFS_MAX_PATH];
    char *p = NULL;
    size_t len;

    snprintf(tmp, sizeof(tmp), "%s", path);
    len = strlen(tmp);
    if (len > 0 && tmp[len - 1] == '/') {
        tmp[len - 1] = 0;
    }

    for (p = tmp + 1; *p; p++) {
        if (*p == '/') {
            *p = 0;
            if (MKDIR(tmp, mode) != 0 && errno != EEXIST) {
                return -1;
            }
            *p = '/';
        }
    }
    if (MKDIR(tmp, mode) != 0 && errno != EEXIST) {
        return -1;
    }
    return 0;
}

/*
 * Utility: Calculate the file path for a specific page number.
 * 
 * Sharding logic:
 * We map a page number to a hex string to create a deterministic path.
 * 1. Convert page number to a zero-padded, uppercase 6-character hex string.
 * 2. Extract the first two characters for the 1st level directory.
 * 3. Extract the next two characters for the 2nd level directory.
 * 
 * Example: Page 1048575 -> Hex "0FFFFF"
 * Path: <base_dir>/pages/0F/FF/0FFFFF.bin
 */
static void get_page_filepath(const char *base_dir, sqlite3_int64 page_number, char *path_buffer, size_t buffer_size) {
    char hex_str[32];
    
    // Format page number as a zero-padded, 6-character hexadecimal string
    snprintf(hex_str, sizeof(hex_str), "%06llX", (unsigned long long)page_number);
    
    // Extract sharding prefixes
    char dir1[3] = { hex_str[0], hex_str[1], '\0' };
    char dir2[3] = { hex_str[2], hex_str[3], '\0' };

    // Construct the full path
    snprintf(path_buffer, buffer_size, "%s/pages/%s/%s/%s.bin", base_dir, dir1, dir2, hex_str);
}

/*
 * Utility: Generate the .gitattributes file in the pages directory.
 * Explicitly declares all .bin files as binary to optimize Git delta-compression
 * and suppress meaningless text-based diff operations.
 */
static void generate_gitattributes(const char *base_dir) {
    char pages_dir[GITVFS_MAX_PATH];
    snprintf(pages_dir, sizeof(pages_dir), "%s/pages", base_dir);
    
    // Ensure the root pages directory exists
    if (mkdir_p(pages_dir, 0755) != 0) return;
    
    char attr_path[GITVFS_MAX_PATH];
    snprintf(attr_path, sizeof(attr_path), "%s/.gitattributes", pages_dir);
    
    // Check if the file already exists to avoid unnecessary disk writes
    if (access(attr_path, F_OK) != -1) {
        return; 
    }
    
    // Create the .gitattributes file
    FILE *f = fopen(attr_path, "w");
    if (f) {
        fprintf(f, "*.bin -text -diff merge=sqlitevfs\nsize.meta -text -diff merge=sqlitevfs\n");
        fclose(f);
    }
}

static void generate_gitignore(const char *base_dir) {
    char attr_path[GITVFS_MAX_PATH];
    snprintf(attr_path, sizeof(attr_path), "%s/.gitignore", base_dir);
    
    if (access(attr_path, F_OK) != -1) {
        return; 
    }
    
    FILE *f = fopen(attr_path, "w");
    if (f) {
        fprintf(f, "*-journal\n*-wal\n*-shm\n");
        fclose(f);
    }
}

/* =====================================================================
 * VFS I/O Methods (sqlite3_io_methods)
 * Part 2 - Core I/O Logic
 * ===================================================================== */

static int gitvfs_Close(sqlite3_file *pFile) {
    gitvfs_file *p = (gitvfs_file*)pFile;
    
    // If it's a temporary or journal file, close the POSIX file descriptor
    if (!p->is_main_db && p->flat_fd >= 0) {
        close(p->flat_fd);
        p->flat_fd = -1;
    }
    return SQLITE_OK;
}

static int gitvfs_Read(sqlite3_file *pFile, void *zBuf, int iAmt, sqlite3_int64 iOfst) {
    gitvfs_file *p = (gitvfs_file*)pFile;
    
    // Route to monolithic file read for temp/journal files
    if (!p->is_main_db) {
        ssize_t n = pread(p->flat_fd, zBuf, iAmt, iOfst);
        if (n == iAmt) {
            return SQLITE_OK;
        } else if (n >= 0) {
            memset((char*)zBuf + n, 0, iAmt - n);
            return SQLITE_IOERR_SHORT_READ;
        }
        return SQLITE_IOERR_READ;
    }

    // Sharded DB read logic
    sqlite3_int64 page_number = iOfst / GITVFS_PAGE_SIZE;
    sqlite3_int64 local_offset = iOfst % GITVFS_PAGE_SIZE;
    
    char path[GITVFS_MAX_PATH];
    get_page_filepath(p->base_dir, page_number, path, sizeof(path));
    
    int fd = open(path, O_RDONLY);
    if (fd < 0) {
        // Unwritten page requested: Zero-fill the buffer entirely
        memset(zBuf, 0, iAmt);
        return SQLITE_IOERR_SHORT_READ;
    }
    
    // Read exact intra-page payload using pread
    ssize_t bytes_read = pread(fd, zBuf, iAmt, local_offset);
    close(fd);
    
    if (bytes_read == iAmt) {
        return SQLITE_OK;
    } else if (bytes_read >= 0) {
        // Short read: file exists but has fewer bytes than requested. Zero-fill the remainder.
        memset((char*)zBuf + bytes_read, 0, iAmt - bytes_read);
        return SQLITE_IOERR_SHORT_READ;
    }
    
    return SQLITE_IOERR_READ;
}

static int gitvfs_Write(sqlite3_file *pFile, const void *zBuf, int iAmt, sqlite3_int64 iOfst) {
    gitvfs_file *p = (gitvfs_file*)pFile;
    
    // Route to monolithic file write for temp/journal files
    if (!p->is_main_db) {
        ssize_t n = pwrite(p->flat_fd, zBuf, iAmt, iOfst);
        return (n == iAmt) ? SQLITE_OK : SQLITE_IOERR_WRITE;
    }

    // Sharded DB write logic
    sqlite3_int64 page_number = iOfst / GITVFS_PAGE_SIZE;
    sqlite3_int64 local_offset = iOfst % GITVFS_PAGE_SIZE;
    
    char path[GITVFS_MAX_PATH];
    get_page_filepath(p->base_dir, page_number, path, sizeof(path));
    
    // Ensure parent directories exist
    char dir_path[GITVFS_MAX_PATH];
    snprintf(dir_path, sizeof(dir_path), "%s", path);
    char *last_slash = strrchr(dir_path, '/');
    if (last_slash) {
        *last_slash = '\0';
        if (mkdir_p(dir_path, 0755) != 0) {
            return SQLITE_IOERR_WRITE;
        }
    }
    
    // CRITICAL: Open with O_RDWR | O_CREAT to modify existing page data without truncating
    int fd = open(path, O_RDWR | O_CREAT, 0644);
    if (fd < 0) {
        return SQLITE_IOERR_WRITE;
    }
    
    // Write exact intra-page payload using pwrite
    ssize_t bytes_written = pwrite(fd, zBuf, iAmt, local_offset);
    close(fd);
    
    if (bytes_written != iAmt) {
        return SQLITE_IOERR_WRITE;
    }
    
    // State Persistence: Update max_page_number and size.meta if this is a new high page
    if (page_number > p->max_page_number) {
        p->max_page_number = page_number;
        
        char meta_path[GITVFS_MAX_PATH];
        snprintf(meta_path, sizeof(meta_path), "%s/pages/size.meta", p->base_dir);
        FILE *f = fopen(meta_path, "w");
        if (f) {
            fprintf(f, "%lld\n", (long long)p->max_page_number);
            fclose(f);
        }
    }
    
    return SQLITE_OK;
}

#ifdef _WIN32
#include <io.h>
#define ftruncate _chsize
#endif

static int gitvfs_Truncate(sqlite3_file *pFile, sqlite3_int64 size) {
    gitvfs_file *p = (gitvfs_file*)pFile;
    
    // Route to ftruncate for temp/journal files
    if (!p->is_main_db) {
        return (ftruncate(p->flat_fd, (long)size) == 0) ? SQLITE_OK : SQLITE_IOERR_TRUNCATE;
    }

    // Sharded DB truncate logic
    sqlite3_int64 new_max_page = (size == 0) ? -1 : (size - 1) / GITVFS_PAGE_SIZE;
    
    // Clean up abandoned page files
    for (sqlite3_int64 i = new_max_page + 1; i <= p->max_page_number; i++) {
        char path[GITVFS_MAX_PATH];
        get_page_filepath(p->base_dir, i, path, sizeof(path));
        unlink(path);
    }
    
    // Update max_page_number and size.meta
    if (new_max_page != p->max_page_number) {
        p->max_page_number = new_max_page;
        
        char meta_path[GITVFS_MAX_PATH];
        snprintf(meta_path, sizeof(meta_path), "%s/pages/size.meta", p->base_dir);
        
        if (new_max_page == -1) {
            remove(meta_path); // DB is completely empty
        } else {
            int fd = open(meta_path, O_WRONLY | O_CREAT | O_TRUNC, 0666);
            if (fd >= 0) {
                char buf[64];
                int len = snprintf(buf, sizeof(buf), "%lld\n", (long long)p->max_page_number);
                write(fd, buf, len);
#ifdef _WIN32
                _commit(fd);
#else
                fsync(fd);
#endif
                close(fd);
            }
        }
    }
    
    return SQLITE_OK;
}

static int gitvfs_Sync(sqlite3_file *pFile, int flags) {
    gitvfs_file *p = (gitvfs_file*)pFile;
    (void)flags;

    if (!p->is_main_db) {
#ifdef _WIN32
        _commit(p->flat_fd);
#else
        fsync(p->flat_fd);
#endif
        return SQLITE_OK;
    }

    // For sharded DB, ensure size.meta is flushed
    if (p->max_page_number != -1) {
        char meta_path[GITVFS_MAX_PATH];
        snprintf(meta_path, sizeof(meta_path), "%s/pages/size.meta", p->base_dir);
        
        // Use lower level open/write for size.meta to easily allow _commit on Windows
        int fd = open(meta_path, O_WRONLY | O_CREAT | O_TRUNC, 0666);
        if (fd >= 0) {
            char buf[64];
            int len = snprintf(buf, sizeof(buf), "%lld\n", (long long)p->max_page_number);
            write(fd, buf, len);
#ifdef _WIN32
            _commit(fd);
#else
            fsync(fd);
#endif
            close(fd);
        }
    }

    return SQLITE_OK;
}
static int gitvfs_FileSize(sqlite3_file *pFile, sqlite3_int64 *pSize) {
    gitvfs_file *p = (gitvfs_file*)pFile;
    
    if (!p->is_main_db) {
        struct stat st;
        if (fstat(p->flat_fd, &st) == 0) {
            *pSize = st.st_size;
            return SQLITE_OK;
        }
        return SQLITE_IOERR_FSTAT;
    }

    // O(1) state lookup for the sharded DB size
    *pSize = (p->max_page_number + 1) * GITVFS_PAGE_SIZE;
    return SQLITE_OK;
}

static int gitvfs_Lock(sqlite3_file *pFile, int eLock) {
    (void)pFile; (void)eLock;
    return SQLITE_OK; // SQLite requires lock functions to succeed
}

static int gitvfs_Unlock(sqlite3_file *pFile, int eLock) {
    (void)pFile; (void)eLock;
    return SQLITE_OK;
}

static int gitvfs_CheckReservedLock(sqlite3_file *pFile, int *pResOut) {
    (void)pFile;
    *pResOut = 0;
    return SQLITE_OK;
}

static int gitvfs_FileControl(sqlite3_file *pFile, int op, void *pArg) {
    (void)pFile; (void)op; (void)pArg;
    return SQLITE_NOTFOUND;
}

static int gitvfs_SectorSize(sqlite3_file *pFile) {
    (void)pFile;
    return GITVFS_PAGE_SIZE;
}

static int gitvfs_DeviceCharacteristics(sqlite3_file *pFile) {
    (void)pFile;
    return 0; // Standard characteristics
}

static const sqlite3_io_methods gitvfs_io_methods = {
    1,                              /* iVersion */
    gitvfs_Close,                   /* xClose */
    gitvfs_Read,                    /* xRead */
    gitvfs_Write,                   /* xWrite */
    gitvfs_Truncate,                /* xTruncate */
    gitvfs_Sync,                    /* xSync */
    gitvfs_FileSize,                /* xFileSize */
    gitvfs_Lock,                    /* xLock */
    gitvfs_Unlock,                  /* xUnlock */
    gitvfs_CheckReservedLock,       /* xCheckReservedLock */
    gitvfs_FileControl,             /* xFileControl */
    gitvfs_SectorSize,              /* xSectorSize */
    gitvfs_DeviceCharacteristics,   /* xDeviceCharacteristics */
    NULL,                           /* xShmMap */
    NULL,                           /* xShmLock */
    NULL,                           /* xShmBarrier */
    NULL,                           /* xShmUnmap */
    NULL,                           /* xFetch */
    NULL                            /* xUnfetch */
};

/* =====================================================================
 * VFS Registration Methods (sqlite3_vfs)
 * ===================================================================== */

static sqlite3_vfs *orig_vfs = NULL;

static int gitvfs_Open(sqlite3_vfs *pVfs, const char *zName, sqlite3_file *pFile, int flags, int *pOutFlags) {
    (void)pVfs;
    if (!orig_vfs) orig_vfs = sqlite3_vfs_find(NULL);
    const char *vfs_dir = getenv("GIT_SQLITE_VFS_DIR");
    if (!vfs_dir) {
        vfs_dir = ".db";
    }
    if (!zName || strstr(zName, vfs_dir) == NULL) {
        return orig_vfs->xOpen(orig_vfs, zName, pFile, flags, pOutFlags);
    }
    gitvfs_file *p = (gitvfs_file*)pFile;
    p->base.pMethods = &gitvfs_io_methods;
    p->max_page_number = -1;
    p->flat_fd = -1;
    
    // Identify if opening the main database or a temporary/journal file
    if (flags & SQLITE_OPEN_MAIN_DB) {
        p->is_main_db = 1;
        
        const char *base = (zName != NULL) ? zName : vfs_dir;
        
        // Strip URI parameters if they exist
        char clean_base[GITVFS_MAX_PATH];
        snprintf(clean_base, sizeof(clean_base), "%s", base);
        char *qmark = strchr(clean_base, '?');
        if (qmark) {
            *qmark = '\0';
        }
        
        // Also strip "file:" prefix if Python passes it raw
        const char *actual_base = clean_base;
        if (strncmp(actual_base, "file:", 5) == 0) {
            actual_base += 5;
        }

        snprintf(p->base_dir, sizeof(p->base_dir), "%s", actual_base);
        
        // Initialize standard repository constraints
        generate_gitattributes(p->base_dir);
        generate_gitignore(p->base_dir);
        
        // State Persistence: Load max_page_number from size.meta
        char meta_path[GITVFS_MAX_PATH];
        snprintf(meta_path, sizeof(meta_path), "%s/pages/size.meta", p->base_dir);
        FILE *f = fopen(meta_path, "r");
        if (f) {
            long long max_page;
            if (fscanf(f, "%lld", &max_page) == 1) {
                p->max_page_number = (sqlite3_int64)max_page;
            }
            fclose(f);
        }
    } else {
        // Handle temp/journal file natively as a monolithic file
        p->is_main_db = 0;
        
        int openFlags = 0;
        if (flags & SQLITE_OPEN_READONLY)  openFlags |= O_RDONLY;
        if (flags & SQLITE_OPEN_READWRITE) openFlags |= O_RDWR;
        if (flags & SQLITE_OPEN_CREATE)    openFlags |= O_CREAT;
        
        // Anonymous temp file handling
        if (zName == NULL) {
            char temp_name[GITVFS_MAX_PATH];
            snprintf(temp_name, sizeof(temp_name), "/tmp/gitvfs_temp_%d_%p", getpid(), p);
            p->flat_fd = open(temp_name, O_RDWR | O_CREAT | O_EXCL, 0644);
            if (p->flat_fd >= 0) unlink(temp_name); // Clean up immediately on close
        } else {
            p->flat_fd = open(zName, openFlags, 0644);
        }
        
        if (p->flat_fd < 0) {
            return SQLITE_CANTOPEN;
        }
    }
    
    if (pOutFlags) {
        *pOutFlags = flags;
    }
    
    return SQLITE_OK;
}

static int gitvfs_Delete(sqlite3_vfs *pVfs, const char *zName, int syncDir) {
    (void)pVfs; (void)syncDir;
    // Standard file deletion, primarily used for clearing out old journals
    unlink(zName);
    return SQLITE_OK;
}

static int gitvfs_Access(sqlite3_vfs *pVfs, const char *zName, int flags, int *pResOut) {
    (void)pVfs; (void)flags;
    // Check if the directory or file is accessible
    *pResOut = (access(zName, F_OK) == 0) ? 1 : 0;
    return SQLITE_OK;
}

static int gitvfs_FullPathname(sqlite3_vfs *pVfs, const char *zName, int nOut, char *zOut) {
    (void)pVfs;
    snprintf(zOut, nOut, "%s", zName);
    return SQLITE_OK;
}

/* System calls to load extensions (stubbed) */
static void *gitvfs_DlOpen(sqlite3_vfs *pVfs, const char *zFilename) { (void)pVfs; return orig_vfs->xDlOpen(orig_vfs, zFilename); }
static void gitvfs_DlError(sqlite3_vfs *pVfs, int nByte, char *zErrMsg) { (void)pVfs; orig_vfs->xDlError(orig_vfs, nByte, zErrMsg); }
static void (*gitvfs_DlSym(sqlite3_vfs *pVfs, void *p, const char*zSymbol))(void) { (void)pVfs; return orig_vfs->xDlSym(orig_vfs, p, zSymbol); }
static void gitvfs_DlClose(sqlite3_vfs *pVfs, void *pHandle) { (void)pVfs; orig_vfs->xDlClose(orig_vfs, pHandle); }
static int gitvfs_Randomness(sqlite3_vfs *pVfs, int nByte, char *zOut) { (void)pVfs; return orig_vfs->xRandomness(orig_vfs, nByte, zOut); }
static int gitvfs_Sleep(sqlite3_vfs *pVfs, int microseconds) { (void)pVfs; return orig_vfs->xSleep(orig_vfs, microseconds); }
static int gitvfs_CurrentTime(sqlite3_vfs *pVfs, double *prNow) { (void)pVfs; return orig_vfs->xCurrentTime(orig_vfs, prNow); }

static int gitvfs_GetLastError(sqlite3_vfs *pVfs, int a, char *b) { (void)pVfs; return orig_vfs->xGetLastError ? orig_vfs->xGetLastError(orig_vfs, a, b) : 0; }
static int gitvfs_CurrentTimeInt64(sqlite3_vfs *pVfs, sqlite3_int64 *p) { (void)pVfs; return orig_vfs->xCurrentTimeInt64 ? orig_vfs->xCurrentTimeInt64(orig_vfs, p) : 0; }
static int gitvfs_SetSystemCall(sqlite3_vfs *pVfs, const char *zName, sqlite3_syscall_ptr pNew) { (void)pVfs; return orig_vfs->xSetSystemCall ? orig_vfs->xSetSystemCall(orig_vfs, zName, pNew) : SQLITE_ERROR; }
static sqlite3_syscall_ptr gitvfs_GetSystemCall(sqlite3_vfs *pVfs, const char *zName) { (void)pVfs; return orig_vfs->xGetSystemCall ? orig_vfs->xGetSystemCall(orig_vfs, zName) : NULL; }
static const char *gitvfs_NextSystemCall(sqlite3_vfs *pVfs, const char *zName) { (void)pVfs; return orig_vfs->xNextSystemCall ? orig_vfs->xNextSystemCall(orig_vfs, zName) : NULL; }

/*
 * Entry point to register our Git VFS.
 */
int sqlite3_gitvfs_init_impl(const char *base_dir) {
    (void)base_dir;
    if (sqlite3_vfs_find("gitvfs") != NULL) {
        return SQLITE_OK;
    }
    
    if (!orig_vfs) orig_vfs = sqlite3_vfs_find(NULL);

    static sqlite3_vfs git_vfs = {
        3,                                /* iVersion */
        0,                                /* szOsFile */
        GITVFS_MAX_PATH,                  /* mxPathname */
        NULL,                             /* pNext */
        "gitvfs",                         /* zName */
        NULL,                             /* pAppData */
        gitvfs_Open,                      /* xOpen */
        gitvfs_Delete,                    /* xDelete */
        gitvfs_Access,                    /* xAccess */
        gitvfs_FullPathname,              /* xFullPathname */
        gitvfs_DlOpen,                    /* xDlOpen */
        gitvfs_DlError,                   /* xDlError */
        gitvfs_DlSym,                     /* xDlSym */
        gitvfs_DlClose,                   /* xDlClose */
        gitvfs_Randomness,                /* xRandomness */
        gitvfs_Sleep,                     /* xSleep */
        gitvfs_CurrentTime,               /* xCurrentTime */
        gitvfs_GetLastError,              /* xGetLastError */
        gitvfs_CurrentTimeInt64,          /* xCurrentTimeInt64 */
        gitvfs_SetSystemCall,             /* xSetSystemCall */
        gitvfs_GetSystemCall,             /* xGetSystemCall */
        gitvfs_NextSystemCall             /* xNextSystemCall */
    };

    git_vfs.szOsFile = sizeof(gitvfs_file) > (size_t)orig_vfs->szOsFile ? (int)sizeof(gitvfs_file) : orig_vfs->szOsFile;
    return sqlite3_vfs_register(&git_vfs, 1);
}

#ifdef COMPILE_SQLITE_EXTENSION
#ifdef _WIN32
__declspec(dllexport)
#endif
int sqlite3_extension_init(sqlite3 *db, char **pzErrMsg, const sqlite3_api_routines *pApi) {
    (void)db; (void)pzErrMsg;
    SQLITE_EXTENSION_INIT2(pApi);
    int rc = sqlite3_gitvfs_init_impl(".db");
    return (rc == SQLITE_OK) ? SQLITE_OK_LOAD_PERMANENTLY : rc;
}

#ifdef _WIN32
__declspec(dllexport)
#endif
int sqlite3_gitvfs_init(sqlite3 *db, char **pzErrMsg, const sqlite3_api_routines *pApi) {
    return sqlite3_extension_init(db, pzErrMsg, pApi);
}
#endif





