.DEFAULT_GOAL := all
.PHONY: all deps check test build clean

# The golden path: from a fresh clone to a verified build, in one word.
all: deps check test build
	@echo "✓ 공항: typecheck, tests and build all green"

deps:
	@bun install

check:
	@bun run typecheck

test:
	@bun test

build:
	@bun run build

clean:
	@rm -rf dist
