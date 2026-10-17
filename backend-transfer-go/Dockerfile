# Build stage
# --platform=BUILDPLATFORM + TARGETOS/TARGETARCH cross-compile: multi-arch
# builds (linux/amd64,linux/arm64) run the compiler on the native amd64
# runner instead of emulating Go under QEMU (much faster, CGO off anyway).
FROM --platform=$BUILDPLATFORM golang:1.25-alpine AS builder

ARG TARGETOS TARGETARCH
WORKDIR /app

# Copy go module files
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build the Go application
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -ldflags="-w -s" -o server ./cmd/server

# Run stage
FROM alpine:3.19

RUN apk --no-cache add ca-certificates tzdata wget

WORKDIR /app

# Copy the binary from builder
COPY --from=builder /app/server .

# Expose port
EXPOSE 3001

# Run the server
CMD ["./server"]
