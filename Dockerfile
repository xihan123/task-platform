FROM docker.xihan.website/golang:1.27-alpine AS build
WORKDIR /src

# 设置 Go 的自定义镜像源
ENV GOPROXY=https://mirrors.xihan.website/repository/go/
ENV GOSUMDB=sum.golang.org

# 依赖层缓存
COPY apps/api/go.mod apps/api/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download

RUN go mod download
COPY apps/api/cmd ./cmd
COPY apps/api/internal ./internal
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" \
    -o /api ./cmd/server

FROM scratch AS api
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /api /api
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=4000 ATTACHMENT_STORAGE_DIR=/var/lib/task-platform/attachments
EXPOSE 4000
ENTRYPOINT ["/api"]
CMD ["serve"]
