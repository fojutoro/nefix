VERSION := $(shell git describe --tags --always --dirty)
COMMIT  := $(shell git rev-parse --short HEAD)
LDFLAGS := -X main.version=$(VERSION) -X main.commit=$(COMMIT)

STATICCHECK_VERSION := v0.7.0
GOBIN := $(shell go env GOPATH)/bin
STATICCHECK := $(shell command -v staticcheck 2>/dev/null || echo $(GOBIN)/staticcheck)

.PHONY: help dev test build lint clean

help:
	@echo "Targets:"
	@echo "  dev    run the server on 127.0.0.1:8080"
	@echo "  test   run the server tests"
	@echo "  build  static binary into bin/nefix"
	@echo "  lint   gofmt, go vet, staticcheck"
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

clean:
	rm -rf bin
