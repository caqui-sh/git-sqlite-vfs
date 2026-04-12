CC = gcc
CFLAGS = -Wall -Wextra -g -O2 -std=c99 -D_POSIX_C_SOURCE=200809L -I.
LDFLAGS = 

UNAME_S := $(shell uname -s)
ifeq ($(UNAME_S),Darwin)
	SHARED_LDFLAGS = -undefined dynamic_lookup
	EXT = dylib
else ifeq ($(OS),Windows_NT)
	SHARED_LDFLAGS = 
	EXT = dll
else
	SHARED_LDFLAGS = 
	EXT = so
endif

SRC_DIR = .
OUT_DIR = output

all: $(OUT_DIR)/gitvfs_test $(OUT_DIR)/git-merge-sqlitevfs $(OUT_DIR)/gitvfs.$(EXT)

$(SRC_DIR)/sqlite3.c:
	curl -O https://www.sqlite.org/2024/sqlite-autoconf-3450200.tar.gz
	tar -xzf sqlite-autoconf-3450200.tar.gz
	mv sqlite-autoconf-3450200/sqlite3.c $(SRC_DIR)/
	mv sqlite-autoconf-3450200/sqlite3.h $(SRC_DIR)/
	mv sqlite-autoconf-3450200/sqlite3ext.h $(SRC_DIR)/
	rm -rf sqlite-autoconf-3450200 sqlite-autoconf-3450200.tar.gz

$(OUT_DIR)/sqlite3.o: $(SRC_DIR)/sqlite3.c | $(OUT_DIR)
	$(CC) -g -O2 -c $(SRC_DIR)/sqlite3.c -o $(OUT_DIR)/sqlite3.o

$(OUT_DIR)/gitvfs.$(EXT): $(SRC_DIR)/gitvfs.c $(SRC_DIR)/gitvfs.h | $(OUT_DIR)
	$(CC) $(CFLAGS) -fPIC -shared -DCOMPILE_SQLITE_EXTENSION $(SRC_DIR)/gitvfs.c -o $(OUT_DIR)/gitvfs.$(EXT) $(SHARED_LDFLAGS)

$(OUT_DIR)/gitvfs.o: $(SRC_DIR)/gitvfs.c $(SRC_DIR)/gitvfs.h | $(OUT_DIR)
	$(CC) $(CFLAGS) -c $(SRC_DIR)/gitvfs.c -o $(OUT_DIR)/gitvfs.o

$(OUT_DIR)/main.o: $(SRC_DIR)/main.c $(SRC_DIR)/gitvfs.h | $(OUT_DIR)
	$(CC) $(CFLAGS) -c $(SRC_DIR)/main.c -o $(OUT_DIR)/main.o

$(OUT_DIR)/gitvfs_test: $(OUT_DIR)/main.o $(OUT_DIR)/gitvfs.o $(OUT_DIR)/sqlite3.o | $(OUT_DIR)
	$(CC) $(CFLAGS) $(OUT_DIR)/main.o $(OUT_DIR)/gitvfs.o $(OUT_DIR)/sqlite3.o -o $(OUT_DIR)/gitvfs_test $(LDFLAGS)

$(OUT_DIR)/git-merge-sqlitevfs: $(SRC_DIR)/git-merge-sqlitevfs.c $(OUT_DIR)/gitvfs.o $(OUT_DIR)/sqlite3.o | $(OUT_DIR)
	$(CC) $(CFLAGS) $(SRC_DIR)/git-merge-sqlitevfs.c $(OUT_DIR)/gitvfs.o $(OUT_DIR)/sqlite3.o -o $(OUT_DIR)/git-merge-sqlitevfs $(LDFLAGS)

$(OUT_DIR):
	mkdir -p $(OUT_DIR)

clean:
	rm -rf $(OUT_DIR)
	rm -rf .db .git
	rm -f $(SRC_DIR)/sqlite3.c $(SRC_DIR)/sqlite3.h $(SRC_DIR)/sqlite3ext.h
