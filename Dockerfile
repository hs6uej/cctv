FROM nginx:1.27-alpine
# Templates are rendered by the image entrypoint (envsubst) into /etc/nginx/conf.d/
COPY templates/ /etc/nginx/templates/
COPY --chmod=755 cctv/ /usr/share/nginx/html/
RUN find /usr/share/nginx/html /etc/nginx/templates -type f -exec chmod 644 {} + \
 && rm -f /etc/nginx/conf.d/default.conf
EXPOSE 5455
