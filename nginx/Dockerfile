FROM nginx:alpine

RUN apk add --no-cache openssl

COPY nginx.conf.template /etc/nginx/conf.d/nginx.conf.template
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
