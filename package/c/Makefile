CC ?= gcc
CFLAGS = -Wall -Wextra -g -O2 -std=c99 -D_POSIX_C_SOURCE=200809L -I.
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

SRC_DIR = .
OUT_DIR = output

all: $(OUT_DIR)/gitvfs_test$(EXE) $(OUT_DIR)/git-merge-sqlitevfs$(EXE) $(OUT_DIR)/gitvfs.$(EXT)

$(SRC_DIR)/sqlite3.c:
	node download-sqlite.cjs

$(SRC_DIR)/sqlite3.h: $(SRC_DIR)/sqlite3.c
$(SRC_DIR)/sqlite3ext.h: $(SRC_DIR)/sqlite3.c

$(OUT_DIR)/sqlite3.o: $(SRC_DIR)/sqlite3.c $(SRC_DIR)/sqlite3.h | $(OUT_DIR)
	$(CC) -g -O2 -c $(SRC_DIR)/sqlite3.c -o $(OUT_DIR)/sqlite3.o

$(OUT_DIR)/gitvfs.$(EXT): $(SRC_DIR)/gitvfs.c $(SRC_DIR)/gitvfs.h $(SRC_DIR)/sqlite3.h $(SRC_DIR)/sqlite3ext.h | $(OUT_DIR)
	$(CC) $(CFLAGS) -fPIC -shared -DCOMPILE_SQLITE_EXTENSION $(SRC_DIR)/gitvfs.c -o $(OUT_DIR)/gitvfs.$(EXT) $(SHARED_LDFLAGS)

$(OUT_DIR)/gitvfs.o: $(SRC_DIR)/gitvfs.c $(SRC_DIR)/gitvfs.h $(SRC_DIR)/sqlite3.h $(SRC_DIR)/sqlite3ext.h | $(OUT_DIR)
	$(CC) $(CFLAGS) -c $(SRC_DIR)/gitvfs.c -o $(OUT_DIR)/gitvfs.o

$(OUT_DIR)/main.o: $(SRC_DIR)/main.c $(SRC_DIR)/gitvfs.h $(SRC_DIR)/sqlite3.h | $(OUT_DIR)
	$(CC) $(CFLAGS) -c $(SRC_DIR)/main.c -o $(OUT_DIR)/main.o

$(OUT_DIR)/gitvfs_test$(EXE): $(OUT_DIR)/main.o $(OUT_DIR)/gitvfs.o $(OUT_DIR)/sqlite3.o | $(OUT_DIR)
	$(CC) $(CFLAGS) $(OUT_DIR)/main.o $(OUT_DIR)/gitvfs.o $(OUT_DIR)/sqlite3.o -o $(OUT_DIR)/gitvfs_test$(EXE) $(LDFLAGS)

$(OUT_DIR)/git-merge-sqlitevfs$(EXE): $(SRC_DIR)/git-merge-sqlitevfs.c $(OUT_DIR)/gitvfs.o $(OUT_DIR)/sqlite3.o $(SRC_DIR)/sqlite3.h | $(OUT_DIR)
	$(CC) $(CFLAGS) $(SRC_DIR)/git-merge-sqlitevfs.c $(OUT_DIR)/gitvfs.o $(OUT_DIR)/sqlite3.o -o $(OUT_DIR)/git-merge-sqlitevfs$(EXE) $(LDFLAGS)

$(OUT_DIR):
	node -e "const fs=require('fs'); if (!fs.existsSync('$(OUT_DIR)')) fs.mkdirSync('$(OUT_DIR)');"

clean:
	node -e "const fs=require('fs'); fs.rmSync('$(OUT_DIR)', {recursive: true, force: true}); fs.rmSync('.db', {recursive: true, force: true}); fs.rmSync('.git', {recursive: true, force: true}); fs.rmSync('sqlite3.c', {force: true}); fs.rmSync('sqlite3.h', {force: true}); fs.rmSync('sqlite3ext.h', {force: true});"
