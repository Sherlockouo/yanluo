PNPM ?= pnpm
CARGO ?= cargo
TAURI ?= $(PNPM) tauri
UNAME_S := $(shell uname -s 2>/dev/null || echo unknown)

.PHONY: build run install install-local clean typecheck check

build:
	$(PNPM) build
	cd src-tauri && $(CARGO) build

run:
	$(TAURI) dev

## Local install with Qwen (macOS Apple Silicon).
install-local:
	$(TAURI) build --features qwen-local
ifeq ($(UNAME_S),Darwin)
	node scripts/stage-mlx-metallib.mjs --bundle
	node scripts/embed-gatekeeper-fix.mjs
	@APP=$$(ls -d src-tauri/target/release/bundle/macos/*.app 2>/dev/null | head -1); \
	  if [ -n "$$APP" ]; then \
	    node scripts/stage-mlx-metallib.mjs --app "$$APP"; \
	    codesign --force --deep --sign - "$$APP" 2>/dev/null || true; \
	    open "$$APP"; \
	  fi
endif

## Cross-platform package (default features; no MLX).
## Outputs under src-tauri/target/release/bundle/{macos,deb,appimage,msi,nsis}/
install:
	$(TAURI) build
ifeq ($(UNAME_S),Darwin)
	@ls -la src-tauri/target/release/bundle/macos 2>/dev/null || true
	@ls -la src-tauri/target/release/bundle/dmg 2>/dev/null || true
	open src-tauri/target/release/bundle/macos/*.app 2>/dev/null || true
else ifeq ($(UNAME_S),Linux)
	@ls -la src-tauri/target/release/bundle/deb 2>/dev/null || true
	@ls -la src-tauri/target/release/bundle/appimage 2>/dev/null || true
else
	@ls -la src-tauri/target/release/bundle/msi 2>/dev/null || true
	@ls -la src-tauri/target/release/bundle/nsis 2>/dev/null || true
endif

typecheck:
	$(PNPM) exec tsc --noEmit

check:
	cd src-tauri && $(CARGO) check
	cd src-tauri && $(CARGO) check --features qwen-local

clean:
	rm -rf dist
	cd src-tauri && $(CARGO) clean
