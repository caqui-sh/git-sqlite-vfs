CC ?= gcc
CFLAGS = -Wall -Wextra -g -O2 -std=c99 -D_POSIX_C_SOURCE=200809L -DSQLITE_ENABLE_SESSION -DSQLITE_ENABLE_PREUPDATE_HOOK -Igit-vfs -I.
LDFLAGS = 

UNAME_S := $(shell uname -s)
ifeq ($(UNAME_S),Darwin)
        SHARED_LDFLAGS = -undefined dynamic_lookup
        EXT = dylib
        EXE = 
else ifeq ($(OS),Windows_NT)
        SHARED_LDFLAGS = 
        EXT = dll
        EXE = .exe
else
        SHARED_LDFLAGS = 
        EXT = so
        EXE = 
endif

OUT_DIR = output

all: $(OUT_DIR)/git-merge-sqlitevfs$(EXE) $(OUT_DIR)/gitvfs.$(EXT)

sqlite3.c:
	node scripts/download-sqlite.cjs

sqlite3.h: sqlite3.c
sqlite3ext.h: sqlite3.c

$(OUT_DIR)/sqlite3.o: sqlite3.c sqlite3.h | $(OUT_DIR)
	$(CC) -g -O2 -DSQLITE_ENABLE_SESSION -DSQLITE_ENABLE_PREUPDATE_HOOK -c sqlite3.c -o $(OUT_DIR)/sqlite3.o

$(OUT_DIR)/gitvfs.$(EXT): git-vfs/gitvfs.c git-vfs/gitvfs.h sqlite3.h sqlite3ext.h | $(OUT_DIR)
	$(CC) $(CFLAGS) -fPIC -shared -DCOMPILE_SQLITE_EXTENSION git-vfs/gitvfs.c -o $(OUT_DIR)/gitvfs.$(EXT) $(SHARED_LDFLAGS)

$(OUT_DIR)/gitvfs.o: git-vfs/gitvfs.c git-vfs/gitvfs.h sqlite3.h sqlite3ext.h | $(OUT_DIR)
	$(CC) $(CFLAGS) -c git-vfs/gitvfs.c -o $(OUT_DIR)/gitvfs.o

$(OUT_DIR)/git-merge-sqlitevfs$(EXE): git-merge-hook/git-merge-sqlitevfs.c $(OUT_DIR)/gitvfs.o $(OUT_DIR)/sqlite3.o sqlite3.h | $(OUT_DIR)
	$(CC) $(CFLAGS) git-merge-hook/git-merge-sqlitevfs.c $(OUT_DIR)/gitvfs.o $(OUT_DIR)/sqlite3.o -o $(OUT_DIR)/git-merge-sqlitevfs$(EXE) $(LDFLAGS)

$(OUT_DIR):
	node -e "const fs=require('fs'); if (!fs.existsSync('$(OUT_DIR)')) fs.mkdirSync('$(OUT_DIR)');"

clean:
	node -e "const fs=require('fs'); fs.rmSync('$(OUT_DIR)', {recursive: true, force: true}); fs.rmSync('.db', {recursive: true, force: true}); fs.rmSync('sqlite3.c', {force: true}); fs.rmSync('sqlite3.h', {force: true}); fs.rmSync('sqlite3ext.h', {force: true});"
