PNPM ?= pnpm
CARGO ?= cargo
TAURI ?= $(PNPM) tauri

.PHONY: build run install clean

build:
	$(PNPM) build
	cd src-tauri && $(CARGO) build

run:
	$(TAURI) dev

install:
	$(TAURI) build
	open src-tauri/target/release/bundle/macos/*.app

clean:
	rm -rf dist
	cd src-tauri && $(CARGO) clean
