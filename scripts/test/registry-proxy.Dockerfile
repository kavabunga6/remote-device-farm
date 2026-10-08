# syntax=docker/dockerfile:1.4
ARG NGINX_IMAGE=nginx:stable-alpine
FROM ${NGINX_IMAGE}
RUN apk add --no-cache python3 openssl
WORKDIR /test
COPY registry-proxy.py ./registry-proxy.py
COPY --from=web_config nginx.conf ./nginx.conf
RUN chmod 0444 /test/registry-proxy.py /test/nginx.conf
USER 10001:10001
ENTRYPOINT ["python3", "-B", "/test/registry-proxy.py"]
