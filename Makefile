VERSION := $(shell git describe --tags --always --dirty)
COMMIT  := $(shell git rev-parse --short HEAD)
LDFLAGS := -X main.version=$(VERSION) -X main.commit=$(COMMIT)

STATICCHECK_VERSION := v0.7.0
GORELEASER_VERSION := v2.17.1
GOBIN := $(shell go env GOPATH)/bin
STATICCHECK := $(shell command -v staticcheck 2>/dev/null || echo $(GOBIN)/staticcheck)
GORELEASER := $(shell command -v goreleaser 2>/dev/null || echo $(GOBIN)/goreleaser)

.PHONY: help dev test build lint release-check clean

help:
	@echo "Targets:"
	@echo "  dev    run the server on 127.0.0.1:8080"
	@echo "  test   run the server tests"
	@echo "  build  static binary into bin/nefix"
	@echo "  lint   gofmt, go vet, staticcheck"
	@echo "  release-check  validate .goreleaser.yml and build a snapshot"
	@echo "  clean  remove bin/"

dev:
	go -C server run -ldflags "$(LDFLAGS)" ./cmd/nefix

test:
	go -C server test ./...

# CGO_ENABLED=0 because the deployed binary must be static.
build:
	@mkdir -p bin
	CGO_ENABLED=0 go -C server build -ldflags "$(LDFLAGS)" -o ../bin/nefix ./cmd/nefix

# gofmt -l exits 0 even when it lists files, so the output is the verdict.
lint:
	@unformatted=$$(gofmt -l server); \
	if [ -n "$$unformatted" ]; then \
		echo "not gofmt-clean:"; \
		echo "$$unformatted"; \
		exit 1; \
	fi
	go -C server vet ./...
	@$(STATICCHECK) --version 2>/dev/null | grep -q "$(STATICCHECK_VERSION)" || \
		go install honnef.co/go/tools/cmd/staticcheck@$(STATICCHECK_VERSION)
	cd server && $(STATICCHECK) ./...

release-check:
	@$(GORELEASER) --version 2>/dev/null | grep -q "$(GORELEASER_VERSION)" || \
		go install github.com/goreleaser/goreleaser/v2@$(GORELEASER_VERSION)
	$(GORELEASER) check
	# --single-target filters to the host target, which is not in the build
	# matrix, so without GOOS/GOARCH it builds nothing and still exits 0.
	GOOS=linux GOARCH=amd64 $(GORELEASER) build --snapshot --clean --single-target

clean:
	rm -rf bin
