.DEFAULT_GOAL := all
.PHONY: all deps check test build smoke clean

# The golden path: from a fresh clone to a verified build, in one word.
all: deps check test build smoke
	@echo "✓ 공항: typecheck, tests, build and smoke test all green"

# In CI the lockfile is the law: a dependency that has drifted from it fails the build.
deps:
	@bun install $(if $(CI),--frozen-lockfile)

check:
	@bun run typecheck

test:
	@bun test

build:
	@bun run build

# The built file, run for real on every runtime that is installed here.
smoke: build
	@bun test/smoke.mjs
	@if command -v node >/dev/null; then node test/smoke.mjs; fi
	@if command -v deno >/dev/null; then deno run -A --no-lock test/smoke.mjs; fi

clean:
	@rm -rf dist
