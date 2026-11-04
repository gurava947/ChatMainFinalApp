# syntax=docker/dockerfile:1

# Dev-grade self-signed certificate so HTTPS works out of the box. Swap this
# stage for certbot/Let's Encrypt volumes before going live.
FROM alpine:3.20 AS certs
RUN apk add --no-cache openssl
WORKDIR /certs
RUN openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
      -keyout privkey.pem -out fullchain.pem \
      -subj "/CN=localhost" \
      -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

FROM nginx:1.27-alpine

RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/nginx.conf
COPY conf.d/ /etc/nginx/conf.d/
COPY --from=certs /certs /etc/nginx/certs

# nginx -t catches configuration mistakes at build time, not at 3am.
RUN nginx -t

EXPOSE 80 443

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O - http://127.0.0.1/nginx-health || exit 1

CMD ["nginx", "-g", "daemon off;"]
